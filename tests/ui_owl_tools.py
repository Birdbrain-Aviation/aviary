import asyncio
import os
from playwright.async_api import async_playwright

# Owl's checklist, recovery mode and offline save, during a demo flight.
CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1480, "height": 940}, permissions=["geolocation"], geolocation={"latitude": 40.852, "longitude": -119.115})
        pg = await ctx.new_page()
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error",) and "404" not in m.text else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await pg.goto("http://127.0.0.1:47710/"); await pg.wait_for_timeout(900)
        await pg.click("header button.primary")
        await pg.click(".conn-card:has-text('Demo flight')")
        await pg.wait_for_timeout(400)
        await pg.select_option("select[aria-label=Speed]", "5")
        await pg.click(".modal-foot button.primary")
        await pg.wait_for_timeout(2500)
        await pg.click("header button:has-text('Checklist')"); await pg.wait_for_timeout(1800)
        boxes = pg.locator(".checklist li input:not([disabled])")
        for i in range(2): await boxes.nth(i).check()
        await pg.fill(".cl-add input", "Camera on and recording"); await pg.click(".cl-add button")
        await pg.wait_for_timeout(600)
        await pg.screenshot(path="tests/shots/owl_checklist.png")
        await pg.click(".modal-foot button:has-text('Done')")
        print("button:", await pg.inner_text("header button:has-text('Checklist')"))
        await pg.click("button:has-text('Save area for offline')"); await pg.wait_for_timeout(2500)
        print("map hint:", await pg.inner_text("#maphint"))
        await pg.wait_for_timeout(9000)
        await pg.click("button:has-text('Recovery mode')"); await pg.wait_for_timeout(2500)
        await pg.screenshot(path="tests/shots/owl_recovery_mode.png")
        print("recovery:", (await pg.inner_text(".rm-dist")), "|", await pg.inner_text(".rm-dir"))
        await pg.click(".recovery-mode button:has-text('Exit')")
        print("\n".join(errs) or "no console errors")
        await b.close()
asyncio.run(main())
