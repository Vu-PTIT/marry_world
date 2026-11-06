import asyncio
import json
import math
from collections import defaultdict, deque
from fastapi import WebSocket


class Peer:
    """One bounded reliable queue plus one replaceable snapshot slot."""
    def __init__(self, socket: WebSocket):
        self.socket = socket
        self.controls: deque[tuple[dict, str | None]] = deque()
        self.latest: bytes | None = None
        self.wake = asyncio.Event()
        self.closed = False
        self.bytes_sent = 0

    def send(self, message: dict, event_id: str | None = None):
        if self.closed:
            return
        if len(self.controls) >= 32:
            self.closed = True
            self.wake.set()
            return
        # A current authoritative world snapshot supersedes earlier world metadata.
        if message.get("type") == "world":
            self.controls = deque((m, e) for m, e in self.controls if m.get("type") != "world")
        self.controls.append((message, event_id))
        self.wake.set()

    def state(self, data: bytes):
        self.latest = data
        self.wake.set()

    def purge(self, event_ids: set[str]):
        self.controls = deque((m, e) for m, e in self.controls if e not in event_ids and m.get("type") != "world")

    async def run(self):
        try:
            while not self.closed:
                await self.wake.wait()
                self.wake.clear()
                while self.controls:
                    message, _ = self.controls.popleft()
                    data = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
                    await asyncio.wait_for(self.socket.send_text(data), 2)
                    self.bytes_sent += len(data.encode())
                if self.latest is not None:
                    data, self.latest = self.latest, None
                    await asyncio.wait_for(self.socket.send_bytes(data), 2)
                    self.bytes_sent += len(data)
        except (Exception, asyncio.CancelledError):
            self.closed = True
        finally:
            try:
                await self.socket.close(code=1013 if self.closed else 1000)
            except Exception:
                pass


class InterestGrid:
    def __init__(self, guests, size: int = 32):
        self.size = size
        self.cells = defaultdict(list)
        for guest in guests:
            if guest.connected:
                self.cells[self.cell(guest.x, guest.z)].append(guest)

    def cell(self, x, z):
        return math.floor(x / self.size), math.floor(z / self.size)

    def nearby(self, guest, radius: float = 90, limit: int = 96, anchor=None):
        x, z = anchor if anchor is not None else (guest.x, guest.z)
        cx, cz = self.cell(x, z)
        reach = math.ceil(radius / self.size)
        visible = []
        for ix in range(cx - reach, cx + reach + 1):
            for iz in range(cz - reach, cz + reach + 1):
                for other in self.cells.get((ix, iz), []):
                    distance = (other.x - x) ** 2 + (other.z - z) ** 2
                    if distance <= radius**2:
                        visible.append((distance, other.id, other))
        visible.sort(key=lambda row: (row[0], row[1] != guest.id, row[1]))
        return [other for _, _, other in visible[:limit]]
