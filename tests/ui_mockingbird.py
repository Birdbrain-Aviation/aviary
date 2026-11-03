import asyncio, sys
import os
from playwright.async_api import async_playwright

# use the system Chrome when there is one, else Playwright's own browser
CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}

URL = "http://127.0.0.1:47730/"
SHOTS = "tests/shots/"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940}, device_scale_factor=1)
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(900)
        await pg.screenshot(path=SHOTS + "mb_empty.png")

        # one test with the virtual flight computer at 20x
        await pg.click("button:has-text('Try it with the virtual flight computer')")
        await pg.wait_for_timeout(300)
        await pg.click(".run-bar .seg button:has-text('20×')")
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path=SHOTS + "mb_running.png")
        await pg.wait_for_selector(".verdict-box", timeout=60000)
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=SHOTS + "mb_result.png")
        verdict = await pg.inner_text(".verdict-box .big")
        print("first run verdict:", verdict)

        await pg.click(".run-side .tabs button:has-text('Console')")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=SHOTS + "mb_console.png")

        # rocket tab
        await pg.click(".mb-main > .tabs button:has-text('Rocket')")
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path=SHOTS + "mb_rocket.png")
        await pg.evaluate("document.querySelector('.mb-tab:not(.hidden)').scrollTop = 900")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path=SHOTS + "mb_rocket_2.png")

        # flight computer tab
        await pg.click(".mb-main > .tabs button:has-text('Flight computer')")
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=SHOTS + "mb_fc.png")

        # test editor
        await pg.click(".mb-main > .tabs button:has-text('Run')")
        await pg.click(".test-item:has-text('Pressure dip before apogee')")
        await pg.click(".side-actions button:has-text('Edit')")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=SHOTS + "mb_test_editor.png")
        await pg.click(".modal-foot button:has-text('Cancel')")

        # whole suite, instant
        await pg.click(".run-bar .seg button:has-text('Instant')")
        await pg.click(".run-bar button.btn:has-text('ticked test')")
        await pg.wait_for_selector(".suite", timeout=120000)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=SHOTS + "mb_suite.png")
        rows = await pg.eval_on_selector_all(".suite tr", "els => els.map(e => e.innerText.replace(/\\s+/g,' ').trim())")
        print("\n".join(rows))

        # open a past run from history
        await pg.click(".hist-item >> nth=3")
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=SHOTS + "mb_past.png")

        # night theme
        await pg.click(".app-header .seg button:has-text('Night')")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=SHOTS + "mb_night.png")
        await pg.click(".app-header .seg button:has-text('Day')")

        print("\n".join(errs) or "no console errors")
        await b.close()

asyncio.run(main())
