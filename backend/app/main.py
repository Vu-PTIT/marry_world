import asyncio
import html
import hashlib
import json
import logging
import math
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .coordination import Coordination
from .evidence import EvidenceSigner
from .map import DISTRICTS, MAP, ROOT, local_to_world
from .models import RuleError
from .protocol import decode_input, snapshot
from .transport import InterestGrid, Peer
from .world import World

logger = logging.getLogger("wedding-world")
ORIGIN = os.getenv("PUBLIC_ORIGIN", "http://localhost:8000").rstrip("/")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000").split(",")


class GuestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nickname: str = Field(min_length=2, max_length=24)
    avatar: int = Field(default=0, ge=0, le=5, strict=True)
    gender: Literal["female", "male"] = "female"
    clothingColor: str = Field(default="#f1e3cd", pattern=r"^#[0-9a-fA-F]{6}$")
    invitation: str | None = Field(default=None, max_length=40)


class GameServer:
    def __init__(self, world: World | None = None):
        self.world = world or World(EvidenceSigner(os.getenv("COMPLETION_PRIVATE_KEY", "")), int(os.getenv("MAX_GUESTS", "500")))
        self.coordination = Coordination(os.getenv("REDIS_URL", ""), os.getenv("REDIS_PREFIX", "wedding-world"))
        self.peers: dict[int, Peer] = {}
        self.task: asyncio.Task | None = None
        self.saved_revision = -1
        self.flush_lock = asyncio.Lock()
        self.metrics = {"tickMs": 0.0, "maxTickMs": 0.0, "snapshots": 0, "droppedMovement": 0, "tick": 0}
        self.zones = None
        self.authority_file = None

    def lock_local_authority(self):
        # OS locking also prevents accidental multiple Uvicorn workers in memory mode.
        path = ROOT / ".runtime"
        path.mkdir(exist_ok=True)
        namespace = hashlib.sha256(self.coordination.prefix.encode()).hexdigest()[:12]
        self.authority_file = (path / f"authority-{namespace}.lock").open("a+b")
        self.authority_file.write(b"0")
        self.authority_file.flush()
        self.authority_file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.authority_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.authority_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.authority_file.close()
            raise RuntimeError("Run one authoritative Uvicorn worker per world.") from exc

    async def start(self):
        self.lock_local_authority()
        try:
            await self.coordination.start()
            if os.getenv("WORLD_ZONE_WORKERS", "0") == "1":
                if not self.coordination.redis:
                    raise RuntimeError("Distributed zone workers require REDIS_URL for ownership coordination.")
                from .zones import ZonePool
                self.zones = ZonePool(os.getenv("REDIS_URL", ""), self.coordination.prefix, self.coordination.epoch, self.coordination.token)
                await self.zones.start()
                await self.coordination.renew()
            self.task = asyncio.create_task(self.loop())
        except Exception:
            self.authority_file.close()
            raise

    async def close(self):
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
        for peer in self.peers.values():
            peer.closed = True
            peer.wake.set()
        if self.zones:
            await self.zones.close()
        await self.coordination.close()
        if self.authority_file:
            self.authority_file.close()

    async def flush(self, force: bool = False):
        async with self.flush_lock:
            while force or self.saved_revision != self.world.revision:
                state = self.world.coordination_state()
                await self.coordination.save(state)
                self.saved_revision = state["revision"]
                force = False
        removed = set(self.world.finalized_ids)
        self.world.finalized_ids.clear()
        if removed:
            for peer in self.peers.values():
                peer.purge(removed)
        messages, self.world.notifications = self.world.notifications, []
        for notification in messages:
            peer = self.peers.get(notification.guest_id)
            if peer:
                peer.send(notification.message, notification.event_id)

    def visible(self, guest, grid):
        nearby = grid.nearby(guest)
        following = next((event for event in self.world.weddings.values()
                          if guest.id in event.viewers or guest.id in event.overflow), None)
        if not following or following.state != "CEREMONY_ACTIVE":
            return nearby
        # Remote spectator cameras subscribe to the same live actors as local guests.
        center = local_to_world(following.district, 0, -17)
        ceremony = grid.nearby(guest, radius=45, limit=32, anchor=center)
        couple = [self.world.guests[i] for i in following.couple if self.world.guests[i].connected]
        return list({p.id: p for p in [guest, *couple, *ceremony, *nearby]}.values())[:96]

    async def loop(self):
        last = time.perf_counter()
        broadcast, metadata, renewed = last, last, last
        try:
            while True:
                started = time.perf_counter()
                self.coordination.check()
                dt, last = min(0.1, started - last), started
                self.world.tick_events()
                if self.zones:
                    await self.zones.step(self.world, dt)
                else:
                    self.world.simulate(dt)
                if started - renewed >= 2:
                    await self.coordination.renew()
                    await self.flush(force=True)
                    renewed = started
                elif self.world.revision != self.saved_revision or self.world.notifications:
                    await self.flush()
                if started - broadcast >= 0.1:
                    grid = InterestGrid(self.world.guests.values())
                    for player_id, peer in list(self.peers.items()):
                        guest = self.world.guests.get(player_id)
                        if not guest or peer.closed:
                            continue
                        visible = self.visible(guest, grid)
                        peer.state(snapshot(self.world.tick_number, self.world.now(), visible))
                        self.metrics["snapshots"] += 1
                        if started - metadata >= 0.5:
                            state = self.world.state_for(guest)
                            state["nearby"] = [{"id": p.id, "nickname": p.nickname, "code": p.code,
                                                "gender": p.gender, "clothingColor": p.clothing_color,
                                                "attire": p.attire, "district": self.world.weddings[p.wedding_id].district if p.wedding_id in self.world.weddings else None}
                                               for p in visible]
                            peer.send(state)
                    if started - metadata >= 0.5:
                        metadata = started
                    broadcast = started
                elapsed = (time.perf_counter() - started) * 1000
                self.metrics["tick"] = self.world.tick_number
                self.metrics["droppedMovement"] = self.world.dropped_movement
                self.metrics["tickMs"] = round(elapsed, 3)
                self.metrics["maxTickMs"] = max(self.metrics["maxTickMs"], round(elapsed, 3))
                await asyncio.sleep(max(0, 0.05 - elapsed / 1000))
        except asyncio.CancelledError:
            raise
        except Exception:
            self.coordination.healthy = False
            logger.exception("World simulation stopped; clients will reconnect.")
            for peer in self.peers.values():
                peer.send({"v": 1, "type": "server_unavailable", "message": "The world is reconnecting. Your ceremony will not be silently restarted."})
                peer.closed = True
                peer.wake.set()


