import math
import struct
from .models import Guest, RuleError

VERSION = 1
INPUT = struct.Struct("!BBIfff")
HEADER = struct.Struct("!BBIdH")
PLAYER = struct.Struct("!IfffIBB")
EMOTES = ["", "wave", "bow", "congratulate", "petals", "dance", "photo", "toast", "ritual", "flower", "blessing", "favor"]


def decode_input(data: bytes) -> tuple[int, float, float, float]:
    if len(data) != INPUT.size:
        raise RuleError("Invalid movement packet.")
    version, kind, seq, dx, dz, yaw = INPUT.unpack(data)
    if version != VERSION or kind != 1 or not all(math.isfinite(v) for v in (dx, dz, yaw)):
        raise RuleError("Invalid movement packet.")
    if abs(dx) > 1.01 or abs(dz) > 1.01 or abs(yaw) > 100:
        raise RuleError("Movement input is outside its allowed range.")
    return seq, dx, dz, yaw


def snapshot(tick: int, now: float, guests: list[Guest]) -> bytes:
    result = bytearray(HEADER.pack(VERSION, 2, tick % 2**32, now, len(guests)))
    for guest in guests:
        result.extend(PLAYER.pack(guest.id, guest.x, guest.z, guest.yaw, guest.ack_seq,
                                  guest.avatar, EMOTES.index(guest.emote) if guest.emote in EMOTES else 0))
    return bytes(result)


def newer(seq: int, previous: int) -> bool:
    return 0 < (seq - previous) % 2**32 < 2**31
