"""Optional six-process simulation. The gateway owns identity/events, zones own motion.

Redis is used only for leases and transfer decisions. Movement travels over local
IPC. This is a one-host distributed prototype, not a multi-region deployment.
"""
import asyncio
import json
import multiprocessing as mp
import os
import secrets
import threading
import time
from dataclasses import dataclass

from redis import Redis as SyncRedis
from redis.asyncio import Redis

from .map import DISTRICTS, move, zone_at

TRANSFER = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return -1 end
local current = redis.call('get', KEYS[2])
if current == ARGV[3] then return 1 end
if current ~= ARGV[2] then return 0 end
redis.call('set', KEYS[2], ARGV[3], 'EX', 180)
return 1
"""
ZONE_RENEW = """
if redis.call('get', KEYS[1]) ~= ARGV[1] or redis.call('get', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('pexpire', KEYS[2], 10000)
return 1
"""


def _worker(connection, zone, url, prefix, parent_token, generation):
    redis = SyncRedis.from_url(url, decode_responses=True, socket_timeout=2, socket_connect_timeout=2)
    lease = f"{prefix}:zone:{zone}"
    token = f"{generation}:{secrets.token_hex(12)}"
    active, staged, committed, frozen = {}, {}, {}, set()
    try:
        if not redis.set(lease, token, nx=True, px=10000):
            connection.send({"error": "Zone already has an owner."})
            return
        connection.send({"ready": True, "pid": os.getpid(), "token": token, "generation": generation})
        renewed = time.monotonic()
        while True:
            if time.monotonic() - renewed > 2:
                if not redis.eval(ZONE_RENEW, 2, f"{prefix}:coordinator", lease, parent_token, token):
                    return
                renewed = time.monotonic()
            if not connection.poll(.1):
                continue
            request = connection.recv()
            kind, data, result = request["kind"], request.get("data", {}), {}
            if kind == "close":
                connection.send({"request": request["request"], "generation": generation, "closed": True})
                break
            if kind == "register":
                active[data["id"]] = dict(data)
                frozen.discard(data["id"])
            elif kind == "drop":
                active.pop(data["id"], None)
                frozen.discard(data["id"])
                committed.pop(data["id"], None)
            elif kind == "prepare":
                staged[data["transfer"]] = dict(data["record"])
                result = {"prepared": True}
            elif kind == "commit":
                record = staged.pop(data["transfer"], None)
                if record:
                    active[record["id"]] = record
                    committed[record["id"]] = data["transfer"]
                result = {"committed": committed.get(data["id"]) == data["transfer"]}
            elif kind == "resume":
                frozen.discard(data["id"])
            elif kind == "step":
                rows = []
                for incoming in data["inputs"]:
                    player_id = incoming["id"]
                    record = active.get(player_id)
                    if not record or player_id in frozen:
                        continue
                    if incoming["revision"] != record["revision"]:
                        record["x"], record["z"], record["revision"] = incoming["x"], incoming["z"], incoming["revision"]
                    dx, dz = incoming["dx"], incoming["dz"]
                    record["x"], record["z"] = move(record["x"], record["z"], dx, dz, data["dt"], set(incoming["grants"]))
                    record.update(yaw=incoming["yaw"], ack=incoming["seq"])
                    target = zone_at(record["x"], record["z"])
                    if target != zone:
                        frozen.add(player_id)
                    rows.append({**record, "targetZone": target})
                result = {"players": rows, "active": len(active), "frozen": len(frozen)}
            elif kind == "inspect":
                result = {"active": list(active), "frozen": list(frozen), "staged": len(staged), "pid": os.getpid()}
            connection.send({"request": request["request"], "generation": generation, **result})
    except (EOFError, BrokenPipeError, OSError):
        pass
    finally:
        try:
            redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0", 1, lease, token)
        except Exception:
            pass
        redis.close()
        connection.close()


@dataclass
class Worker:
    process: object
    connection: object
    generation: int
    token: str
    pid: int
    lock: threading.Lock


@dataclass
class Handoff:
    guest_id: int
    source: str
    target: str
    source_generation: int
    target_generation: int
    transfer: str
    record: dict


class ZonePool:
    def __init__(self, redis_url: str, prefix: str, coordinator_epoch: int, coordinator_token: str = ""):
        self.url, self.prefix, self.epoch = redis_url, prefix, coordinator_epoch
        self.coordinator_token = coordinator_token
        self.redis = Redis.from_url(redis_url, decode_responses=True, socket_timeout=2)
        self.workers: dict[str, Worker] = {}
        self.routes: dict[int, tuple[str, int]] = {}
        self.pending: dict[int, Handoff] = {}
        self.last_presence_refresh = time.monotonic()
        self.handoffs = 0

    def presence_key(self, guest_id):
        return f"{self.prefix}:presence:{self.epoch}:{guest_id}"

    async def start(self):
        if not self.coordinator_token:
            self.coordinator_token = await self.redis.get(f"{self.prefix}:coordinator") or ""
        context = mp.get_context("spawn")
        try:
            for zone in ["plaza", *DISTRICTS]:
                generation = await self.redis.incr(f"{self.prefix}:zone-epoch:{zone}")
                parent, child = context.Pipe()
                process = context.Process(target=_worker, args=(child, zone, self.url, self.prefix, self.coordinator_token, generation), daemon=True)
                process.start()
                child.close()
                def ready():
                    if not parent.poll(8):
                        raise RuntimeError("Zone worker did not start.")
                    return parent.recv()
                response = await asyncio.to_thread(ready)
                if not response.get("ready"):
                    raise RuntimeError(response.get("error", "Zone worker unavailable."))
                self.workers[zone] = Worker(process, parent, generation, response["token"], response["pid"], threading.Lock())
                await self.redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],10000) end return 0", 1, f"{self.prefix}:coordinator", self.coordinator_token)
        except Exception:
            await self.close()
            raise

    async def rpc(self, zone, kind, data=None):
        worker = self.workers[zone]
        request_id = secrets.token_hex(8)
        def call():
            with worker.lock:
                worker.connection.send({"request": request_id, "kind": kind, "data": data or {}})
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if worker.connection.poll(.1):
                        response = worker.connection.recv()
                        if response.get("request") == request_id:
                            if response.get("generation") != worker.generation:
                                raise RuntimeError("Stale zone owner response rejected.")
                            return response
                raise TimeoutError("Zone response timed out. Movement is paused rather than duplicated.")
        return await asyncio.to_thread(call)

    @staticmethod
    def record(guest):
        return {"id": guest.id, "x": guest.x, "z": guest.z, "revision": guest.revision,
                "yaw": guest.yaw, "ack": guest.ack_seq}

    async def register(self, guest):
        zone = zone_at(guest.x, guest.z)
        generation = self.workers[zone].generation
        key = self.presence_key(guest.id)
        # A session is registered once; only a fenced handoff changes its owner.
        await self.redis.set(key, f"{zone}:{generation}", nx=True, ex=180)
        if await self.redis.get(key) != f"{zone}:{generation}":
            raise RuntimeError("Duplicate guest presence rejected.")
        await self.rpc(zone, "register", self.record(guest))
        self.routes[guest.id] = zone, generation

    async def transfer(self, handoff: Handoff, interrupt_after_commit: bool = False):
        """Prepare destination, atomically change owner, activate, then discard source."""
        guest_id = handoff.guest_id
        source_value = f"{handoff.source}:{handoff.source_generation}"
        target_value = f"{handoff.target}:{handoff.target_generation}"
        await self.rpc(handoff.target, "prepare", {"transfer": handoff.transfer, "record": handoff.record})
        result = await self.redis.eval(TRANSFER, 2, f"{self.prefix}:coordinator", self.presence_key(guest_id),
                                       self.coordinator_token, source_value, target_value)
        if result != 1:
            raise RuntimeError("Zone handoff lost its coordinator or presence fence.")
        self.routes[guest_id] = handoff.target, handoff.target_generation
        if interrupt_after_commit:
            raise ConnectionError("Injected interruption after atomic ownership commit.")
        response = await self.rpc(handoff.target, "commit", {"id": guest_id, "transfer": handoff.transfer})
        if not response.get("committed"):
            raise RuntimeError("Destination did not acknowledge the transfer.")
        await self.rpc(handoff.source, "drop", {"id": guest_id})
        self.pending.pop(guest_id, None)
        self.handoffs += 1

    async def step(self, world, dt):
        world.tick_number += 1
        for player_id in list(self.routes):
            if player_id not in world.guests:
                zone, _ = self.routes.pop(player_id)
                await self.rpc(zone, "drop", {"id": player_id})
                await self.redis.delete(self.presence_key(player_id))
        for guest in world.guests.values():
            if guest.id not in self.routes:
                await self.register(guest)
        for handoff in list(self.pending.values()):
            guest = world.guests.get(handoff.guest_id)
            if guest:
                handoff.record = self.record(guest)
                await self.transfer(handoff)
        inputs = {zone: [] for zone in self.workers}
        now = world.now()
        for guest in world.guests.values():
            zone, generation = self.routes[guest.id]
            if not guest.connected or guest.id in self.pending:
                continue
            dx, dz = (guest.dx, guest.dz) if now - guest.last_input <= .3 else (0, 0)
            inputs[zone].append({**self.record(guest), "dx": dx, "dz": dz, "seq": guest.input_seq,
                                 "grants": sorted(world.grants(guest))})
        zones = list(self.workers)
        outputs = await asyncio.gather(*(self.rpc(zone, "step", {"dt": dt, "inputs": inputs[zone]}) for zone in zones))
        for zone, output in zip(zones, outputs):
            generation = self.workers[zone].generation
            for row in output["players"]:
                guest = world.guests.get(row["id"])
                if not guest or self.routes.get(guest.id) != (zone, generation) or guest.revision != row["revision"]:
                    continue
                if world.audience_access(guest, row["x"], row["z"]):
                    guest.x, guest.z, guest.ack_seq = row["x"], row["z"], row["ack"]
                else:
                    guest.revision += 1
                if guest.emote_until < now:
                    guest.emote = ""
                if row["targetZone"] != zone:
                    target = zone_at(guest.x, guest.z)
                    if target == zone:
                        await self.rpc(zone, "resume", {"id": guest.id})
                        continue
                    handoff = Handoff(guest.id, zone, target, generation, self.workers[target].generation,
                                      secrets.token_urlsafe(16), self.record(guest))
                    self.pending[guest.id] = handoff
                    try:
                        await self.transfer(handoff)
                    except (ConnectionError, TimeoutError):
                        # The pending transaction is reconciled from Redis before any more input.
                        pass
                guest.zone = self.routes[guest.id][0]
        if time.monotonic() - self.last_presence_refresh >= 30:
            pipeline = self.redis.pipeline()
            for player_id in self.routes:
                pipeline.expire(self.presence_key(player_id), 180)
            await pipeline.execute()
            self.last_presence_refresh = time.monotonic()

    async def close(self):
        for zone, worker in list(self.workers.items()):
            try:
                await self.rpc(zone, "close")
            except Exception:
                pass
            await asyncio.to_thread(worker.process.join, 1)
            if worker.process.is_alive():
                worker.process.terminate()
                await asyncio.to_thread(worker.process.join, 1)
            worker.connection.close()
        if self.routes:
            await self.redis.delete(*(self.presence_key(player_id) for player_id in self.routes))
        self.workers.clear()
        await self.redis.aclose()