def create_app(world: World | None = None) -> FastAPI:
    game = GameServer(world)

    @asynccontextmanager
    async def lifespan(app):
        await game.start()
        yield
        await game.close()

    app = FastAPI(title="Wedding World", version="0.1.0", lifespan=lifespan)
    app.state.game = game
    app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
    session_requests = defaultdict(deque)

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if request.url.path.startswith(("/api", "/w/")):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    async def health():
        return {"status": "ok" if game.coordination.healthy and game.task and not game.task.done() else "unavailable",
                "protocol": 1, "simulationHz": 20, "broadcastHz": 10,
                "guests": sum(g.connected for g in game.world.guests.values()),
                "events": len(game.world.weddings), "zoneWorkers": bool(game.zones),
                "coordination": "redis" if game.coordination.redis else "temporary-memory",
                "metrics": game.metrics}

    @app.get("/api/config")
    async def config():
        return {"protocol": 1, "map": MAP, "publicKey": game.world.signer.public_key,
                "sessionReconnectSeconds": 120, "activeReconnectSeconds": 45,
                "evidenceRecovery": False}

    @app.post("/api/guests", status_code=201)
    async def guest_session(body: GuestRequest, request: Request):
        ip = request.client.host if request.client else "unknown"
        requests = session_requests[ip]
        now = time.monotonic()
        while requests and requests[0] < now - 60:
            requests.popleft()
        if len(requests) >= int(os.getenv("SESSION_RATE_LIMIT", "30")):
            raise HTTPException(429, "Too many temporary arrivals. Wait a minute before trying again.")
        requests.append(now)
        # Keep the limiter itself bounded, even when many source addresses arrive.
        if len(session_requests) > 10000:
            session_requests.clear()
        try:
            game.coordination.check()
            guest = game.world.create_guest(body.nickname, body.avatar, body.invitation,
                                            gender=body.gender, clothing_color=body.clothingColor)
        except RuleError as exc:
            raise HTTPException(400, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        return {"token": guest.token, "id": guest.id, "code": guest.code}

    @app.get("/api/invitations/{slug}")
    async def invitation(slug: str):
        event = game.world.resolve(slug)
        if not event:
            raise HTTPException(410, "This invitation is expired or unavailable.")
        return game.world.public_event(event)

    @app.websocket("/ws")
    async def socket(socket: WebSocket):
        if socket.headers.get("origin") not in ALLOWED_ORIGINS:
            await socket.close(code=1008)
            return
        await socket.accept()
        guest, peer, sender = None, None, None
        try:
            hello = await asyncio.wait_for(socket.receive_text(), 5)
            if len(hello.encode()) > 2048:
                await socket.close(code=1009)
                return
            data = json.loads(hello)
            if not isinstance(data, dict) or data.get("v") != 1 or data.get("type") != "hello" or not isinstance(data.get("token"), str):
                raise RuleError("Send a versioned guest hello first.")
            game.coordination.check()
            guest = game.world.connect(data["token"])
            old = game.peers.get(guest.id)
            if old:
                old.closed = True
                old.wake.set()
            peer = Peer(socket)
            game.peers[guest.id] = peer
            peer.send({"v": 1, "type": "welcome", "id": guest.id, "inputSequence": guest.input_seq,
                       "publicKey": game.world.signer.public_key, "state": game.world.state_for(guest)})
            sender = asyncio.create_task(peer.run())
            message_times: deque[float] = deque()
            command_times: deque[float] = deque()
            while not peer.closed:
                message = await asyncio.wait_for(socket.receive(), 35)
                if game.peers.get(guest.id) is not peer:
                    break
                if message["type"] == "websocket.disconnect":
                    break
                now = time.monotonic()
                while message_times and message_times[0] < now - 1:
                    message_times.popleft()
                if len(message_times) >= 65:
                    raise RuleError("The connection is sending too many messages.")
                message_times.append(now)
                game.coordination.check()
                try:
                    if message.get("bytes") is not None:
                        game.world.input(guest, *decode_input(message["bytes"]))
                    else:
                        raw = message.get("text", "")
                        if len(raw.encode()) > 4096:
                            raise RuleError("This world command is too large.")
                        while command_times and command_times[0] < now - 1:
                            command_times.popleft()
                        if len(command_times) >= 12:
                            raise RuleError("Give your next action a moment.")
                        command_times.append(now)
                        command = json.loads(raw)
                        if not isinstance(command, dict):
                            raise RuleError("Invalid world command.")
                        request_id = command.get("id", "")
                        if command.get("v") != 1 or not isinstance(request_id, str) or len(request_id) > 64 or not isinstance(command.get("type"), str) or not isinstance(command.get("data", {}), dict):
                            raise RuleError("Invalid world command.")
                        result = game.world.command(guest, command["type"], command.get("data", {}))
                        await game.flush()
                        peer.send({"v": 1, "type": "command_ok", "id": request_id, "data": result}, result.get("eventId"))
                        peer.send(game.world.state_for(guest))
                except (RuleError, ValueError, KeyError, TypeError) as exc:
                    peer.send({"v": 1, "type": "command_error", "id": locals().get("request_id", ""),
                               "message": str(exc) if isinstance(exc, RuleError) else "Invalid world command."})
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        except (RuleError, ValueError, TypeError, RuntimeError) as exc:
            if peer:
                peer.send({"v": 1, "type": "session_error", "message": str(exc)})
            else:
                with suppress(Exception):
                    await socket.send_json({"v": 1, "type": "session_error", "message": str(exc)})
                    await socket.close(code=1008)
        finally:
            if guest and game.peers.get(guest.id) is peer:
                game.peers.pop(guest.id, None)
                game.world.disconnect(guest)
            if peer:
                peer.closed = True
                peer.wake.set()
            if sender:
                sender.cancel()
                with suppress(asyncio.CancelledError):
                    await sender

    @app.get("/w/{slug}", response_class=HTMLResponse)
    async def invitation_page(slug: str):
        event = game.world.resolve(slug)
        path = ROOT / "dist/index.html"
        if not path.exists():
            return HTMLResponse("<h1>Wedding World</h1><p>Run npm run build, or use the Vite development server on port 5173.</p>", status_code=503)
        page = path.read_text(encoding="utf-8")
        title = f'{" & ".join(game.world.public_event(event)["couple"])} — Wedding World' if event else "Invitation unavailable — Wedding World"
        description = f'A public symbolic wedding in {DISTRICTS[event.district]["name"]}. Join the celebration as a temporary guest.' if event else "This invitation is expired or unavailable. You can still explore Wedding World."
        tags = {"og:title": title, "og:description": description, "og:url": f"{ORIGIN}/w/{slug}",
                "og:image": f'{ORIGIN}/art/{event.district if event else "vietnam"}.png', "og:type": "website"}
        metadata = "\n".join(f'<meta property="{key}" content="{html.escape(value, quote=True)}" />' for key, value in tags.items())
        page = page.replace("<!-- invitation-meta -->", metadata).replace("<title>Wedding World — A moment together</title>", f"<title>{html.escape(title)}</title>")
        return HTMLResponse(page, status_code=200 if event else 410)

    if (ROOT / "dist/assets").exists():
        app.mount("/assets", StaticFiles(directory=ROOT / "dist/assets"), name="assets")
    app.mount("/models", StaticFiles(directory=ROOT / "public/models", check_dir=False), name="models")
    app.mount("/art", StaticFiles(directory=ROOT / "public/art", check_dir=False), name="art")

    @app.get("/favicon.svg")
    async def favicon():
        return FileResponse(ROOT / "public/favicon.svg")

    @app.get("/", response_class=HTMLResponse)
    async def index():
        path = ROOT / "dist/index.html"
        return HTMLResponse(path.read_text(encoding="utf-8")) if path.exists() else HTMLResponse("<h1>Wedding World</h1><p>Start the frontend with npm run dev.</p>")

    return app


app = create_app()
