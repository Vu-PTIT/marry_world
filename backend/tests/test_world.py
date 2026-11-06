import base64
import json
import math
import struct
from collections import deque

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from backend.app.evidence import DISCLAIMER
from backend.app.map import DISTRICTS, GATES, MAP, PATHS, area_at, ceremony_duration, local_to_world, world_to_local, move, public_point, walkable
from backend.app.models import RuleError
from backend.app.main import GameServer
from backend.app.protocol import INPUT, PLAYER, HEADER, decode_input, newer, snapshot
from backend.app.transport import InterestGrid, Peer
from .conftest import active_couple, couple, guest


def test_consent_precedes_any_public_event(world):
    a, b = guest(world, "First Guest"), guest(world, "Second Guest")
    a.x, a.z = MAP["registrar"]
    one = world.propose(a, b.code, "vietnam")
    two = world.propose(a, b.code, "vietnam")
    assert one == two
    assert not world.weddings and not world.slugs
    world.consent(b, one["proposalId"], True)
    world.consent(b, one["proposalId"], True)
    assert len(world.weddings) == len(world.slugs) == 1


def test_motion_deadline_matches_authoritative_procession_and_steps(world):
    spectator = guest(world)
    assert world.state_for(spectator)["self"]["motionUntil"] == 0
    a, b, event = active_couple(world, "india")
    assert world.state_for(a)["self"]["motionUntil"] == event.started_at + 90
    for phase in DISTRICTS["india"]["program"][:3]:
        if phase["required"]:
            for player in (a, b):
                world.command(player, "ceremony_action", {"eventId": event.id, "phaseId": phase["id"]})
        world.clock.advance(phase["duration"])
        world.tick_events()
    assert world.state_for(a)["self"]["motionUntil"] <= world.now()
    world.command(a, "ceremony_action", {"eventId": event.id, "phaseId": "steps"})
    assert world.state_for(a)["self"]["motionUntil"] <= world.now()
    world.command(b, "ceremony_action", {"eventId": event.id, "phaseId": "steps"})
    assert world.state_for(a)["self"]["motionUntil"] == world.now() + 21
    assert world.state_for(spectator)["self"]["motionUntil"] == 0
    world.clock.advance(21)
    assert world.state_for(a)["self"]["motionUntil"] <= world.now()


def test_only_invited_person_can_consent_and_registrar_is_required(world):
    a, b, outsider = guest(world), guest(world), guest(world)
    with pytest.raises(RuleError, match="Registrar"):
        world.propose(a, b.code, "vietnam")
    a.x, a.z = MAP["registrar"]
    proposal = world.propose(a, b.code, "vietnam")
    with pytest.raises(RuleError):
        world.consent(outsider, proposal["proposalId"], True)
    world.consent(b, proposal["proposalId"], False)
    assert not world.weddings and not world.proposals


def test_double_registration_and_expired_proposal(world):
    a, b, event = couple(world)
    c = guest(world)
    with pytest.raises(RuleError, match="already"):
        world.propose(a, c.code, "italy")
    world.finalize(event, "CANCELLED", "Cancelled")
    proposal = world.propose(a, c.code, "italy")
    world.clock.advance(120)
    with pytest.raises(RuleError, match="expired"):
        world.consent(c, proposal["proposalId"], True)
    assert not world.weddings


@pytest.mark.parametrize("confirmations", [0, 1])
def test_missing_ready_confirmation_cancels_immediately(world, confirmations):
    a, b, event = couple(world)
    _, _, next_event = couple(world)
    slug, event_id = event.slug, event.id
    world.tick_events(); world.tick_events()
    assert world.venues["vietnam"].wedding_id == event_id
    if confirmations:
        a.x, a.z = local_to_world("vietnam", *MAP["readyPoint"])
        world.command(a, "ready", {"eventId": event.id})
    world.clock.advance(60)
    world.tick_events()
    assert event_id not in world.weddings and world.resolve(slug) is None
    assert world.venues["vietnam"].wedding_id == next_event.id
    assert a.wedding_id is None and b.wedding_id is None
    assert not any(n.message["type"] == "completion" for n in world.notifications)


