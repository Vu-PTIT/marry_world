"""Actual-browser checks for the model/UI upgrade; uses native GPU when available."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_check import browser_options, URL

OUT = Path(__file__).resolve().parents[1] / 'artifacts' / 'upgrade'
OUT.mkdir(parents=True, exist_ok=True)


def snapshot(page, name):
    page.screenshot(path=str(OUT / f'{name}.png'))


def position(page):
    return page.evaluate('window.__ww.scene.position.slice()')


def distance(a, b):
    return sum((x-y)**2 for x, y in zip(a, b))**.5


def main():
    errors, results = [], {}
    options = browser_options()
    options['args'] = ['--enable-unsafe-swiftshader']  # allows fallback, does not force it
    with sync_playwright() as pw:
        browser = pw.chromium.launch(**options)
        for mobile in [False, True]:
            label = 'mobile' if mobile else 'desktop'
            context = browser.new_context(viewport={'width': 390 if mobile else 1440, 'height': 844 if mobile else 900},
                                          device_scale_factor=1, is_mobile=mobile, has_touch=mobile, accept_downloads=True)
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(URL, wait_until='networkidle')
            page.wait_for_selector('#world-loading', state='detached')
            page.wait_for_timeout(1200)
            snapshot(page, f'{label}-welcome')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            for color in page.locator('.avatar-color').all():
                box = color.bounding_box()
                assert box['width'] >= 44 and box['height'] >= 44
            page.get_by_role('button', name='Rose avatar', exact=True).click()
            assert page.get_by_role('button', name='Rose avatar', exact=True).get_attribute('aria-pressed') == 'true'
            if not mobile:
                for district in ['japan', 'korea', 'india', 'italy']:
                    page.locator(f'[data-action="preview-district"][data-district="{district}"]').click()
                    page.wait_for_timeout(1500)
                    snapshot(page, f'garden-{district}')
            page.locator('#nickname').fill('Lan Nguyễn' if mobile else 'Garden Explorer')
            page.get_by_role('button', name='Enter the world', exact=True).click()
            page.wait_for_selector('.in-world .game-header')
            page.wait_for_timeout(1200)
            snapshot(page, f'{label}-world')
            model = page.evaluate('''() => {
              const a=window.__ww.scene.avatars.get(window.__ww.connection.id);
              return {source:a.model.source,bones:a.model.mesh.skeleton.bones.length,
                clips:a.model.mixer._actions.map(a=>a.getClip().name),look:a.model.look,
                propParent:a.prop.parent.name,labelHidden:!a.label.visible};
            }''')
            assert model['source'] == 'glb' and model['bones'] == 18 and len(model['clips']) == 10, model
            assert model['look'] == 0 and model['propParent'] == 'HandR' and model['labelHidden'], model
            if not mobile:
                independent = page.evaluate('''async () => {
                  const {GuestModel}=await import('/src/avatar-model.ts');
                  const a=new GuestModel(0),b=new GuestModel(1),color=b.mesh.geometry.getAttribute('color').array[0];
                  a.setLook(4);a.animate(.3,4.5,'');b.animate(.3,0,'');
                  const result=a.bones.ThighL!==b.bones.ThighL && a.mesh.geometry!==b.mesh.geometry &&
                    a.bones.ThighL.quaternion.angleTo(b.bones.ThighL.quaternion)>.1 &&
                    color===b.mesh.geometry.getAttribute('color').array[0];
                  a.dispose();b.dispose();a.mesh.geometry.dispose();b.mesh.geometry.dispose();return result;
                }''')
                assert independent, 'Cloned guests must have independent skeletons, animated poses and colors'
            page.get_by_role('button', name='Camera controls', exact=True).click()
            for mode, name in [('FIRST_PERSON','First person camera'), ('ISOMETRIC','Isometric camera'), ('THIRD_PERSON','Follow camera')]:
                before = position(page)
                page.get_by_role('button', name=name, exact=True).click()
                page.wait_for_timeout(150)
                assert page.evaluate('window.__ww.scene.mode') == mode
                assert distance(position(page), before) < .12
            page.get_by_role('button', name='Camera controls', exact=True).click()
            if mobile:
                # A second finger may orbit while the first owns movement. Releasing it must not release the joystick.
                pad = page.locator('#joystick').bounding_box()
                x, y = pad['x']+pad['width']/2, pad['y']+pad['height']/2
                session = context.new_cdp_session(page)
                def touches(kind, points):
                    session.send('Input.dispatchTouchEvent', {'type':kind,'touchPoints':[{'x':a,'y':b,'id':i} for i,a,b in points]})
                before = position(page)
                touches('touchStart', [(1,x,y)])
                touches('touchMove', [(1,x+25,y)])
                touches('touchStart', [(1,x+25,y),(2,240,400)])
                touches('touchMove', [(1,x+25,y),(2,280,410)])
                # CDP touchEnd lists the contacts to end, rather than the contacts still held.
                touches('touchEnd', [(2,280,410)])
                assert page.evaluate('window.__ww.scene.joystick[0] > .5')
                page.wait_for_timeout(650)
                assert distance(position(page), before) > .5, page.evaluate('({position:window.__ww.scene.position,input:window.__ww.scene.joystick,connected:window.__ww.connection.connected,enabled:window.__ww.scene.controlsEnabled,hidden:document.hidden})')
                touches('touchCancel', [])
                page.wait_for_timeout(350)
                stopped = position(page)
                page.wait_for_timeout(500)
                assert distance(position(page), stopped) < .18
                assert page.evaluate('window.__ww.scene.joystick.every(x=>x===0)')
            else:
                page.locator('.world-canvas').focus()
                before = position(page)
                page.keyboard.down('w')
                page.wait_for_timeout(650)
                assert distance(position(page), before) > .5
                assert page.evaluate('window.__ww.scene.avatars.get(window.__ww.connection.id).model.current') == 'Walk'
                # Opening a modal with a held key clears movement, even when keyup happens outside the canvas.
                page.get_by_role('button', name='Open world map', exact=True).click()
                page.keyboard.up('w')
                page.wait_for_timeout(300)
                stopped = position(page)
                page.wait_for_timeout(500)
                assert distance(position(page), stopped) < .18
                page.get_by_role('button', name='Close dialog', exact=True).click()
            page.get_by_role('button', name='Weddings', exact=True).click()
            snapshot(page, f'{label}-directory')
            page.keyboard.press('Escape')
            assert page.locator('#directory-drawer').is_hidden()
            assert page.evaluate('!document.querySelector("#game-hud").inert')
            page.get_by_role('button', name='Open world map', exact=True).click()
            assert page.locator('.map-destination').count() == 6
            snapshot(page, f'{label}-map')
            page.locator('.map-destination[data-district="vietnam"]').click()
            page.wait_for_timeout(450)
            assert page.evaluate('window.__ww.scene.route.length > 0')
            assert page.locator('#mini-route').get_attribute('points')
            assert 'about' in page.locator('#navigation-distance').inner_text()
            page.get_by_role('button', name='Stop walking', exact=True).click()
            page.wait_for_timeout(300)
            page.get_by_role('button', name='Open photo mode', exact=True).click()
            before = position(page)
            page.keyboard.down('w')
            page.wait_for_timeout(450)
            page.keyboard.up('w')
            assert distance(position(page), before) < .18
            snapshot(page, f'{label}-photo-mode')
            with page.expect_download() as photo:
                page.get_by_role('button', name='Save a photograph', exact=True).click()
            photo.value.save_as(OUT / f'{label}-saved-photo.png')
            page.get_by_role('button', name='Exit photo mode', exact=False).click()
            assert page.locator('#photo-overlay').is_hidden()
            assert page.evaluate('window.__ww.scene.controlsEnabled && !window.__ww.scene.photoMode')
            page.wait_for_timeout(2500)
            results[label] = {'model':model, 'render':page.evaluate('''() => {
              const r=window.__ww.scene.renderer,g=r.getContext();return {fps:window.__ww.scene.frameRate,
                calls:r.info.render.calls,triangles:r.info.render.triangles,renderer:g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)};
            }''')}
            assert not errors, errors
            context.close()
        browser.close()
    (OUT / 'checks.json').write_text(json.dumps({'passed':True,'errors':errors,'devices':results,
       'limit':'Headless desktop GPU and phone viewport emulation. No physical phone performance claim.'},indent=2),encoding='utf8')
    print(json.dumps(results,indent=2))


if __name__ == '__main__':
    main()
