from dataclasses import dataclass, field
from typing import Any


class RuleError(Exception):
    pass


@dataclass
class Guest:
    id: int
    token: str = field(repr=False)
    code: str = ""
    nickname: str = ""
    avatar: int = 0
    gender: str = "female"
    clothing_color: str = "#f1e3cd"
    x: float = 0
    z: float = 0
    yaw: float = 0
    dx: float = 0
    dz: float = 0
    input_seq: int = 0
    ack_seq: int = 0
    last_input: float = 0
    last_seen: float = 0
    disconnected_at: float | None = None
    connected: bool = False
    wedding_id: str | None = None
    zone: str = "plaza"
    emote: str = ""
    emote_until: float = 0
    emote_cooldown: float = 0
    attire: int = 0
    revision: int = 0


@dataclass
class Proposal:
    id: str
    proposer: int
    partner: int
    district: str
    created: float
    state: str = "INVITE_PENDING"


@dataclass
class Membership:
    guest_id: int
    role: str
    side: int
    accepted: bool = False
    seat: int = 0


@dataclass
class Wedding:
    id: str
    slug: str
    couple: tuple[int, int]
    district: str
    created: float
    state: str = "QUEUED"
    assigned_at: float = 0
    ready_deadline: float = 0
    ready: set[int] = field(default_factory=set)
    started_at: float = 0
    phase_index: int = -1
    actions: dict[str, set[int]] = field(default_factory=dict)
    steps_started_at: float = 0
    members: dict[int, Membership] = field(default_factory=dict)
    viewers: set[int] = field(default_factory=set)
    overflow: set[int] = field(default_factory=set)
    photo_announced: bool = False


@dataclass
class Venue:
    district: str
    wedding_id: str | None = None
    available_at: float = 0
    audience_limit: int = 40
    priority_limit: int = 16


@dataclass
class Notification:
    guest_id: int
    message: dict[str, Any]
    event_id: str | None = None
