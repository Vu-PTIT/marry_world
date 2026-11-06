"""Verify outfit selection, replication, animation bounds, and botanical silhouettes."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from scripts.browser_check import browser_options

OUT = Path('artifacts/appearance'); OUT.mkdir(parents=True, exist_ok=True)


def main():
    errors, results = [], {}
    with sync_playwright() as p:
        options = browser_options(); options['args'] = ['--enable-unsafe-swiftshader']
        browser = p.chromium.launch(**options)
        for mobile in [False, True]:
            label = 'mobile' if mobile else 'desktop'
            context = browser.new_context(viewport={'width': 390 if mobile else 1440, 'height': 844 if mobile else 900}, is_mobile=mobile, has_touch=mobile)
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto('http://127.0.0.1:5173', wait_until='networkidle')
            page.wait_for_selector('#world-loading', state='detached')
            page.wait_for_function("__ww.ui.guestPreview.guest.gender==='female'")
            page.screenshot(path=str(OUT / f'{label}-entry.png'), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            for button in page.locator('[data-action="gender"], .avatar-color').all():
                bounds = button.bounding_box(); assert bounds['height'] >= 44 and bounds['width'] >= 44, bounds
            page.locator('[data-gender="male"]').click()
            assert page.locator('#clothing-color').input_value() == '#405366'
            page.locator('#clothing-color').fill('#647b91')
            page.locator('[data-gender="female"]').click()
            assert page.locator('#clothing-color').input_value() == '#647b91'
            assert page.locator('.avatar-color[aria-pressed=true]').count() == 0
            if mobile:
                page.get_by_role('button', name='Rose avatar', exact=True).click()
                gender, color = 'female', '#bb626f'
            else:
                page.locator('[data-gender="male"]').click()
                gender, color = 'male', '#647b91'
            page.locator('#nickname').fill(f'{label} Outfit')
            page.locator('#enter-button').click()
            page.wait_for_selector('.in-world .game-header')
            page.wait_for_function('__ww.scene.avatars.has(__ww.connection.id)')
            page.wait_for_timeout(700)
            state = page.evaluate('''()=>{const m=__ww.scene.avatars.get(__ww.connection.id).model;return {gender:m.gender,color:m.clothingColor,source:m.source,self:__ww.connection.state.self};}''')
            assert state['gender'] == gender and state['color'] == color and state['source'] == 'glb', state
            assert state['self']['gender'] == gender and state['self']['clothingColor'] == color
            page.reload(wait_until='networkidle')
            page.wait_for_selector('.in-world .game-header')
            page.wait_for_function('__ww.scene.avatars.has(__ww.connection.id)')
            assert page.evaluate('__ww.scene.avatars.get(__ww.connection.id).model.gender') == gender
            page.wait_for_timeout(600)
            assert page.evaluate('__ww.scene.avatars.get(__ww.connection.id).model.clothingColor') == color
            page.screenshot(path=str(OUT / f'{label}-world.png'))
            results[label] = {'gender': gender, 'color': color, 'reconnect': True}
            if not mobile:
                # A second real guest sees the first guest's selected outfit through metadata.
                peer_context = browser.new_context(viewport={'width': 1000, 'height': 800})
                peer = peer_context.new_page();peer.on('pageerror', lambda e: errors.append(str(e)))
                peer.goto('http://127.0.0.1:5173', wait_until='networkidle')
                peer.wait_for_selector('#world-loading', state='detached')
                peer.locator('#nickname').fill('Appearance Observer');peer.locator('#enter-button').click()
                player_id = state['self']['id']
                peer.wait_for_function('(id)=>__ww.scene.avatars.get(id)?.model.clothingColor==="#647b91"', arg=player_id)
                assert peer.evaluate('(id)=>__ww.scene.avatars.get(id).model.gender', player_id) == 'male'
                peer_context.close();results['remoteReplication'] = True
                results['models'] = page.evaluate('''async()=>{
                  const THREE=await import('/node_modules/.vite/deps/three.js'),{GuestModel}=await import('/src/avatar-model.ts');
                  const result=[];
                  for(const gender of ['male','female']){
                    const a=new GuestModel(0,gender,'#bb626f'),b=new GuestModel(0,gender,'#405366'),v=new THREE.Vector3();
                    const skin=a.mesh.userData.colorRegions.find(r=>r.kind==='skin').start;
                    const before=a.mesh.geometry.getAttribute('color').getX(skin);a.setLook(0,'#77aa99');
                    if(before!==a.mesh.geometry.getAttribute('color').getX(skin))throw Error('Clothing changed skin');
                    if(a.bones.Chest===b.bones.Chest||a.mesh.geometry===b.mesh.geometry)throw Error('Shared mutable avatar');
                    let maximum=0;
                    for(const action of Object.values(a.actions)){
                      a.mixer.stopAllAction();action.reset().play();
                      for(const fraction of [0,.25,.5,.75,.99]){
                        a.mixer.setTime(action.getClip().duration*fraction);a.root.updateMatrixWorld(true);a.mesh.skeleton.update();
                        for(let i=0;i<a.mesh.geometry.getAttribute('position').count;i++){a.mesh.getVertexPosition(i,v);maximum=Math.max(maximum,v.distanceTo(a.mesh.boundingSphere.center));}
                      }
                    }
                    if(maximum>a.mesh.boundingSphere.radius)throw Error('Clipped animated outfit');
                    result.push({gender,triangles:a.mesh.geometry.getAttribute('position').count/3,animatedRadius:maximum,bounds:a.mesh.boundingSphere.radius});
                    a.dispose();b.dispose();a.mesh.geometry.dispose();b.mesh.geometry.dispose();
                  }
                  return result;
                }''')
                # Inspection scene uses the actual game models, lights, and renderer.
                page.evaluate('''async()=>{
                  const THREE=await import('/node_modules/.vite/deps/three.js'),{GuestModel}=await import('/src/avatar-model.ts');const s=__ww.scene;
                  s.renderer.setAnimationLoop(null);document.querySelector('#app').classList.add('photo-mode');
                  document.querySelector('.game-hud').hidden=true;
                  const scene=new THREE.Scene();scene.background=new THREE.Color('#eadfd8');
                  scene.add(new THREE.HemisphereLight('#fff7ef','#b7b49e',2.25));const light=new THREE.DirectionalLight('#fff0e2',2.2);light.position.set(-2,4,4);scene.add(light);
                  for(const [i,gender]of ['female','male'].entries()){const a=new GuestModel(0,gender,i?'#405366':'#bb626f');a.root.position.x=(i-.5)*1.6;a.root.rotation.y=-.13;a.animate(.3,0,'');scene.add(a.root);}
                  const camera=new THREE.PerspectiveCamera(32,1440/900,.1,30);camera.position.set(0,1.5,6.2);camera.lookAt(0,1.06,0);s.renderer.render(scene,camera);
                }''')
                page.screenshot(path=str(OUT / 'outfit-models.png'))
                page.evaluate('''async()=>{
                  const THREE=await import('/node_modules/.vite/deps/three.js');const s=__ww.scene,scene=new THREE.Scene();scene.background=new THREE.Color('#eadfd8');
                  scene.add(new THREE.HemisphereLight('#fff7ef','#b7b49e',2.25));const light=new THREE.DirectionalLight('#fff0e2',2.2);light.position.set(-20,30,30);scene.add(light);
                  const kinds=['palm','bamboo','blossom','pine','ginkgo','gulmohar','cypress','olive','magnolia'];
                  const colors=['#659261','#659261','#e4aebd','#526f60','#d1bd75','#cb7560','#486653','#84947b','#597f68'];
                  kinds.forEach((kind,i)=>s.tree(scene,(i%5-2)*7,Math.floor(i/5)*10,5,colors[i],kind));
                  const camera=new THREE.PerspectiveCamera(40,1440/900,.1,100);camera.position.set(0,21,40);camera.lookAt(0,2.5,4);s.renderer.render(scene,camera);
                }''')
                page.screenshot(path=str(OUT / 'tree-models.png'))
            context.close()
        browser.close()
    assert not errors, errors
    report = {'passed': True, 'checks': results, 'browserErrors': errors, 'limit': 'Mobile viewport emulation on laptop GPU.'}
    (OUT / 'checks.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
