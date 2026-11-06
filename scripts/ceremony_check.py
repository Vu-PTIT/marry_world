"""Real browser/HTTP/WebSocket wedding flow against an isolated Python authority.

Only this harness advances a fixture clock and positions fixture guests. Production
has no clock, teleport, fake visitor, or automatic-completion endpoint.
Run with Vite already on :5173 and :8000 free: python -m scripts.ceremony_check
"""
import asyncio
import base64
import concurrent.futures
import json
import os
import threading
import time
from pathlib import Path

import httpx
import uvicorn
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from playwright.sync_api import sync_playwright

from backend.app.evidence import EvidenceSigner, DISCLAIMER
from backend.app.main import create_app
from backend.app.map import DISTRICTS, MAP, local_to_world
from backend.app.world import World
from scripts.browser_check import browser_options

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
URL = os.getenv("TEST_URL", "http://127.0.0.1:5173")


class Harness:
    def __init__(self):
        self.value = time.time()
        self.world = World(EvidenceSigner())
        self.world.now = lambda: self.value
        os.environ["REDIS_PREFIX"] = "wedding-world-browser-fixture"
        os.environ["REDIS_URL"] = ""
        os.environ["WORLD_ZONE_WORKERS"] = "0"
        self.app = create_app(self.world)
        self.server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=8000,
            log_level="warning", access_log=False, ws_max_size=8192, ws_max_queue=16))
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.server.serve())

    def mutate(self, function):
        future = concurrent.futures.Future()
        def call():
            try:
                future.set_result(function())
            except Exception as error:
                future.set_exception(error)
        self.loop.call_soon_threadsafe(call)
        return future.result(timeout=5)

    def place(self, code, point):
        def action():
            guest = self.world.guests[self.world.codes[code]]
            guest.x, guest.z = point
            guest.dx = guest.dz = 0
            guest.revision += 1
        self.mutate(action)

    def phase(self, event_id, index, progress=2):
        def action():
            event = self.world.weddings[event_id]
            seconds = sum(p["duration"] for p in DISTRICTS[event.district]["program"][:index]) + progress
            self.value = event.started_at + seconds
            self.world.tick_events()
        self.mutate(action)

    def __enter__(self):
        self.thread.start()
        for _ in range(100):
            if self.server.started:return self
            time.sleep(.05)
        raise RuntimeError("Fixture server did not start. Free port 8000 first.")

    def __exit__(self, *_):
        self.server.should_exit = True
        self.thread.join(timeout=10)


