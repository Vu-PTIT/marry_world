"""Redis coordinates ownership and current event state, never avatar frames."""
import json
import secrets
import time
from redis.asyncio import Redis

RENEW = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('pexpire', KEYS[1], 10000)
return 1
"""
SAVE = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
local previous = tonumber(redis.call('get', KEYS[3]) or '-1')
if tonumber(ARGV[2]) < previous then return 1 end
redis.call('set', KEYS[2], ARGV[3], 'EX', 180)
redis.call('set', KEYS[3], ARGV[2], 'EX', 180)
return 1
"""
RELEASE = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('del', KEYS[1], KEYS[2], KEYS[3])
return 1
"""


class Coordination:
    def __init__(self, url: str = "", prefix: str = "wedding-world"):
        self.redis = Redis.from_url(url, decode_responses=True, socket_timeout=2, socket_connect_timeout=2) if url else None
        self.prefix, self.token = prefix, secrets.token_urlsafe(24)
        self.epoch, self.last_renewed, self.healthy = 0, time.monotonic(), True

    @property
    def keys(self):
        return [f"{self.prefix}:coordinator", f"{self.prefix}:active", f"{self.prefix}:revision"]

    async def start(self):
        if not self.redis:
            return
        if not await self.redis.set(self.keys[0], self.token, nx=True, px=10000):
            raise RuntimeError("This Redis world already has an authoritative coordinator. Run one ASGI worker.")
        self.epoch = await self.redis.incr(f"{self.prefix}:epoch")
        # A new owner never restores abandoned ceremonies or completed records.
        await self.redis.delete(*self.keys[1:])
        self.last_renewed = time.monotonic()

    def check(self):
        if not self.healthy or (self.redis and time.monotonic() - self.last_renewed > 8):
            raise RuntimeError("World ownership is unavailable. Reconnect after the server recovers.")

    async def save(self, state: dict):
        if not self.redis:
            return
        self.check()
        try:
            if not await self.redis.eval(SAVE, 3, *self.keys, self.token, state["revision"],
                                         json.dumps(state, ensure_ascii=False, separators=(",", ":"))):
                raise RuntimeError("The world coordinator lost its ownership fence.")
        except Exception:
            self.healthy = False
            raise

    async def renew(self):
        if not self.redis:
            return
        try:
            if not await self.redis.eval(RENEW, 1, self.keys[0], self.token):
                raise RuntimeError("The world coordinator lost its lease.")
            self.last_renewed = time.monotonic()
        except Exception:
            self.healthy = False
            raise

    async def close(self):
        if self.redis:
            try:
                await self.redis.eval(RELEASE, 3, *self.keys, self.token)
            finally:
                await self.redis.aclose()
