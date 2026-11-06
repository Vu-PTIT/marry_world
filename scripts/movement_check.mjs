import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try {
  const {LocalMovement,SnapshotTrack}=await server.ssrLoadModule('/src/movement.ts');
  const {ServerClock}=await server.ssrLoadModule('/src/server-clock.ts');
  const {move,walkable,clearWalk,findPath,districts,toWorld,worldMap}=await server.ssrLoadModule('/src/map.ts');
  const publicAccess=new Set();
  let cases=0;
  {
    const clock=new ServerClock();clock.observe(1000,0);let previous=1000;
    for(let frame=1;frame<=3600;frame++){
      const now=frame/60;
      if(frame%30===0)clock.observe(1000+now-(frame%90===0?.11:.003),now);
      const time=clock.now(now),delta=time-previous;
      assert(delta>0&&Math.abs(delta-1/60)<.00018,'Delayed metadata cannot jerk or reverse the render clock');
      previous=time;
    }
    clock.observe(1300,61);assert.equal(clock.now(61),1300,'Large authority clock advances resynchronize');cases++;
  }
  for(const fps of [30,60,120])for(const delay of [0,.12]){
    const local=new LocalMovement();local.reset([0,25]);
    let authority=[0,25],tick=0,queue=[],speeds=[],previous=local.position;
    for(let frame=1;frame<=fps*3;frame++){
      const now=frame/fps,dt=1/fps;
      while((tick+1)*.05<=now+.00001){
        authority=move(...authority,0,-1,.05,publicAccess);tick++;
        if(tick%2===0)queue.push({time:tick*.05,position:[...authority],arrival:tick*.05+delay+(tick%6)*.004});
      }
      while(queue.length&&queue[0].arrival<=now){const p=queue.shift();local.reconcile(p.position,p.time,now,publicAccess);}
      const next=local.step([0,-1],dt,now,publicAccess);
      if(frame>fps*.7)speeds.push(Math.hypot(next[0]-previous[0],next[1]-previous[1])/dt);
      previous=[...next];
    }
    const mean=speeds.reduce((a,b)=>a+b)/speeds.length;
    const std=Math.sqrt(speeds.reduce((a,b)=>a+(b-mean)**2,0)/speeds.length);
    assert(Math.abs(mean-4.5)<.035&&std<.06,`fps=${fps} delay=${delay}: ${mean} ± ${std}`);
    assert(Math.hypot(local.position[0]-authority[0],local.position[1]-authority[1])<.18);
    cases++;
  }
  {
    const local=new LocalMovement();local.reset([0,7]);
    for(let i=0;i<120;i++)local.step([0,-1],1/60,i/60,publicAccess);
    assert(walkable(...local.position,publicAccess)&&local.position[1]>=5.44,'Prediction respects fountain collision');
    local.reset(worldMap.registrar);
    const regDir = [-0.479, -0.878];
    for (let i = 0; i < 60; i++) local.step(regDir, 1/60, i/60, publicAccess);
    assert(walkable(...local.position, publicAccess) && Math.hypot(local.position[0] - (-21.05), local.position[1] - 4.07) >= 2.03, 'Prediction blocks player from clipping into registrar desk');
    assert(local.reconcile([12,12],4,4,publicAccess),'Teleports reset without travelling across the map');
    assert.deepEqual(local.position,[12,12]);
    local.reconcile([25,25],3.9,4,publicAccess);
    assert.deepEqual(local.position,[12,12],'Stale snapshots cannot undo a teleport');
    for(const d of districts){
      const start=toWorld(d,0,24),access=new Set([`${d.id}:procession`,`${d.id}:aisle`,`${d.id}:stage`]);
      local.reset(start);
      const direction=[Math.sin(d.rotation)*-1,Math.cos(d.rotation)*-1];
      for(let i=0;i<180;i++)local.step(direction,1/60,i/60,publicAccess);
      assert(walkable(...local.position,publicAccess),`${d.id} locked area`);
      const stopped=[...local.position];
      local.reset(start);for(let i=0;i<180;i++)local.step(direction,1/60,i/60,access);
      assert(walkable(...local.position,access),`${d.id} granted area`);
      assert(Math.hypot(local.position[0]-stopped[0],local.position[1]-stopped[1])>8,'Granted procession access allows the actual route');
      local.reset(toWorld(d,0,-17));
      for(let i=0;i<180;i++)local.step(direction,1/60,i/60,access);
      const [lx,lz]=toLocal(d,...local.position);
      assert(walkable(...local.position,access)&&lz>=-25.0,'Player is physically blocked by the ceremonial altar table');
    }
    cases++;
  }
  {
    const local=new LocalMovement();local.reset([15,18]);
    const timeline=t=>t<.8?[0,-1]:t<1.5?[1,0]:[0,0];
    let authority=[15,18],tick=0,queue=[];
    for(let i=1;i<=180;i++){
      const now=i/60;
      while((tick+1)*.05<=now+.00001){
        authority=move(...authority,...timeline(tick*.05),.05,publicAccess);tick++;
        if(tick%2===0)queue.push({time:tick*.05,arrival:tick*.05+.1,position:[...authority]});
      }
      while(queue.length&&queue[0].arrival<=now){const s=queue.shift();local.reconcile(s.position,s.time,now,publicAccess);}
      local.step(timeline(now-1/60),1/60,now,publicAccess);
    }
    assert(Math.hypot(local.position[0]-authority[0],local.position[1]-authority[1])<.025,'A turn and stop converge to authority under latency');
    cases++;
  }
  {
    const track=new SnapshotTrack();
    for(let i=0;i<=10;i++)track.push({time:i*.1,x:i*.45,z:2,yaw:i%2?Math.PI-.01:-Math.PI+.01});
    for(let t=.25;t<=1.1;t+=1/120){const p=track.sample(t);assert(Math.abs(p.x-(t-.15)*4.5)<1e-8);assert(Math.abs(Math.abs(p.yaw)-Math.PI)<.011);}
    assert.equal(track.sample(10).x,4.5,'No unbounded extrapolation through walls');
    track.push({time:1.2,x:30,z:30,yaw:0});assert.equal(track.sample(1.2).x,30,'Remote teleport flushes interpolation');
    track.push({time:1.1,x:0,z:0,yaw:0});assert.equal(track.sample(1.3).x,30);
    cases++;
  }
  {
    const start=[0,25],targets=[worldMap.registrar,...districts.map(d=>toWorld(d,0,29))];
    for(const target of targets){
      const route=findPath(start,target,publicAccess);assert(route.length,'Public destination remains reachable');
      let previous=start;
      for(const point of route){assert(clearWalk(previous,point,publicAccess),'Every shortened segment respects collision/access');previous=point;}
      assert.deepEqual(route.at(-1),target);
      assert(route.length<20,'Routes retain actual corners instead of every A* grid cell');
    }
    const direct=findPath([10,20],[10,25],publicAccess);assert.equal(direct.length,1);
    assert(!clearWalk([0,15],[0,-15],publicAccess),'Route cannot cut through the fountain');
    cases++;
  }
  console.log(`Passed ${cases} movement groups: 30/60/120 FPS, delayed/jittered authority, collisions, access, teleports, remote interpolation and six public routes.`);
} finally {await server.close();}