def test_ready_needs_actual_position_and_revalidates_presence(world):
    a, b, event = couple(world)
    world.tick_events(); world.tick_events()
    with pytest.raises(RuleError, match="circle"):
        world.command(a, "ready", {"eventId": event.id})
    for player in (a,b):
        player.x, player.z = local_to_world("vietnam", *MAP["readyPoint"])
        world.command(player, "ready", {"eventId": event.id})
    a.x, a.z = public_point("italy")
    world.tick_events()
    assert event.state == "READY_CHECK" and a.id not in event.ready


def test_parallel_venues_and_queue_order_never_double_book(world):
    first = couple(world)[2]
    second = couple(world)[2]
    other = couple(world, "italy")[2]
    for _ in range(5): world.tick_events()
    assert world.venues["vietnam"].wedding_id == first.id
    assert world.queues["vietnam"] == [second.id]
    assert world.venues["italy"].wedding_id == other.id
    assert first.state == other.state == "READY_CHECK"


def test_ordinary_guest_cannot_forge_position_or_stage_access(world):
    stranger = guest(world)
    target = local_to_world("vietnam", 0, -15)
    assert not walkable(*target)
    assert not walkable(*local_to_world("vietnam", -6, 0))
    stranger.x, stranger.z = local_to_world("vietnam", -10.7, -15)
    for _ in range(30): stranger.x, stranger.z = move(stranger.x, stranger.z, 1, 0, .1, world.grants(stranger))
    assert area_at(stranger.x,stranger.z) != ("vietnam","stage")
    for command in ["position", "teleport", "complete", "set_role", "set_phase"]:
        with pytest.raises(RuleError):world.command(stranger,command,{"x":target[0],"z":target[1],"role":"father"})


def test_role_needs_couple_approval_and_invitee_acceptance(world):
    a, b, event = couple(world)
    parent = guest(world, "Parent Guest")
    with pytest.raises(RuleError):
        world.command(parent,"invite_role",{"eventId":event.id,"code":parent.code,"role":"father","side":0})
    world.invite_role(a,{"eventId":event.id,"code":parent.code,"role":"father","side":0})
    world.tick_events();world.tick_events()
    assert not world.grants(parent)
    world.command(parent,"answer_role",{"eventId":event.id,"accept":True})
    assert "vietnam:priority-a" in world.grants(parent)
    assert "vietnam:priority-b" not in world.grants(parent)
    assert "vietnam:prep-a" in world.grants(parent)
    assert "vietnam:prep-b" not in world.grants(parent)
    assert "vietnam:stage" not in world.grants(parent)


def test_priority_capacity_counts_pending_places_and_parent_uniqueness(world):
    a, b, event = couple(world)
    parent = guest(world)
    world.invite_role(a,{"eventId":event.id,"code":parent.code,"role":"father","side":0})
    with pytest.raises(RuleError,match="parent"):
        world.invite_role(a,{"eventId":event.id,"code":guest(world).code,"role":"father","side":0})
    for side,count in [(0,7),(1,8)]:
        for _ in range(count):world.invite_role(a,{"eventId":event.id,"code":guest(world).code,"role":"friend","side":side})
    assert len(event.members)==16
    with pytest.raises(RuleError,match="16"):
        world.invite_role(a,{"eventId":event.id,"code":guest(world).code,"role":"friend","side":1})