def enter(page, name, url=URL):
    page.goto(url)
    if '/w/' in url:
        page.locator('#invitation-actions').wait_for(state='visible')
        page.locator('#invitation-actions [data-action="copy-link"]').click()
        page.screenshot(path=str(ARTIFACTS/'mobile-invitation.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator("#nickname").fill(name)
    page.locator("#enter-button").click()
    try:
        page.wait_for_selector(".in-world .game-header", timeout=20000)
    except Exception:
        page.screenshot(path=str(ARTIFACTS/'ceremony-entry-failure.png'))
        print(json.dumps({'entryFailed':name,'body':page.locator('body').inner_text()[-2000:]}),flush=True)
        raise
    page.wait_for_function("window.__ww?.connection?.connected")
    return page.locator("#guest-code").inner_text()


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    with Harness() as fixture, sync_playwright() as p:
        browser = p.chromium.launch(**browser_options())
        errors = []
        def new_page(mobile=False):
            context = browser.new_context(viewport={"width":390 if mobile else 1440,"height":844 if mobile else 900},
                is_mobile=mobile,has_touch=mobile,accept_downloads=True)
            page = context.new_page()
            page.on("pageerror",lambda error:errors.append(str(error)))
            return page
        a,b = new_page(),new_page()
        ac,bc = enter(a,"Lan Nguyễn"),enter(b,"Minh Trần")
        print('Browser guests connected.',flush=True)
        # Release background GPU work; networking, control UIs and timers stay live.
        b.evaluate("window.__ww.scene.renderer.setAnimationLoop(null)")
        fixture.place(ac,MAP["registrar"])
        a.wait_for_function("Math.hypot(window.__ww.scene.position[0]+20,window.__ww.scene.position[1]-6)<2")
        a.locator('.game-header [data-action="plan"]').click()
        a.locator('#partner-code').fill(bc)
        a.locator('[name="consent"]').check()
        a.get_by_role('button',name='Ask for their consent').click()
        b.get_by_role('button',name='I agree to this wedding').wait_for()
        assert fixture.mutate(lambda:not fixture.world.weddings and not fixture.world.slugs)
        b.get_by_role('button',name='I agree to this wedding').click()
        a.wait_for_function("window.__ww.connection.state.wedding!==null")
        event = a.evaluate("window.__ww.connection.state.wedding")
        event_id,slug = event['id'],event['slug']
        print('Mutual consent and private proposal checks passed.',flush=True)
        invitation = f'{URL}/w/{slug}'
        assert httpx.get(f'http://127.0.0.1:8000/w/{slug}').status_code==200
        a.locator('[data-action="share"]').click()
        assert a.locator('#invitation-link').input_value()==invitation
        a.get_by_role('button',name='Close dialog').click()
        family = new_page()
        fc = enter(family,"Mai Family")
        family.evaluate("window.__ww.scene.renderer.setAnimationLoop(null)")
        a.locator('[data-action="group"]').click()
        a.locator('#role-code').fill(fc)
        a.locator('[name="role"]').select_option('friend')
        a.get_by_role('button',name='Invite to our group').click()
        family.get_by_role('button',name='Accept role',exact=True).click()
        a.wait_for_function("window.__ww.connection.state.wedding.members[0]?.accepted===true")
        a.locator('#attire-choice').select_option('1')
        a.get_by_role('button',name='Close dialog').click()
        spectator = new_page(mobile=True)
        sc = enter(spectator,"Public Visitor",invitation)
        spectator_id=spectator.evaluate('window.__ww.connection.id')
        spectator.goto(invitation)
        spectator.locator('#resume-invitation').click()
        spectator.wait_for_selector('.in-world .game-header')
        assert spectator.evaluate('window.__ww.connection.id')==spectator_id
        print('Role approval and public invitation entry passed.',flush=True)
        spectator.evaluate("window.__ww.scene.renderer.setAnimationLoop(null)")
        assert fixture.mutate(lambda:not fixture.world.grants(fixture.world.guests[fixture.world.codes[sc]]))
        # Ready checks are still sent through the two browser controls.
        for page,code in [(a,ac),(b,bc)]:
            fixture.place(code,local_to_world('vietnam',*MAP['readyPoint']))
            page.locator('[data-action="confirm-ready"]').click()
        a.wait_for_function("window.__ww.connection.state.wedding?.state==='CEREMONY_ACTIVE'")
        print('Both ready; running actual program phases under the fixture clock.',flush=True)
        fixture.phase(event_id,0,50)
        a.wait_for_timeout(800)
        spectator.evaluate("window.__ww.scene.setMode('CINEMATIC_SPECTATOR')")
        assert spectator.evaluate("window.__ww.scene.mode")=="CINEMATIC_SPECTATOR"
        spectator.get_by_role('button',name='Camera controls',exact=True).click()
        spectator.get_by_role('button',name='Follow camera',exact=True).click()
        assert spectator.evaluate("window.__ww.scene.mode")=="THIRD_PERSON"
        a.get_by_role('button',name='Camera controls',exact=True).click()
        a.locator('[data-mode="CINEMATIC_SPECTATOR"]').click()
        a.wait_for_timeout(900)
        a.screenshot(path=str(ARTIFACTS/'ceremony-live.png'))
        for index,phase in enumerate(DISTRICTS['vietnam']['program']):
            if index:fixture.phase(event_id,index)
            a.wait_for_function('(phase)=>window.__ww.connection.state.wedding?.phase?.id===phase',arg=phase['id'])
            if phase.get('required'):
                for page in [a,b]:
                    page.locator('[data-action="ceremony-action"]').click()
                for page in [a,b]:
                    page.wait_for_function('(phase)=>window.__ww.connection.state.wedding?.myActions?.includes(phase)',arg=phase['id'])
            if phase['id']=='gifts':
                fixture.place(fc,local_to_world('vietnam',-5,-12))
                family.locator('[data-action="role-ceremony-action"]').click()
                a.wait_for_timeout(700)
                a.screenshot(path=str(ARTIFACTS/'ceremony-gift-tray.png'))
            print('Phase checked: '+phase['id'],flush=True)
        fixture.phase(event_id,len(DISTRICTS['vietnam']['program']),1)
        for page in [a,b]:page.get_by_role('heading',name='A moment to keep.').wait_for(timeout=20000)
        for action,suffix in [('save-png','png'),('save-pdf','pdf'),('save-evidence','json')]:
            with a.expect_download() as download_info:
                a.locator(f'[data-action="{action}"]').click()
            download_info.value.save_as(str(ARTIFACTS/f'certificate-vietnam.{suffix}'))
        a.screenshot(path=str(ARTIFACTS/'certificate-preview.png'))
        evidence=json.loads((ARTIFACTS/'certificate-vietnam.json').read_text(encoding='utf8'))
        Ed25519PublicKey.from_public_bytes(base64.b64decode(evidence['publicKey'])).verify(
            base64.b64decode(evidence['signature']),evidence['canonical'].encode())
        assert evidence['payload']['couple']==['Lan Nguyễn','Minh Trần']
        assert evidence['payload']['disclaimer']==DISCLAIMER
        assert fixture.mutate(lambda:not fixture.world.weddings and not fixture.world.slugs and not any(fixture.world.queues.values()))
        assert httpx.get(f'http://127.0.0.1:8000/w/{slug}').status_code==410
        assert httpx.get(f'http://127.0.0.1:8000/api/invitations/{slug}').status_code==410
        assert not errors,errors
        report={'passed':True,'flow':['explicit mutual consent','no event before consent','SSR invitation',
            'approved and accepted friend role','public link grants no role','both ready controls','live camera enter/exit',
            'required couple actions','optional role gesture','browser Ed25519 verification','A4 PDF / 2480x3508 PNG / evidence downloads',
            'Unicode names','offline signature verification','immediate event/slug/queue cleanup','expired link 410'],
            'clock':'Test harness advances the actual configured program; production durations are unchanged.',
            'positioning':'Harness positions fixture players; ordinary walking is checked separately in browser_check.py.',
            'browserErrors':errors}
        (ARTIFACTS/'ceremony-browser-result.json').write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps(report,indent=2),flush=True)
        browser.close()


if __name__=='__main__':main()
