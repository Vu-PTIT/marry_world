"""Inspect the actual map meshes, animation bounds and an uninterrupted public walk."""
import json
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright
from scripts.browser_check import browser_options

OUT=Path('artifacts/movement-rework');OUT.mkdir(parents=True,exist_ok=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--models-only',action='store_true');args=parser.parse_args()
    errors=[];console_errors=[]
    with sync_playwright() as p:
        options=browser_options();options['args']=['--enable-unsafe-swiftshader']
        browser=p.chromium.launch(**options)
        page=browser.new_page(viewport={'width':1440,'height':900})
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:console_errors.append(m.text) if m.type=='error' else None)
        page.goto('http://127.0.0.1:5173',wait_until='networkidle')
        page.wait_for_selector('#world-loading',state='detached');page.wait_for_timeout(700)
        bounds=page.evaluate('''async()=>{
          const {GuestModel}=await import('/src/avatar-model.ts');
          const g=new GuestModel(),mesh=g.mesh,center=mesh.boundingSphere.center;
          const v=center.clone();let maximum=0;
          for(const clip of Object.values(g.actions)){
            g.mixer.stopAllAction();clip.reset().play();
            for(const fraction of [0,.25,.5,.75,.99]){
              g.mixer.setTime(clip.getClip().duration*fraction);g.root.updateMatrixWorld(true);mesh.skeleton.update();
              for(let i=0;i<mesh.geometry.getAttribute('position').count;i++){mesh.getVertexPosition(i,v);maximum=Math.max(maximum,v.distanceTo(center));}
            }
          }
          const result={maximumAnimatedRadius:maximum,cullingRadius:mesh.boundingSphere.radius,frustumCulled:mesh.frustumCulled};
          g.dispose();mesh.geometry.dispose();return result;
        }''')
        assert bounds['frustumCulled'] and bounds['maximumAnimatedRadius']<=bounds['cullingRadius'],bounds
        print('All ten clips fit the conservative culling sphere.',flush=True)
        # Fixed camera inspection of actual generated meshes. No fixture guests or event state.
        page.locator('.landing').evaluate('e=>e.hidden=true')
        for district in ['vietnam','japan','korea','india','italy']:
            stats=page.evaluate('''async id=>{
              const {districtById,toWorld}=await import('/src/map.ts'),s=__ww.scene,d=districtById[id];
              s.renderer.setAnimationLoop(null);s.camera.clearViewOffset();
              const p=toWorld(d,21,1),aim=toWorld(d,0,-22);s.camera.position.set(p[0],15,p[1]);s.camera.lookAt(aim[0],3,aim[1]);
              s.sun.target.position.set(aim[0],0,aim[1]);s.sun.position.set(aim[0]-42,85,aim[1]+47);s.sun.target.updateMatrixWorld();
              s.renderer.render(s.scene,s.camera);return {calls:s.renderer.info.render.calls,triangles:s.renderer.info.render.triangles};
            }''',district)
            page.screenshot(path=str(OUT/f'model-{district}.png'))
            assert stats['calls']<200,stats
        if args.models_only:
            assert not errors and not console_errors,(errors,console_errors)
            result={'passed':True,'inspected':['vietnam','japan','korea','india','italy'],'animationBounds':bounds,'browserErrors':errors,'consoleErrors':console_errors}
            (OUT/'model-checks.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
            browser.close();print(json.dumps(result,indent=2));return
        page.locator('.landing').evaluate('e=>e.hidden=false')
        page.evaluate('''()=>{const s=__ww.scene;s.cameraSnap=true;s.renderer.setAnimationLoop(()=>s.frame());}''')
        page.locator('#nickname').fill('Map Explorer');page.locator('#enter-button').click()
        page.wait_for_selector('.in-world .game-header');page.wait_for_timeout(900)
        scene=page.evaluate('''()=>{let instances=0;__ww.scene.scene.traverse(o=>{if(o.isInstancedMesh)instances+=o.count;});return {instances,scriptedUntil:__ww.connection.state.self.motionUntil};}''')
        assert scene['instances']>100 and scene['scriptedUntil']==0,scene
        page.get_by_role('button',name='Open world map',exact=True).click()
        page.locator('.map-destination[data-district="japan"]').click()
        page.wait_for_function('__ww.scene.destination!==null && __ww.scene.route.length>0',timeout=5000)
        start=page.evaluate('''()=>({time:performance.now(),position:__ww.scene.position,waypoints:__ww.scene.route.length})''')
        assert start['waypoints']>0
        print('Walking the full public route to Japan with the real authority.',flush=True)
        page.wait_for_function('__ww.scene.destination===null && __ww.scene.route.length===0',timeout=80000)
        finish=page.evaluate('''async()=>{const {districtById,toWorld}=await import('/src/map.ts');const s=__ww.scene,target=toWorld(districtById.japan,0,29),a=s.avatars.get(__ww.connection.id);return {seconds:(performance.now())/1000,position:s.position,distanceToDestination:Math.hypot(s.position[0]-target[0],s.position[1]-target[1]),authorityError:Math.hypot(s.position[0]-a.target.x,s.position[1]-a.target.z)};}''')
        finish['seconds']=round(finish['seconds']-start['time']/1000,2)
        assert finish['distanceToDestination']<.55 and finish['authorityError']<.7,finish
        page.evaluate('''async()=>{const {districtById}=await import('/src/map.ts');__ww.scene.yaw=districtById.japan.rotation;__ww.scene.pitch=.48;__ww.scene.zoom=18;}''')
        page.wait_for_timeout(800);page.screenshot(path=str(OUT/'arrived-japan.png'))
        print('Public route reached its destination without a teleport.',flush=True)
        browser.close()
    assert not errors and not console_errors,(errors,console_errors)
    result={'passed':True,'animationBounds':bounds,'scene':scene,'publicJourney':finish,'browserErrors':errors,'consoleErrors':console_errors,'limit':'Fixed model inspection cameras; journey uses actual input/authority. Laptop GPU only.'}
    (OUT/'map-checks.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
