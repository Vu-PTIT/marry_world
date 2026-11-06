"""The collision/access map is also imported by the Three.js client."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAP = json.loads((ROOT / "shared/world.json").read_text(encoding="utf-8"))
DISTRICTS = {d["id"]: d for d in MAP["districts"]}
RADIUS = 0.34


def local_to_world(district: str, x: float, z: float) -> tuple[float, float]:
    d = DISTRICTS[district]
    c, s = math.cos(d["rotation"]), math.sin(d["rotation"])
    return d["center"][0] + c * x + s * z, d["center"][1] - s * x + c * z


def world_to_local(district: str, x: float, z: float) -> tuple[float, float]:
    d = DISTRICTS[district]
    dx, dz = x - d["center"][0], z - d["center"][1]
    c, s = math.cos(d["rotation"]), math.sin(d["rotation"])
    return c * dx - s * dz, s * dx + c * dz


def in_rect(x: float, z: float, bounds: list[float], padding: float = 0) -> bool:
    a, b, c, d = bounds
    return a - padding <= x <= b + padding and c - padding <= z <= d + padding


def segment_distance(x, z, a, b) -> float:
    dx, dz = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz or 1)))
    return math.hypot(x - a[0] - t * dx, z - a[1] - t * dz)


GATES = {d: local_to_world(d, *MAP["gate"]) for d in DISTRICTS}
PATHS = [((0, 0), gate, 4.0) for gate in GATES.values()]
PATHS += [(GATES[t["from"]], GATES[t["to"]], 4.0) for t in MAP["transitions"]]


def zone_at(x: float, z: float) -> str:
    for district in DISTRICTS:
        lx, lz = world_to_local(district, x, z)
        if in_rect(lx, lz, MAP["districtBounds"], 4):
            return district
    return "plaza"


def area_at(x: float, z: float) -> tuple[str, str] | None:
    for district in DISTRICTS:
        lx, lz = world_to_local(district, x, z)
        for area in MAP["areas"]:
            if in_rect(lx, lz, area["bounds"], RADIUS):
                return district, area["id"]
    return None


def walkable(x: float, z: float, grants: set[str] | frozenset[str] = frozenset()) -> bool:
    if not math.isfinite(x) or not math.isfinite(z):
        return False
    if any(in_rect(x, z, c["bounds"], RADIUS) if "bounds" in c else math.hypot(x-c["center"][0], z-c["center"][1]) < c["radius"] + RADIUS for c in MAP["globalColliders"]):
        return False
    found = math.hypot(x, z) <= MAP["plazaRadius"] - RADIUS
    for district in DISTRICTS:
        lx, lz = world_to_local(district, x, z)
        if not in_rect(lx, lz, MAP["districtBounds"], -RADIUS):
            continue
        found = True
        if any(in_rect(lx, lz, c["bounds"], RADIUS) for c in MAP["colliders"]):
            return False
        if any(in_rect(lx, lz, c["bounds"], RADIUS) for c in DISTRICTS[district].get("colliders", [])):
            return False
        for area in MAP["areas"]:
            if in_rect(lx, lz, area["bounds"], RADIUS) and f'{district}:{area["id"]}' not in grants:
                return False
    if found:
        return True
    return any(segment_distance(x, z, a, b) <= width - RADIUS for a, b, width in PATHS)


def move(x: float, z: float, dx: float, dz: float, dt: float, grants: set[str]) -> tuple[float, float]:
    length = math.hypot(dx, dz)
    if length > 1:
        dx, dz = dx / length, dz / length
    distance = MAP["speed"] * min(max(dt, 0), 0.1)
    steps = max(1, math.ceil(distance / 0.15))
    for _ in range(steps):
        nx, nz = x + dx * distance / steps, z + dz * distance / steps
        if walkable(nx, nz, grants):
            x, z = nx, nz
        elif walkable(nx, z, grants):
            x = nx
        elif walkable(x, nz, grants):
            z = nz
    return x, z


def public_point(district: str) -> tuple[float, float]:
    return local_to_world(district, *MAP["arrival"])


def phase_config(district: str, elapsed: float) -> tuple[int, dict, float]:
    program = DISTRICTS[district]["program"]
    offset = 0
    for index, phase in enumerate(program):
        if elapsed < offset + phase["duration"]:
            return index, phase, offset
        offset += phase["duration"]
    return len(program) - 1, program[-1], offset - program[-1]["duration"]


def ceremony_duration(district: str) -> int:
    return sum(p["duration"] for p in DISTRICTS[district]["program"])
