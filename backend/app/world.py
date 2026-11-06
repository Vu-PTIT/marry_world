"""Single-owner event aggregate. All mutations run on the same asyncio loop."""
import math
import re
import secrets
import string
import time
import unicodedata
from collections import defaultdict
from dataclasses import asdict

from .evidence import EvidenceSigner
from .map import (DISTRICTS, MAP, area_at, ceremony_duration, local_to_world,
                  in_rect, move, phase_config, public_point, walkable, world_to_local, zone_at)
from .models import Guest, Membership, Notification, Proposal, RuleError, Venue, Wedding
from .protocol import newer

ROLES = {"father", "mother", "brother", "sister", "sibling", "friend"}
ALLOWED_TRANSITIONS = {
    "QUEUED": {"VENUE_ASSIGNED", "CANCELLED", "EXPIRED"},
    "VENUE_ASSIGNED": {"READY_CHECK", "CANCELLED", "EXPIRED"},
    "READY_CHECK": {"CEREMONY_ACTIVE", "CANCELLED", "EXPIRED"},
    "CEREMONY_ACTIVE": {"COMPLETED", "CANCELLED", "EXPIRED"},
}


class World:
    def __init__(self, signer: EvidenceSigner | None = None, max_guests: int = 500):
        self.signer = signer or EvidenceSigner()
        self.max_guests = max_guests
        self.guests: dict[int, Guest] = {}
        self.tokens: dict[str, int] = {}
        self.codes: dict[str, int] = {}
        self.proposals: dict[str, Proposal] = {}
        self.weddings: dict[str, Wedding] = {}
        self.slugs: dict[str, str] = {}
        self.venues = {key: Venue(key) for key in DISTRICTS}
        self.queues: dict[str, list[str]] = {key: [] for key in DISTRICTS}
        self.notifications: list[Notification] = []
        self.finalized_ids: set[str] = set()
        self.next_guest_id = 1
        self.revision = 0
        self.tick_number = 0
        self.dropped_movement = 0
        self.access_notice_at: dict[int, float] = {}

    def now(self) -> float:
        return time.time()

    def notify(self, guest_id: int, kind: str, event_id: str | None = None, **payload):
        if guest_id in self.guests and self.guests[guest_id].connected:
            self.notifications.append(Notification(guest_id, {"v": 1, "type": kind, **payload}, event_id))

    def create_guest(self, nickname: str, avatar: int = 0, slug: str | None = None,
                     *, gender: str = "female", clothing_color: str = "#f1e3cd") -> Guest:
        nickname = unicodedata.normalize("NFC", nickname).strip()
        if not 2 <= len(nickname) <= 24 or any(unicodedata.category(c).startswith("C") for c in nickname):
            raise RuleError("Use a nickname of 2–24 characters without control characters.")
        if len(self.guests) >= self.max_guests:
            raise RuleError("The garden is at its temporary guest limit. Try again shortly.")
        if type(avatar) is not int or not 0 <= avatar <= 5:
            raise RuleError("Choose an available avatar color.")
        if gender not in ("female", "male") or not isinstance(clothing_color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", clothing_color):
            raise RuleError("Choose a guest style and a valid clothing color.")
        event = self.resolve(slug) if slug else None
        if slug and not event:
            raise RuleError("This invitation is expired or unavailable.")
        guest_id = self.next_guest_id
        self.next_guest_id += 1
        code = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))
        while code in self.codes:
            code = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))
        angle = (guest_id * 2.399963) % math.tau
        x, z = 25 * math.cos(angle), 25 * math.sin(angle)
        if event:
            x, z = public_point(event.district)
        guest = Guest(id=guest_id, token=secrets.token_urlsafe(32), code=code,
                      nickname=nickname, avatar=avatar, gender=gender, clothing_color=clothing_color.lower(),
                      x=x, z=z, last_seen=self.now(),
                      disconnected_at=self.now(), zone=zone_at(x, z))
        self.guests[guest_id] = guest
        self.tokens[guest.token], self.codes[code] = guest_id, guest_id
        if event:
            self.watch(guest, event)
        return guest

    def connect(self, token: str) -> Guest:
        guest = self.guests.get(self.tokens.get(token, -1))
        if not guest:
            raise RuleError("Your temporary guest session has expired. Enter with a nickname again.")
        guest.connected, guest.disconnected_at, guest.last_seen = True, None, self.now()
        guest.dx = guest.dz = 0
        guest.revision += 1
        return guest

    def disconnect(self, guest: Guest):
        guest.connected, guest.disconnected_at = False, self.now()
        guest.dx = guest.dz = 0

    def resolve(self, slug: str | None) -> Wedding | None:
        return self.weddings.get(self.slugs.get(slug or "", ""))

    def event_for(self, event_id: object) -> Wedding:
        if not isinstance(event_id, str) or event_id not in self.weddings:
            raise RuleError("This invitation is expired or unavailable.")
        return self.weddings[event_id]

    def owner_event(self, guest: Guest, event_id: object) -> Wedding:
        event = self.event_for(event_id)
        if guest.id not in event.couple:
            raise RuleError("Only this couple can change their wedding.")
        return event

    def transition(self, event: Wedding, state: str):
        if state not in ALLOWED_TRANSITIONS.get(event.state, set()):
            raise RuleError("That ceremony transition is unavailable.")
        event.state = state
        self.revision += 1

    def grants(self, guest: Guest) -> set[str]:
        result: set[str] = set()
        for event in self.weddings.values():
            member = event.members.get(guest.id)
            is_couple = guest.id in event.couple
            approved = member is not None and member.accepted
            if event.state in {"VENUE_ASSIGNED", "READY_CHECK", "CEREMONY_ACTIVE"}:
                if is_couple or approved:
                    sides = (0, 1) if is_couple else (member.side,)
                    for side in sides:
                        result.add(f"{event.district}:priority-{'a' if side == 0 else 'b'}")
                if event.state != "CEREMONY_ACTIVE" and (is_couple or approved):
                    side = event.couple.index(guest.id) if is_couple else member.side
                    result.add(f"{event.district}:prep-{'a' if side == 0 else 'b'}")
                if event.state == "CEREMONY_ACTIVE":
                    _, phase, _ = phase_config(event.district, self.now() - event.started_at)
                    if is_couple or (approved and member.role in phase.get("calledRoles", [])):
                        result.add(f"{event.district}:stage")
                        result.add(f"{event.district}:aisle")
                        result.add(f"{event.district}:procession")
        return result

    def evacuate(self):
        for guest in self.guests.values():
            area = area_at(guest.x, guest.z)
            if area and f"{area[0]}:{area[1]}" not in self.grants(guest):
                guest.x, guest.z = public_point(area[0])
                guest.dx = guest.dz = 0
                guest.revision += 1

    def input(self, guest: Guest, seq: int, dx: float, dz: float, yaw: float):
        if newer(seq, guest.input_seq):
            if guest.input_seq != guest.ack_seq:
                self.dropped_movement += 1
            event = self.weddings.get(guest.wedding_id or "")
            if event and event.state == "CEREMONY_ACTIVE" and self.now() - event.started_at < DISTRICTS[event.district]["program"][0]["duration"]:
                dx = dz = 0
            if event and event.steps_started_at and self.now() - event.steps_started_at < 21:
                dx = dz = 0
            guest.input_seq, guest.dx, guest.dz, guest.yaw = seq, dx, dz, yaw
            guest.last_input = guest.last_seen = self.now()

    def simulate(self, dt: float):
        self.tick_number += 1
        now = self.now()
        for guest in self.guests.values():
            if not guest.connected:
                continue
            if now - guest.last_input > 0.3:
                guest.dx = guest.dz = 0
            x, z = move(guest.x, guest.z, guest.dx, guest.dz, dt, self.grants(guest))
            if self.audience_access(guest, x, z):
                guest.x, guest.z = x, z
            guest.ack_seq = guest.input_seq
            guest.zone = zone_at(guest.x, guest.z)
            if guest.emote_until < now:
                guest.emote = ""

    def propose(self, guest: Guest, partner_code: object, district: object) -> dict:
        if math.hypot(guest.x - MAP["registrar"][0], guest.z - MAP["registrar"][1]) > 7:
            raise RuleError("Meet the Wedding Registrar in the plaza to register.")
        if district not in DISTRICTS:
            raise RuleError("Choose one of the five districts.")
        partner = self.guests.get(self.codes.get(str(partner_code).upper().strip(), -1))
        if not partner or not partner.connected or partner.id == guest.id:
            raise RuleError("Enter the guest code of another connected player.")
        if guest.wedding_id or partner.wedding_id:
            current = self.weddings.get(guest.wedding_id or "")
            if current and partner.id in current.couple and current.district == district:
                return {"eventId": current.id}
            raise RuleError("One of you already has a queued or active wedding.")
        for proposal in self.proposals.values():
            if {guest.id, partner.id} == {proposal.proposer, proposal.partner} and proposal.district == district:
                return {"proposalId": proposal.id}
            if {guest.id, partner.id} & {proposal.proposer, proposal.partner}:
                raise RuleError("A consent request is already waiting for one of you.")
        proposal = Proposal(secrets.token_urlsafe(16), guest.id, partner.id, str(district), self.now())
        self.proposals[proposal.id] = proposal
        self.notify(partner.id, "consent_requested", proposer=guest.nickname, district=district)
        return {"proposalId": proposal.id}

    def consent(self, guest: Guest, proposal_id: object, accept: object) -> dict:
        proposal = self.proposals.get(str(proposal_id))
        if not proposal:
            existing = self.weddings.get(guest.wedding_id or "")
            if existing:
                return {"eventId": existing.id}
            raise RuleError("This consent request is expired or unavailable.")
        if guest.id != proposal.partner or type(accept) is not bool:
            raise RuleError("Only the invited participant can answer this consent request.")
        if self.now() >= proposal.created + 120:
            del self.proposals[proposal.id]
            raise RuleError("This consent request has expired.")
        if not accept:
            del self.proposals[proposal.id]
            self.notify(proposal.proposer, "notice", message="The invitation to register was declined.")
            return {}
        a, b = self.guests.get(proposal.proposer), self.guests.get(proposal.partner)
        if not a or not b or not a.connected or not b.connected or a.wedding_id or b.wedding_id:
            raise RuleError("Both participants must be available and free to register.")
        event = Wedding(id=secrets.token_urlsafe(18), slug=secrets.token_urlsafe(18),
                        couple=(a.id, b.id), district=proposal.district, created=self.now())
        self.weddings[event.id], self.slugs[event.slug] = event, event.id
        self.queues[event.district].append(event.id)
        a.wedding_id = b.wedding_id = event.id
        del self.proposals[proposal.id]
        self.revision += 1
        for player in event.couple:
            self.notify(player, "registered", event.id, message="You both consented. Your wedding invitation is ready.")
        return {"eventId": event.id}

    def invite_role(self, guest: Guest, data: dict) -> dict:
        event = self.owner_event(guest, data.get("eventId"))
        if event.state == "CEREMONY_ACTIVE":
            raise RuleError("Roles are fixed while the ceremony is running.")
        invitee = self.guests.get(self.codes.get(str(data.get("code", "")).upper().strip(), -1))
        role, side = data.get("role"), data.get("side")
        if not invitee or not invitee.connected or invitee.id in event.couple or role not in ROLES or type(side) is not int or side not in (0, 1):
            raise RuleError("Choose a connected guest, a family/friend role, and a side.")
        current = event.members.get(invitee.id)
        if current and current.role == role and current.side == side:
            return {}
        others = [m for m in event.members.values() if m.guest_id != invitee.id]
        if len(others) >= self.venues[event.district].priority_limit:
            raise RuleError("All 16 priority places are reserved, including pending invitations.")
        if sum(m.side == side for m in others) >= 8:
            raise RuleError("All eight priority places for this side are reserved.")
        if role in {"father", "mother"} and any(m.role == role and m.side == side for m in others):
            raise RuleError("That parent place is already reserved for this side.")
        event.members[invitee.id] = Membership(invitee.id, role, side)
        self.seat_members(event)
        self.notify(invitee.id, "role_invited", event.id, message=f"You have been invited as {role}. Accept in your wedding group.")
        self.revision += 1
        return {}

    def audience_access(self, guest: Guest, x: float, z: float) -> bool:
        district = zone_at(x, z)
        if district == "plaza" or not in_rect(*world_to_local(district, x, z), MAP["audienceBounds"]):
            return True
        event = self.weddings.get(self.venues[district].wedding_id or "")
        if not event or guest.id in event.couple or (event.members.get(guest.id) and event.members[guest.id].accepted):
            return True
        if in_rect(*world_to_local(district, guest.x, guest.z), MAP["audienceBounds"]):
            return True
        count = sum(g.connected and g.id != guest.id and in_rect(*world_to_local(district, g.x, g.z), MAP["audienceBounds"])
                    for g in self.guests.values())
        if count < self.venues[district].audience_limit:
            return True
        event.overflow.add(guest.id)
        if self.now() - self.access_notice_at.get(guest.id, 0) > 8:
            self.notify(guest.id, "notice", message="The public viewing rows are full. Use a side terrace or an optional synchronized spectator view.")
            self.access_notice_at[guest.id] = self.now()
        return False

    def seat_members(self, event: Wedding):
        rank = {"father": 0, "mother": 0, "brother": 1, "sister": 1, "sibling": 1, "friend": 2}
        for side in (0, 1):
            members = sorted((m for m in event.members.values() if m.side == side), key=lambda m: (rank[m.role], m.guest_id))
            for index, member in enumerate(members):
                member.seat = index

    def member_position(self, event: Wedding, member: Membership) -> tuple[float, float]:
        # Parent rows are nearest the stage. Each district uses its characteristic seating geometry.
        s = -1 if member.side == 0 else 1
        col, row = member.seat % 2, member.seat // 2
        if event.district == "vietnam":
            x, z = s * (4.8 + col * 3.4), -3.2 + row * 2.2
        elif event.district == "japan":
            x, z = s * (4.8 + (member.seat % 4) * 2.1), -2.8 + (member.seat // 4) * 3.2
        elif event.district == "korea":
            x, z = s * (5.2 + col * 3.0), -3.0 + row * 2.3
        elif event.district == "india":
            x, z = s * (5.0 + col * 3.1 + row * 0.25), -3.2 + row * 2.2
        else:
            x, z = s * (4.5 + col * 3.1 + row * 0.35), -3.0 + row * 2.3
        return local_to_world(event.district, x, min(z, 5))

    def in_reception_garden(self, district: str, x: float, z: float) -> bool:
        if district == "plaza":
            return False
        local = world_to_local(district, x, z)
        points = [MAP["reception"], DISTRICTS[district].get("photoPoint", [-26, -31])]
        return any(math.dist(local, pt) <= 16 for pt in points)

    def watch(self, guest: Guest, event: Wedding) -> dict:
        for other in self.weddings.values():
            if other.id != event.id:
                other.viewers.discard(guest.id)
                other.overflow.discard(guest.id)
        if len(event.viewers) >= self.venues[event.district].audience_limit and guest.id not in event.viewers:
            event.overflow.add(guest.id)
            return {"overflow": True, "eventId": event.id}
        event.viewers.add(guest.id)
        return {"overflow": False, "eventId": event.id}

    def command(self, guest: Guest, kind: str, data: dict) -> dict:
        guest.last_seen = self.now()
        if kind == "ping":
            return {"serverTime": self.now()}
        if kind == "propose":
            return self.propose(guest, data.get("partnerCode"), data.get("district"))
        if kind == "consent":
            return self.consent(guest, data.get("proposalId"), data.get("accept"))
        if kind == "withdraw_proposal":
            proposal = self.proposals.get(str(data.get("proposalId")))
            if proposal and guest.id in (proposal.proposer, proposal.partner):
                del self.proposals[proposal.id]
            return {}
        if kind == "invite_role":
            return self.invite_role(guest, data)
        if kind == "answer_role":
            event = self.event_for(data.get("eventId"))
            if event.state == "CEREMONY_ACTIVE":
                raise RuleError("Roles are fixed while the ceremony is running.")
            member = event.members.get(guest.id)
            if not member or type(data.get("accept")) is not bool:
                raise RuleError("There is no role invitation for you.")
            if data["accept"]:
                member.accepted = True
            else:
                del event.members[guest.id]
            self.revision += 1
            self.evacuate()
            return {}
        if kind == "remove_role":
            event = self.owner_event(guest, data.get("eventId"))
            if event.state == "CEREMONY_ACTIVE":
                raise RuleError("Roles are fixed while the ceremony is running.")
            event.members.pop(data.get("guestId"), None)
            self.seat_members(event)
            self.evacuate()
            self.revision += 1
            return {}
        if kind == "ready":
            event = self.owner_event(guest, data.get("eventId"))
            if event.state != "READY_CHECK" or self.now() >= event.ready_deadline:
                raise RuleError("The ready-check window is closed.")
            point = local_to_world(event.district, *MAP["readyPoint"])
            if not guest.connected or math.hypot(guest.x - point[0], guest.z - point[1]) > 8:
                raise RuleError("Stand in the ready-check circle at your venue before confirming.")
            event.ready.add(guest.id)
            self.revision += 1
            return {}
        if kind == "ceremony_action":
            event = self.event_for(data.get("eventId"))
            if event.state != "CEREMONY_ACTIVE":
                raise RuleError("This ceremony action is unavailable.")
            _, phase, offset = phase_config(event.district, self.now() - event.started_at)
            if data.get("phaseId") != phase["id"]:
                raise RuleError("The ceremony has moved to its next moment.")
            member = event.members.get(guest.id)
            couple = guest.id in event.couple
            if not couple and not (member and member.accepted and member.role in phase.get("calledRoles", [])):
                raise RuleError("This action is for the couple or the roles currently called.")
            if area_at(guest.x, guest.z) != (event.district, "stage"):
                raise RuleError("Enter the ceremonial area when your role is called.")
            if phase["id"] == "steps" and self.now() > event.started_at + offset + phase["duration"] - 21:
                raise RuleError("The seven steps need 21 seconds. Join earlier in this moment.")
            event.actions.setdefault(phase["id"], set()).add(guest.id)
            if phase["id"] == "steps" and not event.steps_started_at and set(event.couple) <= event.actions["steps"]:
                event.steps_started_at = self.now()
            guest.emote, guest.emote_until = "ritual", self.now() + 3
            self.revision += 1
            return {}
        if kind == "attire":
            event = self.owner_event(guest, data.get("eventId"))
            if event.state == "CEREMONY_ACTIVE" or type(data.get("choice")) is not int or not 0 <= data["choice"] < 3:
                raise RuleError("Choose clothing before the ceremony starts.")
            guest.attire = data["choice"]
            return {}
        if kind == "cancel":
            event = self.owner_event(guest, data.get("eventId"))
            self.finalize(event, "CANCELLED", "The couple cancelled this wedding.")
            return {}
        if kind == "watch":
            return self.watch(guest, self.event_for(data.get("eventId")))
        if kind == "leave_viewing":
            for event in self.weddings.values():
                event.viewers.discard(guest.id)
                event.overflow.discard(guest.id)
            return {}
        if kind in {"seat", "enter_stage"}:
            event = self.event_for(data.get("eventId"))
            member = event.members.get(guest.id)
            if not member or not member.accepted or event.state not in {"VENUE_ASSIGNED", "READY_CHECK", "CEREMONY_ACTIVE"}:
                raise RuleError("This place is reserved for approved wedding-group members.")
            point = self.member_position(event, member)
            if kind == "enter_stage":
                if f"{event.district}:stage" not in self.grants(guest):
                    raise RuleError("Your role has not been called to the stage.")
                point = local_to_world(event.district, (-5 if member.side == 0 else 5), -12)
            return {"destination": list(point)}
        if kind == "emote":
            emote = data.get("emote")
            if emote not in {"wave", "bow", "congratulate", "petals", "dance", "photo", "toast"}:
                raise RuleError("Choose an available gesture.")
            if self.now() < guest.emote_cooldown:
                raise RuleError("Give your next gesture a moment.")
            area = area_at(guest.x, guest.z)
            event = self.weddings.get(guest.wedding_id or "")
            in_procession = event and event.state == "CEREMONY_ACTIVE" and self.now() - event.started_at < DISTRICTS[event.district]["program"][0]["duration"]
            if ((area and area[1] in {"stage", "aisle", "procession"}) or in_procession) and emote not in {"bow", "photo"}:
                raise RuleError("Keep this gesture in the public garden during the ceremony.")
            if emote == "dance":
                d = zone_at(guest.x, guest.z)
                if not self.in_reception_garden(d, guest.x, guest.z):
                    raise RuleError("Dancing is welcome in the separate reception garden.")
            guest.emote, guest.emote_until, guest.emote_cooldown = emote, self.now() + 3, self.now() + 3
            return {}
        if kind == "reception_activity":
            district = zone_at(guest.x, guest.z)
            if not self.in_reception_garden(district, guest.x, guest.z):
                raise RuleError("Visit the reception and photo garden to take part.")
            if self.now() < guest.emote_cooldown:
                raise RuleError("Give your next gesture a moment.")
            gesture = {"vietnam": "toast", "japan": "flower", "korea": "blessing", "india": "dance", "italy": "favor"}[district]
            guest.emote, guest.emote_until, guest.emote_cooldown = gesture, self.now() + 4, self.now() + 4
            return {"message": {"vietnam": "A symbolic tea toast, with warm wishes.", "japan": "A camellia arranged for a shared photograph.", "korea": "A symbolic family blessing, offered with care.", "india": "A little dance in the reception courtyard.", "italy": "A sugared-almond favor, shared with good wishes."}[district]}
        raise RuleError("Unknown or unauthorized world command.")

    def tick_events(self):
        now = self.now()
        for proposal in list(self.proposals.values()):
            if now >= proposal.created + 120 or any(p not in self.guests for p in (proposal.proposer, proposal.partner)):
                self.proposals.pop(proposal.id, None)
        for event in list(self.weddings.values()):
            couple = [self.guests.get(i) for i in event.couple]
            disconnected = [g for g in couple if g is None or not g.connected]
            grace = 45 if event.state == "CEREMONY_ACTIVE" else 90
            if any(g is None or (g.disconnected_at is not None and now - g.disconnected_at > grace) for g in disconnected):
                self.finalize(event, "EXPIRED", "A participant did not return within the reconnect window.")
                continue
            if event.state == "VENUE_ASSIGNED":
                self.transition(event, "READY_CHECK")
            if event.state == "READY_CHECK":
                if now >= event.ready_deadline:
                    self.finalize(event, "CANCELLED", "Both participants did not confirm within 60 seconds. Register again to try another ceremony.")
                elif len(event.ready) == 2 and all(g and g.connected for g in couple):
                    point = local_to_world(event.district, *MAP["readyPoint"])
                    if all(math.dist((g.x, g.z), point) <= 8 for g in couple):
                        self.start(event)
                    else:
                        event.ready = {g.id for g in couple if math.dist((g.x, g.z), point) <= 8}
            elif event.state == "CEREMONY_ACTIVE":
                elapsed = now - event.started_at
                self.procession(event, elapsed)
                if event.district == "india" and event.steps_started_at and event.phase_index == 3:
                    progress = min(7, (now - event.steps_started_at) / 3)
                    for side, player_id in enumerate(event.couple):
                        player = self.guests[player_id]
                        point = local_to_world(event.district, MAP["stagePositions"][side][0], -17 - progress)
                        if math.dist((player.x, player.z), point) > .005:
                            player.x, player.z = point
                            player.dx = player.dz = 0
                            player.revision += 1
                index, phase, _ = phase_config(event.district, elapsed)
                # Required actions are checked against server time, including skipped ticks.
                offset = 0
                valid = True
                for previous in DISTRICTS[event.district]["program"]:
                    offset += previous["duration"]
                    if elapsed >= offset and previous.get("required") and not set(event.couple) <= event.actions.get(previous["id"], set()):
                        self.finalize(event, "CANCELLED", "A required couple action was not completed during its scheduled moment.")
                        valid = False
                        break
                if not valid:
                    continue
                if elapsed >= ceremony_duration(event.district):
                    if all(g and g.connected for g in couple):
                        self.finalize(event, "COMPLETED", "Your ceremony is complete. Your keepsake is ready in this tab.")
                    else:
                        self.finalize(event, "CANCELLED", "Both participants must be connected at the end of the ceremony.")
                elif index != event.phase_index:
                    event.phase_index = index
                    self.evacuate()
                    self.revision += 1
                if event.id in self.weddings and phase["id"] == "congratulations" and not event.photo_announced:
                    event.photo_announced = True
                    for player in set(event.couple) | event.viewers | set(event.members):
                        self.notify(player, "group_photo", event.id, message="The scheduled group photograph is now open. Use the photo button to save your view.")
        for district, venue in self.venues.items():
            if venue.wedding_id or venue.available_at > now:
                continue
            queue = self.queues[district]
            while queue and queue[0] not in self.weddings:
                queue.pop(0)
            if queue:
                event = self.weddings[queue.pop(0)]
                self.transition(event, "VENUE_ASSIGNED")
                venue.wedding_id, event.assigned_at, event.ready_deadline = event.id, now, now + 60
                for player in event.couple:
                    self.notify(player, "called", event.id, message="Your venue is ready. Both of you must reach the ready-check circle and confirm within 60 seconds.")
        for guest in list(self.guests.values()):
            if not guest.connected and guest.disconnected_at is not None and now - guest.disconnected_at > 120 and not guest.wedding_id:
                self.remove_guest(guest)

    def start(self, event: Wedding):
        self.transition(event, "CEREMONY_ACTIVE")
        event.started_at, event.phase_index = self.now(), 0
        for side, player_id in enumerate(event.couple):
            guest = self.guests[player_id]
            guest.x, guest.z = local_to_world(event.district, MAP["stagePositions"][side][0], 24)
            guest.dx = guest.dz = 0
            guest.yaw = DISTRICTS[event.district]["rotation"] + math.pi
            guest.revision += 1
        self.evacuate()

    def procession(self, event: Wedding, elapsed: float):
        duration = DISTRICTS[event.district]["program"][0]["duration"]
        if elapsed > duration and event.phase_index != 0:
            return
        progress = min(1, elapsed / (duration * .8))
        for side, player_id in enumerate(event.couple):
            guest = self.guests.get(player_id)
            if not guest:
                continue
            x, end_z = MAP["stagePositions"][side]
            position = local_to_world(event.district, x, 24 + (end_z - 24) * progress)
            if math.dist((guest.x, guest.z), position) > .005:
                guest.x, guest.z = position
                guest.dx = guest.dz = 0
                guest.revision += 1

    def finalize(self, event: Wedding, outcome: str, reason: str):
        if event.id not in self.weddings:
            return
        if outcome == "COMPLETED":
            if event.state != "CEREMONY_ACTIVE" or self.now() - event.started_at < ceremony_duration(event.district):
                raise RuleError("The server has not completed this ceremony.")
            required = [p["id"] for p in DISTRICTS[event.district]["program"] if p.get("required")]
            if not all(set(event.couple) <= event.actions.get(p, set()) for p in required):
                raise RuleError("The couple has not completed all required actions.")
        active = event.state == "CEREMONY_ACTIVE"
        self.transition(event, outcome)
        audience = set(event.couple) | set(event.members) | event.viewers | event.overflow
        self.notifications = [n for n in self.notifications if n.event_id != event.id]
        if outcome == "COMPLETED":
            evidence = self.signer.issue(event.id, [self.guests[i].nickname for i in event.couple], event.district, self.now())
            for player_id in event.couple:
                # Evidence is delivered independently of event storage and never cached for retrieval.
                self.notify(player_id, "completion", evidence=evidence)
        for player_id in audience:
            self.notify(player_id, "event_ended", message=reason, outcome=outcome)
        self.slugs.pop(event.slug, None)
        self.weddings.pop(event.id, None)
        self.queues[event.district] = [key for key in self.queues[event.district] if key != event.id]
        venue = self.venues[event.district]
        if venue.wedding_id == event.id:
            venue.wedding_id, venue.available_at = None, self.now() + (60 if active else 0)
        for player_id in event.couple:
            if player_id in self.guests:
                self.guests[player_id].wedding_id = None
        event.members.clear()
        event.viewers.clear()
        event.overflow.clear()
        event.actions.clear()
        self.finalized_ids.add(event.id)
        self.evacuate()

    def remove_guest(self, guest: Guest):
        self.guests.pop(guest.id, None)
        self.tokens.pop(guest.token, None)
        self.codes.pop(guest.code, None)
        self.access_notice_at.pop(guest.id, None)
        for event in self.weddings.values():
            event.members.pop(guest.id, None)
            event.viewers.discard(guest.id)
            event.overflow.discard(guest.id)

    def public_event(self, event: Wedding) -> dict:
        now = self.now()
        venue = self.venues[event.district]
        queue = self.queues[event.district]
        index, phase, phase_offset = phase_config(event.district, max(0, now - event.started_at))
        result = {"id": event.id, "slug": event.slug, "couple": [self.guests[i].nickname for i in event.couple],
                  "district": event.district, "state": event.state,
                  "venue": DISTRICTS[event.district]["stage"] if event.state != "QUEUED" else None,
                  "slotSeconds": 60 + ceremony_duration(event.district) + 60,
                  "queuePosition": queue.index(event.id) + 1 if event.id in queue else 0,
                  "readyDeadline": event.ready_deadline or None, "readyCount": len(event.ready),
                  "startedAt": event.started_at or None,
                  "phase": {**phase, "index": index, "endsAt": event.started_at + phase_offset + phase["duration"]} if event.state == "CEREMONY_ACTIVE" else None,
                  "audience": len(event.viewers), "audienceLimit": venue.audience_limit,
                  "priorityUsed": len(event.members), "priorityLimit": venue.priority_limit}
        if event.state == "QUEUED":
            earliest = max(now, venue.available_at)
            current = self.weddings.get(venue.wedding_id or "")
            if current:
                earliest = (current.started_at + ceremony_duration(event.district) + 60) if current.state == "CEREMONY_ACTIVE" else current.ready_deadline + ceremony_duration(event.district) + 60
            result["estimatedStart"] = earliest + queue.index(event.id) * result["slotSeconds"]
        return result

    def state_for(self, guest: Guest) -> dict:
        own = self.weddings.get(guest.wedding_id or "")
        memberships = []
        for event in self.weddings.values():
            if guest.id in event.members:
                member = event.members[guest.id]
                memberships.append({"event": self.public_event(event), **asdict(member),
                                    "position": list(self.member_position(event, member))})
        event_info = None
        if own:
            event_info = {**self.public_event(own), "isCouple": True,
                          "side": own.couple.index(guest.id), "myReady": guest.id in own.ready,
                          "myActions": [p for p, players in own.actions.items() if guest.id in players],
                          "members": [{**asdict(m), "nickname": self.guests[m.guest_id].nickname} for m in own.members.values() if m.guest_id in self.guests]}
        proposals = [{"id": p.id, "state": p.state, "district": p.district,
                      "proposer": self.guests[p.proposer].nickname, "partner": self.guests[p.partner].nickname,
                      "incoming": p.partner == guest.id, "expiresAt": p.created + 120}
                     for p in self.proposals.values() if guest.id in (p.proposer, p.partner)
                     and p.proposer in self.guests and p.partner in self.guests]
        viewing = next((self.public_event(e) for e in self.weddings.values() if guest.id in e.viewers | e.overflow), None)
        motion_until = 0
        if own and own.state == "CEREMONY_ACTIVE":
            motion_until = own.started_at + DISTRICTS[own.district]["program"][0]["duration"]
            if own.steps_started_at:
                motion_until = max(motion_until, own.steps_started_at + 21)
        return {"v": 1, "type": "world", "serverTime": self.now(),
                "self": {"id": guest.id, "code": guest.code, "nickname": guest.nickname,
                         "zone": guest.zone, "attire": guest.attire, "revision": guest.revision,
                         "gender": guest.gender, "clothingColor": guest.clothing_color,
                         "grants": sorted(self.grants(guest)), "motionUntil": motion_until},
                "guestCount": sum(g.connected for g in self.guests.values()),
                "directory": [self.public_event(e) for e in self.weddings.values()],
                "wedding": event_info, "proposals": proposals, "memberships": memberships,
                "viewing": viewing,
                "overflow": any(guest.id in e.overflow for e in self.weddings.values()),
                "venues": [{"district": v.district, "availableAt": v.available_at,
                            "occupied": v.wedding_id is not None} for v in self.venues.values()]}

    def coordination_state(self) -> dict:
        # Only the current active aggregate; no finished records, streams, or retries.
        return {"revision": self.revision,
                "events": {key: {**self.public_event(e), "coupleIds": list(e.couple),
                                  "roles": [asdict(m) for m in e.members.values()]} for key, e in self.weddings.items()},
                "invitations": dict(self.slugs), "queues": self.queues,
                "venues": {key: asdict(v) for key, v in self.venues.items()}}
