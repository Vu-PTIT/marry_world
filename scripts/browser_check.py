"""Visual reconnaissance against the running local app (no fabricated players)."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
URL = os.getenv("TEST_URL", "http://127.0.0.1:5173")


def browser_options():
    executable = os.getenv("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "")
    installed = Path.home() / "AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe"
    if not executable and installed.exists():
        executable = str(installed)
    args = ['--enable-unsafe-swiftshader'] if os.getenv('PLAYWRIGHT_NATIVE_GPU') == '1' else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    return {"headless": True, **({"executable_path": executable} if executable else {}), "args": args}


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options())
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(ARTIFACTS / "desktop-welcome.png"))
        print(json.dumps({"title": page.title(), "headings": page.get_by_role("heading").all_text_contents(), "buttons": page.get_by_role("button").all_text_contents(), "errors": errors}))
        page.locator("#nickname").fill("Garden Explorer")
        page.get_by_role("button", name="Enter the world", exact=True).click()
        page.wait_for_selector(".in-world .game-header", timeout=15000)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(ARTIFACTS / "desktop-world.png"))
        assert page.locator("#connection-status").inner_text() == "Connected"
        assert "1 guest" in page.locator("#guest-count").inner_text() or "guests" in page.locator("#guest-count").inner_text()
        page.get_by_role("button", name="Weddings", exact=False).click()
        page.wait_for_timeout(350)
        page.screenshot(path=str(ARTIFACTS / "desktop-directory.png"))
        print(json.dumps({"directory": page.locator("#directory-list").inner_text(), "errors": errors}))
        page.get_by_role("button", name="Close wedding directory").click()
        page.get_by_role("button", name="Open world map").click()
        page.wait_for_timeout(200)
        page.screenshot(path=str(ARTIFACTS / "desktop-map.png"))
        page.get_by_role("button", name="Close dialog").click()
        page.get_by_role("button", name="Camera controls", exact=True).click()
        for label in ["First person camera", "Isometric camera", "Follow camera"]:
            page.get_by_role("button", name=label, exact=True).click()
            assert page.get_by_role("button", name=label, exact=True).get_attribute("aria-pressed") == "true"
        page.locator("canvas.world-canvas").focus()
        before = page.locator("#mini-player").get_attribute("transform")
        page.keyboard.down("w")
        page.wait_for_timeout(1200)
        page.keyboard.up("w")
        page.wait_for_timeout(300)
        after = page.locator("#mini-player").get_attribute("transform")
        assert before != after, "Movement did not change authoritative player position"
        render = page.evaluate("({fps:window.__ww.scene.frameRate,drawCalls:window.__ww.scene.renderer.info.render.calls,triangles:window.__ww.scene.renderer.info.render.triangles})")
        # Use a separate context: every guest is a real WebSocket session.
        mobile = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, is_mobile=True, has_touch=True)
        phone = mobile.new_page()
        phone.on("pageerror", lambda error: errors.append(str(error)))
        phone.goto(URL)
        phone.wait_for_load_state("networkidle")
        phone.wait_for_timeout(900)
        phone.screenshot(path=str(ARTIFACTS / "mobile-welcome.png"))
        assert phone.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile page overflows horizontally"
        phone.locator("#nickname").fill("Lan Nguyễn")
        phone.get_by_role("button", name="Enter the world", exact=True).click()
        phone.wait_for_selector(".in-world .game-header")
        phone.wait_for_timeout(1000)
        phone.screenshot(path=str(ARTIFACTS / "mobile-world.png"))
        assert "2 guests" in phone.locator("#guest-count").inner_text() or "guests" in phone.locator("#guest-count").inner_text()
        before_touch=phone.locator('#mini-player').get_attribute('transform')
        pad=phone.locator('#joystick').bounding_box()
        phone.mouse.move(pad['x']+pad['width']/2,pad['y']+pad['height']/2)
        phone.mouse.down()
        phone.mouse.move(pad['x']+pad['width']/2+25,pad['y']+pad['height']/2)
        phone.wait_for_timeout(900)
        phone.mouse.up()
        phone.wait_for_timeout(400)
        assert phone.locator('#mini-player').get_attribute('transform')!=before_touch,'Mobile movement pad did not move the guest'
        phone.get_by_role("button", name="Open world map").click()
        phone.wait_for_timeout(200)
        phone.screenshot(path=str(ARTIFACTS / "mobile-map.png"))
        assert not errors, errors
        (ARTIFACTS/'browser-smoke-result.json').write_text(json.dumps({'passed':True,'browserErrors':errors,
            'checks':['desktop/mobile entry','real independent sessions','desktop walking','mobile movement pad','maps','directory','three normal cameras'],
            'renderSample':render,'renderLimit':'Headless Chromium; native GPU if PLAYWRIGHT_NATIVE_GPU=1, otherwise SwiftShader. Phone viewport emulation, not physical phone performance.'},indent=2),encoding='utf8')
        print("Verified desktop/mobile entry, independent real guests, movement, three normal cameras, directory, and map. No browser errors.")
        mobile.close()
        browser.close()


if __name__ == "__main__":
    main()