def test_roles_called_by_phase_and_revoked_afterward(world):
    a,b,event = couple(world)
    parent=guest(world)
    world.invite_role(a,{"eventId":event.id,"code":parent.code,"role":"mother","side":1})
    world.command(parent,"answer_role",{"eventId":event.id,"accept":True})
    world.tick_events();world.tick_events()
    for player in (a,b):
        player.x,player.z=local_to_world("vietnam",*MAP["readyPoint"])
        world.command(player,"ready",{"eventId":event.id})
    world.tick_events()
    assert "vietnam:stage" not in world.grants(parent)
    with pytest.raises(RuleError,match="fixed"):
        world.command(a,"remove_role",{"eventId":event.id,"guestId":parent.id})
    event.actions["gifts"]={a.id,b.id}
    world.clock.advance(181)
    world.tick_events()
    assert "vietnam:stage" in world.grants(parent)
    parent.x,parent.z=local_to_world("vietnam",5,-12)
    event.actions["respect"]={a.id,b.id}
    world.clock.advance(120)
    world.tick_events()
    assert "vietnam:stage" not in world.grants(parent)
    assert walkable(parent.x,parent.z,world.grants(parent))


def test_public_link_never_grants_priority_and_stale_links_cannot_revive(world):
    a,b,event = couple(world)
    slug,event_id=event.slug,event.id
    visitor=world.create_guest("Public Visitor",slug=slug)
    assert (visitor.x,visitor.z)==public_point("vietnam")
    assert not world.grants(visitor) and visitor.id not in event.members
    world.finalize(event,"CANCELLED","Cancelled")
    with pytest.raises(RuleError):world.create_guest("Late Visitor",slug=slug)
    for kind in ["watch","ready","answer_role","ceremony_action"]:
        with pytest.raises(RuleError):world.command(a,kind,{"eventId":event_id,"accept":True})
    assert not world.weddings and not world.slugs


def test_late_arrival_and_reconnect_preserve_current_phase(world):
    a,b,event=active_couple(world)
    world.clock.advance(70);world.tick_events()
    visitor=guest(world)
    world.command(visitor,"watch",{"eventId":event.id})
    state=world.state_for(visitor)
    assert state["viewing"]["phase"]["id"]=="gifts"
    started=event.started_at
    world.disconnect(a);world.clock.advance(20);world.tick_events();world.connect(a.token)
    assert event.started_at==started and event.state=="CEREMONY_ACTIVE"
    assert world.state_for(a)["wedding"]["phase"]["id"]=="gifts"
    assert len([g for g in world.guests if g==a.id])==1


def test_active_disconnect_is_bounded_and_never_awards_completion(world):
    a,b,event=active_couple(world)
    world.disconnect(a);world.clock.advance(46);world.tick_events()
    assert event.id not in world.weddings
    assert not any(n.message["type"]=="completion" for n in world.notifications)
    assert a.id in world.guests and b.id in world.guests


def test_optional_family_absence_does_not_block_required_couple_actions(world):
    a,b,event=active_couple(world)
    world.clock.advance(60);world.tick_events()
    for player in (a,b):world.command(player,"ceremony_action",{"eventId":event.id,"phaseId":"gifts"})
    world.clock.advance(120);world.tick_events()
    assert event.state=="CEREMONY_ACTIVE"
    with pytest.raises(RuleError):world.command(a,"ceremony_action",{"eventId":event.id,"phaseId":"gifts"})


