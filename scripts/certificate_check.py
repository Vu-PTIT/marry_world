"""Browser verification and layout samples for all five local certificate designs."""
import base64
import json
import time

from playwright.sync_api import sync_playwright
from backend.app.evidence import EvidenceSigner
from backend.app.map import DISTRICTS
from scripts.browser_check import ARTIFACTS,URL,browser_options


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    signer=EvidenceSigner()
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(**browser_options())
        page=browser.new_page(viewport={'width':1000,'height':900})
        page.goto(URL)
        page.wait_for_function('window.__ww?.scene')
        page.evaluate('window.__ww.scene.renderer.setAnimationLoop(null)')
        for district in DISTRICTS:
            evidence=signer.issue('layout-check-'+district,['Lan Nguyễn','Minh Trần'],district,time.time())
            result=page.evaluate('''async ({evidence,key})=>{
                const module=await import('/src/certificate.ts');
                const valid=await module.verifyEvidence(evidence,key);
                const tampered=structuredClone(evidence);tampered.payload.couple[0]='Forged name';
                const rejectsTamper=!await module.verifyEvidence(tampered,key);
                const rejectsKey=!await module.verifyEvidence(evidence,btoa('x'.repeat(32)));
                const canvas=await module.renderCertificate(evidence);
                return {valid,rejectsTamper,rejectsKey,width:canvas.width,height:canvas.height,png:canvas.toDataURL('image/png').split(',')[1]};
            }''',{'evidence':evidence,'key':signer.public_key})
            assert result['valid'] and result['rejectsTamper'] and result['rejectsKey']
            assert (result['width'],result['height'])==(2480,3508)
            (ARTIFACTS/f'certificate-layout-{district}.png').write_bytes(base64.b64decode(result.pop('png')))
            results.append({'district':district,**result})
        browser.close()
    (ARTIFACTS/'certificate-layout-result.json').write_text(json.dumps(results,indent=2),encoding='utf8')
    print('Verified all five 2480x3508 layouts, browser signatures, tamper rejection and wrong-key rejection.')


if __name__=='__main__':main()
