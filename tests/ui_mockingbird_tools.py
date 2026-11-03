import asyncio
import os
from playwright.async_api import async_playwright

# Mockingbird: Monte Carlo with the virtual flight computer, replaying a log, pyro timing.
CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940})
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" and "404" not in m.text else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await pg.goto("http://127.0.0.1:47730/"); await pg.wait_for_timeout(900)
        await pg.click(".tabs button:has-text('Run')")
        if await pg.locator(".app-header button:has-text('Disconnect')").count() == 0:
            await pg.click(".app-header button:has-text('Connect')"); await pg.click(".conn-card:has-text('Virtual')"); await pg.click(".modal-foot button:has-text('Connect')")
        await pg.wait_for_timeout(500)
        await pg.click(".test-item:has-text('Normal flight')")
        # Monte Carlo
        await pg.click("button:has-text('Monte Carlo…')"); await pg.wait_for_timeout(400)
        await pg.fill(".mc-grid input >> nth=0", "40"); await pg.press(".mc-grid input >> nth=0", "Tab")
        await pg.screenshot(path="tests/shots/mb_mc_form.png")
        await pg.click(".modal-foot button:has-text('Start')")
        await pg.wait_for_selector(".mc-results", timeout=90000); await pg.wait_for_timeout(600)
        await pg.screenshot(path="tests/shots/mb_mc_results.png")
        print("MC:", (await pg.inner_text(".mc-head")).replace("\n", " | "))
        await pg.click(".modal-foot button:has-text('Save results')"); await pg.wait_for_timeout(800)
        await pg.click(".modal-foot button:has-text('Done')")
        # Replay a log from the Heron library
        await pg.click("button:has-text('Replay a log…')"); await pg.wait_for_timeout(900)
        await pg.click(".replay-list button:has-text('GPS test flight')"); await pg.wait_for_timeout(1200)
        await pg.screenshot(path="tests/shots/mb_replay_pick.png")
        await pg.click(".modal-foot button:has-text('Replay into the flight computer')")
        m = pg.locator(".modal-foot button:has-text('Charges are disconnected')")
        if await m.count(): await m.click()
        await pg.wait_for_selector(".verdict-box", timeout=120000); await pg.wait_for_timeout(1500)
        await pg.screenshot(path="tests/shots/mb_replay_result.png")
        print("replay:", (await pg.inner_text(".verdict-box")).replace("\n", " | "))
        print("timing:", (await pg.inner_text(".pt-table")).replace("\n", " | ").replace("\t", " "))
        print("\n".join(errs) or "no console errors")
        await b.close()
asyncio.run(main())