@pytest.mark.parametrize("district",list(DISTRICTS))
def test_completion_issues_verifiable_evidence_and_deletes_all_event_state(world,district):
    a,b,event=active_couple(world,district)
    visitor=guest(world)
    world.watch(visitor,event)
    event_id,slug=event.id,event.slug
    for phase in DISTRICTS[district]["program"]:
        if phase.get("required"):
            for player in (a,b):world.command(player,"ceremony_action",{"eventId":event_id,"phaseId":phase["id"]})
        world.clock.advance(phase["duration"])
        world.tick_events()
    assert not world.weddings and not world.slugs and not world.queues[district]
    assert world.venues[district].wedding_id is None and world.venues[district].available_at==world.now()+60
    assert a.wedding_id is None and b.wedding_id is None
    assert not event.members and not event.actions and not event.viewers and not event.overflow
    assert world.resolve(slug) is None
    assert walkable(a.x,a.z) and walkable(b.x,b.z)
    messages=[n.message for n in world.notifications if n.message["type"]=="completion"]
    assert len(messages)==2
    evidence=messages[0]["evidence"]
    key=Ed25519PublicKey.from_public_bytes(base64.b64decode(evidence["publicKey"]))
    key.verify(base64.b64decode(evidence["signature"]),evidence["canonical"].encode())
    assert json.loads(evidence["canonical"])==evidence["payload"]
    assert evidence["payload"]["couple"]==["Lan Nguyễn","Minh Trần"]
    assert evidence["payload"]["disclaimer"]==DISCLAIMER
    with pytest.raises(InvalidSignature):key.verify(base64.b64decode(evidence["signature"]),(evidence["canonical"]+" ").encode())
    assert event_id not in json.dumps(world.coordination_state())


def test_skipped_action_cancels_instead_of_shortening_or_awarding(world):
    a,b,event=active_couple(world)
    with pytest.raises(RuleError):world.finalize(event,"COMPLETED","Forged")
    world.clock.advance(ceremony_duration("vietnam"));world.tick_events()
    assert not world.weddings
    assert not any(n.message["type"]=="completion" for n in world.notifications)


def test_revoked_privileges_evict_to_connected_public_circulation(world):
    a,b,event=couple(world)
    member=guest(world)
    world.invite_role(a,{"eventId":event.id,"code":member.code,"role":"friend","side":0})
    world.command(member,"answer_role",{"eventId":event.id,"accept":True})
    world.tick_events();world.tick_events()
    member.x,member.z=local_to_world("vietnam",-6,0)
    world.command(a,"remove_role",{"eventId":event.id,"guestId":member.id})
    assert walkable(member.x,member.z) and not area_at(member.x,member.z)


def test_cooldowns_and_protected_area_effects(world):
    a,b,event=active_couple(world)
    with pytest.raises(RuleError,match="public garden"):
        world.command(a,"emote",{"emote":"petals"})
    world.command(a,"emote",{"emote":"bow"})
    with pytest.raises(RuleError,match="moment"):
        world.command(a,"emote",{"emote":"bow"})


@pytest.mark.parametrize("district",list(DISTRICTS))
def test_procession_and_distinct_reception_activity(world,district):
    a,b,event=active_couple(world,district)
    first=DISTRICTS[district]["program"][0]
    for _ in range(12):
        world.clock.advance(first["duration"]/12)
        world.tick_events()
        assert all(walkable(g.x,g.z,world.grants(g)) for g in (a,b))
    assert abs(world_to_local(district,a.x,a.z)[1]+17)<.01
    with pytest.raises(RuleError,match="reception"):
        world.command(a,"reception_activity",{})
    a.x,a.z=local_to_world(district,*MAP["reception"])
    world.command(a,"reception_activity",{})
    assert a.emote=={"vietnam":"toast","japan":"flower","korea":"blessing","india":"dance","italy":"favor"}[district]
    with pytest.raises(RuleError,match="moment"):
        world.command(a,"reception_activity",{})


def test_india_seven_steps_have_authoritative_motion(world):
    a,b,event=active_couple(world,"india")
    for phase in DISTRICTS["india"]["program"][:3]:
        if phase["required"]:
            for g in (a,b):world.command(g,"ceremony_action",{"eventId":event.id,"phaseId":phase["id"]})
        world.clock.advance(phase["duration"])
        world.tick_events()
    for g in (a,b):world.command(g,"ceremony_action",{"eventId":event.id,"phaseId":"steps"})
    for step in range(1,8):
        world.clock.advance(3)
        world.tick_events()
        assert abs(world_to_local("india",a.x,a.z)[1]-(-17-step))<.01
        assert walkable(a.x,a.z,world.grants(a))


