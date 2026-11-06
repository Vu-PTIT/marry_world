"""Bounded synthetic WebSocket traffic, never a displayed real visitor count.

Default starts an isolated single-authority server on :8001, with no Redis.
Examples: python -m scripts.load_check --clients 20 --seconds 15
          python -m scripts.load_check --clients 100 --seconds 30
Use --url only against an authorized test environment with an appropriate
SESSION_RATE_LIMIT. This creates real temporary guest connections in that world.
"""
import argparse
import asyncio
import contextlib
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

import httpx
import psutil
from websockets.asyncio.client import connect

from backend.app.protocol import HEADER, INPUT, PLAYER

ROOT = Path(__file__).resolve().parents[1]


def percentile(values, proportion):
    return round(sorted(values)[min(len(values)-1, int(len(values)*proportion))],2) if values else None


async def run(args, process=None):
    url = args.url or "http://127.0.0.1:8001"
    ws_url = url.replace("http", "ws", 1) + "/ws"
    latencies,pings,failures = [],[],[]
    received,sent,snapshots,peak_visible = 0,0,0,0
    resources=[]
    cpu_previous={}
    ready = asyncio.Event()
    stop = asyncio.Event()
    connected = 0
    expected = args.clients
    limiter = asyncio.Semaphore(12)
    target = psutil.Process(process.pid) if process else None
    def measure_tree():
        rows=[]
        for item in [target,*target.children(recursive=True)]:
            with contextlib.suppress(psutil.NoSuchProcess,psutil.AccessDenied):
                cpu=item.cpu_times()
                rows.append((item.pid,cpu.user+cpu.system,item.memory_info().rss))
        return rows

    async def client(index,http):
        nonlocal connected,received,sent,snapshots,peak_visible,expected
        try:
            async with limiter:
                response = await http.post(url+"/api/guests",json={"nickname":f"Load guest {index:04d}","avatar":index%6})
                response.raise_for_status()
                session=response.json()
                socket = await connect(ws_url,origin="http://127.0.0.1:8000",max_size=65536,max_queue=8,
                    compression=None,open_timeout=15,ping_interval=10)
                hello=json.dumps({"v":1,"type":"hello","token":session['token']})
                await socket.send(hello)
                sent+=len(hello.encode())
                welcome=json.loads(await asyncio.wait_for(socket.recv(),10))
                assert welcome['type']=="welcome",welcome
            connected+=1
            if connected==expected:ready.set()
            seq=welcome['inputSequence']
            inputs={}
            pending_ping={}

            async def receive():
                nonlocal received,snapshots,peak_visible
                async for message in socket:
                    received+=len(message.encode() if isinstance(message,str) else message)
                    if isinstance(message,bytes):
                        _,_,_,_,count=HEADER.unpack_from(message)
                        snapshots+=1
                        peak_visible=max(peak_visible,count)
                        for i in range(count):
                            guest_id,_,_,_,ack,_,_=PLAYER.unpack_from(message,HEADER.size+i*PLAYER.size)
                            if guest_id==session['id'] and ack in inputs:
                                latencies.append((time.perf_counter()-inputs[ack])*1000)
                                inputs.clear()
                    else:
                        data=json.loads(message)
                        if data.get('type')=='command_ok' and data.get('id') in pending_ping:
                            pings.append((time.perf_counter()-pending_ping.pop(data['id']))*1000)
                        elif data.get('type') in {'command_error','server_unavailable','session_error'}:
                            failures.append({'client':index,'message':data.get('message',data['type'])})
            receiver=asyncio.create_task(receive())
            await ready.wait()
            start=time.perf_counter()
            next_ping=start+1
            while not stop.is_set():
                now=time.perf_counter()
                angle=(now-start)*.42+index*.628
                # Plausible normalized movement; the server still enforces paths and collisions.
                dx,dz=math.cos(angle),math.sin(angle)
                seq=(seq+1)%(2**32)
                packet=INPUT.pack(1,1,seq,dx,dz,math.atan2(dx,dz))
                inputs[seq]=now
                if len(inputs)>128:inputs.pop(next(iter(inputs)))
                await socket.send(packet)
                sent+=len(packet)
                if now>=next_ping:
                    ident=f'{index}-{seq}'
                    pending_ping[ident]=now
                    message=json.dumps({'v':1,'type':'ping','id':ident,'data':{}})
                    await socket.send(message)
                    sent+=len(message)
                    next_ping=now+3
                await asyncio.sleep(.04)
            await socket.close()
            await receiver
        except Exception as error:
            failures.append({'client':index,'message':type(error).__name__+': '+str(error)[:180]})
            expected-=1
            if connected>=expected:ready.set()

    async with httpx.AsyncClient(timeout=20,limits=httpx.Limits(max_connections=20)) as http:
        tasks=[asyncio.create_task(client(i,http)) for i in range(args.clients)]
        await asyncio.wait_for(ready.wait(),60)
        baseline=(await http.get(url+'/api/health')).json()
        start=time.perf_counter()
        if target:
            cpu_previous={pid:cpu for pid,cpu,_ in measure_tree()}
            previous_measurement=start
        samples=[]
        while time.perf_counter()-start<args.seconds:
            await asyncio.sleep(1)
            health=(await http.get(url+'/api/health')).json()
            samples.append(health)
            if target:
                tree=measure_tree()
                measured=time.perf_counter()
                cpu=sum(max(0,cpu-cpu_previous.get(pid,cpu)) for pid,cpu,_ in tree)
                resources.append({'cpuPercentOneCore':cpu/(measured-previous_measurement)*100,
                    'rssMiB':sum(rss for _,_,rss in tree)/2**20,'processCount':len(tree)})
                previous_measurement=measured
                cpu_previous={pid:cpu for pid,cpu,_ in tree}
        duration=time.perf_counter()-start
        stop.set()
        await asyncio.gather(*tasks,return_exceptions=True)
    report={
        'scenario':'synthetic moving WebSocket clients in an isolated plaza; no browser rendering',
        'mode':'one Python authority, temporary memory, no Redis',
        'requestedClients':args.clients,'connectedClients':connected,'seconds':round(duration,2),
        'ackLatencyMs':{'p50':percentile(latencies,.5),'p95':percentile(latencies,.95),'samples':len(latencies)},
        'controlRoundTripMs':{'p50':percentile(pings,.5),'p95':percentile(pings,.95),'samples':len(pings)},
        'tickWorkMs':{'p50':percentile([s['metrics']['tickMs'] for s in samples],.5),
                      'p95':percentile([s['metrics']['tickMs'] for s in samples],.95),
                      'maxSinceBoot':max(s['metrics']['maxTickMs'] for s in samples)},
        'measuredSimulationHz':round((samples[-1]['metrics']['tick']-baseline['metrics']['tick'])/duration,2),
        'payloadBytes':{'received':received,'sent':sent,'aggregateReceivedKiBPerSecond':round(received/duration/1024,2),
                        'excludes':'WebSocket/TCP/TLS overhead; includes connection warm-up'},
        'snapshotMessages':snapshots,'maxVisibleAvatars':peak_visible,
        'serverResources':{'meanCpuPercentOneCore':round(statistics.mean(r['cpuPercentOneCore'] for r in resources),2),
                           'peakRssMiB':round(max(r['rssMiB'] for r in resources),2),
                           'processCount':max(r['processCount'] for r in resources)} if resources else None,
        'hardware':{'os':platform.platform(),'cpu':platform.processor(),'logicalCpus':psutil.cpu_count(),
                     'physicalCpus':psutil.cpu_count(logical=False),'totalRamGiB':round(psutil.virtual_memory().total/2**30,2),
                     'python':platform.python_version()},
        'failures':failures,'passed':connected==args.clients and not failures and all(s['status']=='ok' for s in samples),
        'limits':'Loopback, short duration, local host also runs clients. Not WAN, soak, browser FPS, Redis, distributed capacity, or 100000-player proof.'}
    output=ROOT/'artifacts'/f'load-{args.clients}.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2),flush=True)
    return report['passed']


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--clients',type=int,default=20)
    parser.add_argument('--seconds',type=int,default=15)
    parser.add_argument('--url')
    args=parser.parse_args()
    if not 1<=args.clients<=2000 or not 5<=args.seconds<=3600:parser.error('Use 1..2000 clients and 5..3600 seconds.')
    process=None
    try:
        if not args.url:
            env={**os.environ,'REDIS_URL':'','REDIS_PREFIX':f'load-{os.getpid()}',
                 'WORLD_ZONE_WORKERS':'0','SESSION_RATE_LIMIT':str(args.clients*2),'MAX_GUESTS':str(args.clients+10)}
            process=subprocess.Popen([sys.executable,'-m','uvicorn','backend.app.main:app','--host','127.0.0.1','--port','8001',
                '--ws-max-size','8192','--ws-max-queue','16','--no-access-log','--log-level','warning'],cwd=ROOT,env=env)
            for _ in range(100):
                if process.poll() is not None:raise RuntimeError('Isolated load server exited; free port 8001 first.')
                with contextlib.suppress(httpx.TransportError):
                    if httpx.get('http://127.0.0.1:8001/api/health',timeout=1).status_code==200:break
                time.sleep(.1)
        passed=asyncio.run(run(args,process))
        if not passed:raise SystemExit(1)
    finally:
        if process:
            process.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):process.wait(timeout=10)


if __name__=='__main__':main()
