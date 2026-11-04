import asyncio, json, os, urllib.request
from playwright.async_api import async_playwright

# Owl's phone companion: sharing on, a demo flight, then the phone app over HTTPS.
CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox", "--no-proxy-server"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940})
        errs = []
        pg.on("pageerror", lambda e: errs.append(f"owl pageerror: {e}"))
        await pg.goto("http://127.0.0.1:47710/"); await pg.wait_for_timeout(900)
        await pg.click("header button.primary"); await pg.click(".conn-card:has-text('Demo flight')"); await pg.wait_for_timeout(300)
        await pg.select_option("select[aria-label=Speed]", "2"); await pg.click(".modal-foot button.primary")
        await pg.wait_for_timeout(1000)
        await pg.click("header button:has-text('Phone')"); await pg.wait_for_timeout(500)
        await pg.wait_for_timeout(800)
        if not await pg.is_checked(".companion input[type=checkbox]"): await pg.click(".companion input[type=checkbox]")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path="tests/shots/owl_phone_window.png")
        st = await pg.evaluate("fetch('/api/companion').then(r => r.json())")
        print("sharing:", st["on"], st["error"], [u["ip"] for u in st["urls"]])
        app = st["urls"][0]["app"]; setup = st["urls"][0]["setup"]
        await pg.click(".modal-foot button:has-text('Done')")
        # setup page and certificate over plain HTTP
        html = urllib.request.urlopen(setup, timeout=5).read().decode()
        cer = urllib.request.urlopen(setup.split("/?")[0] + "/aviary-owl.cer", timeout=5)
        open("/tmp/aviary-test/aviary-owl.cer", "wb").write(cer.read())
        print("setup page ok:", "Certificate Trust Settings" in html, "| cert type:", cer.headers["Content-Type"])
        # the phone (WebKit isn't installed here, so Chromium sized like an iPhone)
        ph = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                                 ignore_https_errors=True, permissions=["geolocation"], geolocation={"latitude": 40.8512, "longitude": -119.1262})
        pp = await ph.new_page()
        pp.on("pageerror", lambda e: errs.append(f"phone pageerror: {e}"))
        await pp.goto(app); await pp.wait_for_timeout(4000)
        await pp.screenshot(path="tests/shots/phone_live_1.png")
        await pp.wait_for_timeout(16000)
        await pp.screenshot(path="tests/shots/phone_live_2.png")
        print("phone live:", (await pp.inner_text(".hero")).replace("\n", " | "))
        await pp.click("nav.tabs button:has-text('Recovery')"); await pp.wait_for_timeout(2500)
        await pp.screenshot(path="tests/shots/phone_recovery.png")
        print("phone recovery:", (await pp.inner_text(".rec")).replace("\n", " | "))
        await pp.click("nav.tabs button:has-text('Settings')"); await pp.wait_for_timeout(500)
        await pp.screenshot(path="tests/shots/phone_settings.png")
        # wrong key is refused
        bad = await pp.evaluate("fetch('/c/state?k=nope').then(r => r.status)")
        main = await pp.evaluate("fetch('/api/settings').then(r => r.status)")
        print("wrong key:", bad, "| main API from the phone:", main)
        # turn sharing off: the phone loses the feed but keeps the rocket's position
        await pg.evaluate("fetch('/api/companion', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({on:false})})")
        await pg.evaluate("fetch('/api/settings').then(r=>r.json()).then(s => { s.companion = {on:false}; return fetch('/api/settings', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(s)}) })")
        print("\n".join(errs) or "no page errors")
        await b.close()
asyncio.run(main())
