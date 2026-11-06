"""Measure frame pacing and movement speed against the real local authority."""
import argparse
import json
import math
import statistics
from pathlib import Path
from playwright.sync_api import sync_playwright
from scripts.browser_check import browser_options


def percentile(values, p):
    return sorted(values)[min(len(values)-1, round((len(values)-1)*p))]


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--label',default='current')
    parser.add_argument('--delay-ms',type=int,default=0)
    args=parser.parse_args()
    out=Path('artifacts/movement-rework');out.mkdir(parents=True,exist_ok=True)
    results={};errors=[]
    with sync_playwright() as p:
        options=browser_options();options['args']=['--enable-unsafe-swiftshader']
        browser=p.chromium.launch(**options)
        for mobile in [False,True]:
            label='mobile' if mobile else 'desktop'
            context=browser.new_context(viewport={'width':390 if mobile else 1440,'height':844 if mobile else 900},is_mobile=mobile,has_touch=mobile,device_scale_factor=1)
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto('http://127.0.0.1:5173',wait_until='networkidle')
            page.locator('#nickname').fill('Movement Profile');page.locator('#enter-button').click()
            page.wait_for_selector('.in-world .game-header');page.wait_for_timeout(1800)
            page.evaluate('''delay => {
              const s=__ww.scene,c=__ww.connection;
              s.yaw=Math.atan2(s.position[0],s.position[1]);
              if(delay){const socket=c.socket,receive=socket.onmessage;
                socket.onmessage=e=>setTimeout(()=>receive.call(socket,e),delay);}
              window.motionFrames=[];window.motionCorrections=[];window.motionDrifts=[];
              const original=s.snapshot.bind(s);
              s.snapshot=data=>{const previous=s.predicted.slice();original(data);
                motionCorrections.push(Math.hypot(s.predicted[0]-previous[0],s.predicted[1]-previous[1]));
                motionDrifts.push(Math.hypot(...s.movement.correction));};
              window.profiling=true;let previous=performance.now();
              function sample(t){if(!profiling)return;const a=s.avatars.get(c.id);
                motionFrames.push({t,dt:(t-previous)/1000,x:s.position[0],z:s.position[1],px:s.predicted[0],pz:s.predicted[1],clip:a.model.current});previous=t;requestAnimationFrame(sample);}
              requestAnimationFrame(sample);
            }''',args.delay_ms)
            page.locator('.world-canvas').focus()
            if mobile:
                # Test the same continuous-input path using the visible movement pad.
                pad=page.locator('#joystick').bounding_box();x=pad['x']+pad['width']/2;y=pad['y']+pad['height']/2
                session=context.new_cdp_session(page)
                session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':1}]})
                session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y-32,'id':1}]})
            else:page.keyboard.down('w')
            page.wait_for_timeout(3500)
            trace=page.evaluate('''() => {profiling=false;const s=__ww.scene,r=s.renderer,g=r.getContext();return {frames:motionFrames,corrections:motionCorrections,drifts:motionDrifts,render:{calls:r.info.render.calls,triangles:r.info.render.triangles,renderer:g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)}};}''')
            if mobile:session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            else:page.keyboard.up('w')
            frames=trace['frames'];start=frames[0]['t'];speeds=[];times=[];predicted_steps=[]
            for a,b in zip(frames,frames[1:]):
                if b['t']-start<700 or b['dt']<=0:continue
                speeds.append(math.hypot(b['x']-a['x'],b['z']-a['z'])/b['dt'])
                times.append(b['dt']*1000)
                predicted_steps.append(math.hypot(b['px']-a['px'],b['pz']-a['pz']))
            results[label]={'frames':len(speeds),'frameP95Ms':round(percentile(times,.95),2),'frameP99Ms':round(percentile(times,.99),2),
              'speedMean':round(statistics.mean(speeds),3),'speedStd':round(statistics.pstdev(speeds),3),'speedP05':round(percentile(speeds,.05),3),'speedP95':round(percentile(speeds,.95),3),
              'predictionStationaryFrames':sum(v<.0001 for v in predicted_steps),'snapshotSnapP95Meters':round(percentile(trace['corrections'],.95),4),'correctionTargetP95Meters':round(percentile(trace['drifts'],.95),4),'render':trace['render']}
            page.wait_for_timeout(350)
            page.screenshot(path=str(out/f'{args.label}-{label}.png'))
            (out/f'{args.label}-{label}-trace.json').write_text(json.dumps(trace),encoding='utf-8')
            context.close()
        browser.close()
    assert not errors,errors
    report={'delayMs':args.delay_ms,'devices':results,'browserErrors':errors,'limit':'Native laptop GPU; phone viewport emulation. Single moving guest, no crowd-capacity claim.'}
    (out/f'{args.label}.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
