import asyncio, sys, json
import os
from playwright.async_api import async_playwright

# use the system Chrome when there is one, else Playwright's own browser
CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}

URL = "http://127.0.0.1:47710/"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940}, device_scale_factor=1)
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path="tests/shots/owl_empty.png")
        await pg.click("header button.primary")
        await pg.click(".conn-card:has-text('Demo flight')")
        await pg.wait_for_timeout(500)
        await pg.select_option("select[aria-label=Speed]", "5")
        await pg.click(".modal-foot button.primary")
        for i, wait in enumerate([6000, 9000, 12000]):
            await pg.wait_for_timeout(wait)
            await pg.screenshot(path=f"tests/shots/owl_demo_{i}.png")
        await pg.click(".tabs button:has-text('Raw data')")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path="tests/shots/owl_console.png")
        await pg.click(".tabs button:has-text('Fields')")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path="tests/shots/owl_fields.png")
        await pg.click(".tabs button:has-text('Events')")
        await pg.wait_for_timeout(16000)
        await pg.screenshot(path="tests/shots/owl_landed.png")
        bd = await pg.evaluate("'BarcodeDetector' in window")
        print("BarcodeDetector available:", bd)
        print("\n".join(errs) or "no console errors")
        await b.close()
asyncio.run(main())
