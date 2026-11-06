import asyncio
import json
import secrets
import threading

import pytest
from fakeredis import TcpFakeServer

from backend.app.coordination import Coordination
from backend.app.main import GameServer
from backend.app.map import local_to_world
from backend.app.zones import Handoff, ZonePool
from .conftest import active_couple, couple, guest


@pytest.fixture
def redis_url():
    server = TcpFakeServer(("127.0.0.1", 0), server_type="redis")
    server.daemon_threads = True
    server.block_on_close = False
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"redis://127.0.0.1:{server.server_address[1]}/0"
    server.shutdown();server.server_close();thread.join(timeout=2)


async def test_atomic_leader_and_stale_owner_fencing(redis_url, world):
    prefix=f"test-{secrets.token_hex(5)}"
    one,two=Coordination(redis_url,prefix),Coordination(redis_url,prefix)
    await one.start()
    with pytest.raises(RuntimeError,match="authoritative"):
        await two.start()
    a,b,event=couple(world)
    await one.save(world.coordination_state())
    assert event.id in json.loads(await one.redis.get(one.keys[1]))["events"]
    world.finalize(event,"CANCELLED","Cancelled")
    await one.save(world.coordination_state())
    assert not json.loads(await one.redis.get(one.keys[1]))["events"]
    assert 0 < await one.redis.ttl(one.keys[1]) <= 180
    await one.redis.delete(one.keys[0])
    await two.start()
    with pytest.raises(RuntimeError,match="ownership"):
        await one.save(world.coordination_state())
    assert two.epoch>one.epoch
    await one.close();await two.close()


async def test_stale_persist_cannot_recreate_deleted_event(redis_url,world):
    coord=Coordination(redis_url,f"test-{secrets.token_hex(5)}")
    await coord.start()
    _,_,event=couple(world)
    stale=json.loads(json.dumps(world.coordination_state()))
    world.finalize(event,"CANCELLED","Cancelled")
    await coord.save(world.coordination_state())
    await coord.save(stale)
    current=json.loads(await coord.redis.get(coord.keys[1]))
    assert not current["events"] and not current["invitations"]
    await coord.close()


async def test_cleanup_during_async_save_is_flushed_before_returning(world):
    _,_,event=couple(world)
    game=GameServer(world)
    entered,resume=asyncio.Event(),asyncio.Event()
    writes=[]
    async def delayed_save(state):
        writes.append(json.loads(json.dumps(state)))
        if len(writes)==1:
            entered.set();await resume.wait()
    game.coordination.save=delayed_save
    pending=asyncio.create_task(game.flush())
    await entered.wait()
    world.finalize(event,"CANCELLED","Cancelled")
    resume.set();await pending
    assert len(writes)==2 and not writes[-1]["events"]
    assert game.saved_revision==world.revision


async def test_real_process_ownership_handoff_and_interruption_recovery(redis_url,world):
    prefix=f"zones-{secrets.token_hex(5)}"
    coord=Coordination(redis_url,prefix)
    await coord.start()
    pool=ZonePool(redis_url,prefix,coord.epoch,coord.token)
    await pool.start()
    try:
        assert len({w.pid for w in pool.workers.values()})==6
        import os
        assert all(w.pid != os.getpid() for w in pool.workers.values())
        player,partner,event=active_couple(world,"japan")
        world.clock.advance(60);world.tick_events()
        player.x,player.z=-12,18
        player.revision+=1
        host,_,other=couple(world,"vietnam")
        world.invite_role(host,{"eventId":other.id,"code":player.code,"role":"friend","side":0})
        world.command(player,"answer_role",{"eventId":other.id,"accept":True})
        await pool.register(player)
        assert pool.routes[player.id][0]=="plaza"
        before=(player.token,player.code,player.avatar,player.wedding_id,event.slug,event.phase_index,event.started_at,
                other.members[player.id].role,other.members[player.id].accepted)
        player.x,player.z=local_to_world("vietnam",0,29)
        player.revision+=1
        source="plaza";target="vietnam"
        handoff=Handoff(player.id,source,target,pool.workers[source].generation,pool.workers[target].generation,
                        "interrupted-transfer",pool.record(player))
        pool.pending[player.id]=handoff
        with pytest.raises(ConnectionError):
            await pool.transfer(handoff,interrupt_after_commit=True)
        assert await pool.redis.get(pool.presence_key(player.id))==f"vietnam:{pool.workers['vietnam'].generation}"
        await pool.step(world,.05)
        assert not pool.pending and pool.routes[player.id][0]=="vietnam"
        source_state=await pool.rpc(source,"inspect")
        target_state=await pool.rpc(target,"inspect")
        assert player.id not in source_state["active"] and target_state["active"].count(player.id)==1
        assert before==(player.token,player.code,player.avatar,player.wedding_id,event.slug,event.phase_index,event.started_at,
                        other.members[player.id].role,other.members[player.id].accepted)
        world.input(player,1,0,1,0)
        old=(player.x,player.z)
        await pool.step(world,.05)
        assert (player.x,player.z)!=old
        assert player.ack_seq==1
        await coord.renew()
    finally:
        await pool.close();await coord.close()
