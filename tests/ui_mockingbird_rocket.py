"""Mockingbird's rocket editor: load a motor file, add a stage, and check the
prediction, the staging test and the pyro table all follow."""
import asyncio, os, tempfile
from playwright.async_api import async_playwright

CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
URL = "http://127.0.0.1:47730/"
SHOTS = "tests/shots/"
ENG = """; made-up test motor
T99 29 124 6-10 0.0600 0.1300 Testco
0.02 120
0.50 105
1.00 100
1.20 40
1.25 0
"""

async def main():
    eng = os.path.join(tempfile.mkdtemp(), "T99.eng")
    open(eng, "w").write(ENG)
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940})
        errs = []
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        await pg.goto(URL)
        await pg.wait_for_timeout(700)
        await pg.click(".mb-main > .tabs button:has-text('Rocket')")
        await pg.wait_for_timeout(600)
        await pg.click(".rk-bar button:has-text('Duplicate')")
        await pg.wait_for_timeout(600)
        apogee0 = await pg.inner_text(".rk-stats .stat >> nth=0")

        # load a motor file into the first stage
        async with pg.expect_file_chooser() as fc:
            await pg.click("button:has-text('Load .eng / .rse')")
        await (await fc.value).set_files(eng)
        await pg.wait_for_timeout(900)
        motor = await pg.inner_text(".rk-motor-name >> nth=0")
        apogee1 = await pg.inner_text(".rk-stats .stat >> nth=0")
        print("motor:", motor.replace("\n", " "), "| apogee before/after:", apogee0.replace("\n", " "), "/", apogee1.replace("\n", " "))

        # add a stage on top
        await pg.click("button:has-text('Add a stage on top')")
        await pg.wait_for_timeout(900)
        heads = await pg.eval_on_selector_all(".rk-card-head b", "els => els.map(e => e.innerText)")
        apogee2 = await pg.inner_text(".rk-stats .stat >> nth=0")
        warns = await pg.eval_on_selector_all(".rk-warn li", "els => els.map(e => e.innerText)")
        print("cards:", heads, "| two-stage apogee:", apogee2.replace("\n", " "))
        print("warnings:", warns)
        await pg.screenshot(path=SHOTS + "mb_rocket_two_stage.png")

        # the staging test is now available, and the pyro table can light the sustainer
        na = await pg.eval_on_selector_all(".test-item.na .nm", "els => els.map(e => e.innerText)")
        print("tests not available:", na)
        await pg.click(".mb-main > .tabs button:has-text('Flight computer')")
        await pg.wait_for_timeout(600)
        opts = await pg.eval_on_selector_all(".setup table.data select >> nth=0", "el => [...el.options].map(o => o.text)") if False else await pg.evaluate("[...document.querySelectorAll('.setup table.data select')].map(s => s.value)")
        print("pyro rows:", opts)

        # run the staging test on the virtual board, instantly
        await pg.click(".mb-main > .tabs button:has-text('Run')")
        await pg.click(".app-header button:has-text('Connect')")
        await pg.click(".conn-card:has-text('Virtual flight computer')")
        await pg.click(".modal-foot button:has-text('Connect')")
        await pg.wait_for_timeout(300)
        await pg.click(".run-bar .seg button:has-text('Instant')")
        await pg.click(".test-item:has-text('Normal flight')")
        await pg.click(".run-bar button:has-text('Start test')")
        await pg.wait_for_selector(".verdict-box", timeout=30000)
        await pg.wait_for_timeout(500)
        checks = await pg.eval_on_selector_all(".checks li", "els => els.map(e => e.innerText.replace(/\\n/g, ' '))")
        print("verdict:", await pg.inner_text(".verdict-box .big"))
        print("\n".join(checks))
        await pg.screenshot(path=SHOTS + "mb_two_stage_result.png")

        # clean up: delete the copy so the list is as it was
        await pg.click(".mb-main > .tabs button:has-text('Rocket')")
        await pg.wait_for_timeout(400)
        await pg.click(".rk-bar button:has-text('Delete')")
        await pg.click(".modal-foot button:has-text('Delete')")
        await pg.wait_for_timeout(500)
        print("rockets left:", await pg.evaluate("[...document.querySelectorAll('.rk-select select option')].map(o => o.text)"))
        print("\n".join(errs) or "no console errors")
        await b.close()

asyncio.run(main())