def test_overflow_view_follows_the_original_event(world):
    _,_,event=active_couple(world)
    world.venues["vietnam"].audience_limit=1
    one,two=guest(world),guest(world)
    assert world.watch(one,event)["overflow"] is False
    assert world.watch(two,event)["overflow"] is True
    assert world.state_for(two)["viewing"]["id"]==event.id
    assert len(world.weddings)==1


def test_remote_spectators_receive_the_live_couple_without_moving(world):
    a,b,event=active_couple(world,"india")
    viewer=guest(world,"Remote Viewer")
    viewer.x,viewer.z=0,24
    before=(viewer.x,viewer.z)
    world.watch(viewer,event)
    grid=InterestGrid(world.guests.values())
    assert a not in grid.nearby(viewer)
    visible=GameServer(world).visible(viewer,grid)
    assert all(player in visible for player in (viewer,a,b))
    assert len(visible)<=96 and (viewer.x,viewer.z)==before


def test_nickname_validation_and_bounded_session_expiry(world):
    for nickname in ["x","a"*25,"A\nB","A\u202eB"]:
        with pytest.raises(RuleError):world.create_guest(nickname)
    a,b=guest(world),guest(world)
    world.disconnect(a);world.clock.advance(121);world.tick_events()
    assert a.id not in world.guests and a.token not in world.tokens and b.id in world.guests


def test_binary_protocol_sequence_and_forged_inputs(world):
    a=guest(world)
    assert decode_input(INPUT.pack(1,1,5,.5,0,1.3))==pytest.approx((5,.5,0,1.3))
    for data in [b'broken',INPUT.pack(1,1,5,float('nan'),0,0),INPUT.pack(1,1,5,50,0,0),INPUT.pack(2,1,5,0,0,0)]:
        with pytest.raises(RuleError):decode_input(data)
    world.input(a,5,1,0,0);world.input(a,4,-1,0,0)
    assert a.dx==1 and a.input_seq==5
    world.simulate(.05)
    binary=snapshot(8,world.now(),[a])
    assert len(binary)==HEADER.size+PLAYER.size
    assert newer(0,2**32-1) and not newer(8,9)


def test_interest_management_always_includes_self_and_is_bounded(world):
    players=[guest(world) for _ in range(110)]
    for player in players:player.x=player.z=10
    visible=InterestGrid(players).nearby(players[-1])
    assert len(visible)==96 and players[-1] in visible
    players[0].x=240;players[0].z=240
    assert players[0] not in InterestGrid(players).nearby(players[-1])


def test_backpressure_replaces_movement_and_bounds_controls():
    peer=Peer(None)
    for i in range(500):peer.state(str(i).encode())
    assert peer.latest==b'499'
    for i in range(40):peer.send({"type":"notice","message":str(i)})
    assert peer.closed and len(peer.controls)==32


def test_all_public_areas_reachable_without_crossing_restricted_space():
    step=2
    start=(-10,3)
    queue=deque([start]);seen={start}
    targets=[]
    for district in DISTRICTS:
        for point in [(0,29),tuple(MAP["viewing"]),(-30,-36),(30,-36),(26,-31),(0,40)]:
            x,z=local_to_world(district,*point);targets.append((round(x/step),round(z/step)))
    while queue:
        x,z=queue.popleft()
        for dx,dz in [(1,0),(-1,0),(0,1),(0,-1)]:
            p=(x+dx,z+dz)
            if p in seen or abs(p[0])>140 or abs(p[1])>140:continue
            if walkable(p[0]*step,p[1]*step):seen.add(p);queue.append(p)
    assert all(target in seen for target in targets)
    for a,b,width in PATHS:
        for i in range(101):
            x=a[0]+(b[0]-a[0])*i/100;z=a[1]+(b[1]-a[1])*i/100
            if math.hypot(x,z)>6:assert walkable(x,z), (x,z)
