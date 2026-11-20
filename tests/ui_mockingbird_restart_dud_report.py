"""Mockingbird 1.3 in the browser: the restart and dud-charge tests, the
board's own altitude and speed scores, the new fault and limit settings, and
the printed test reports."""
import asyncio
import os
from playwright.async_api import async_playwright

CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
URL = "http://127.0.0.1:47730/"
SHOTS = "tests/shots/"


async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox", "--no-proxy-server"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940})
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(900)

        # the new tests are in the list
        names = await pg.locator(".test-item .nm").all_inner_texts()
        print("tests:", names)
        assert "Restart while coasting" in names and "Drogue charge doesn't go off" in names

        # restart test with the virtual board
        await pg.click("button:has-text('Try it with the virtual flight computer')")
        await pg.wait_for_selector(".verdict-box", timeout=60000)
        await pg.click(".test-item:has-text('Restart while coasting')")
        await pg.click(".run-bar .seg button:has-text('20×')")
        await pg.click(".run-bar button:has-text('Start test')")
        await pg.wait_for_selector(".verdict-box", timeout=90000)
        await pg.wait_for_timeout(800)
        checks = await pg.locator(".checks li").all_inner_texts()
        print("restart checks:", [c.replace("\n", " | ") for c in checks])
        assert any("Restart" in c and "back after" in c for c in checks)
        await pg.mouse.move(2, 930)
        await pg.screenshot(path=SHOTS + "mb_new_restart.png")
        await pg.click(".run-side .tabs button:has-text('Events')")
        await pg.wait_for_timeout(300)
        ev = await pg.locator(".events li").all_inner_texts()
        print("events:", [e.replace("\n", " ") for e in ev if "estart" in e or "back" in e.lower() or "saved" in e])
        await pg.click(".run-side .tabs button:has-text('Result')")

        # the printed report for this run
        await pg.evaluate("window.print = () => { window.__printed = (window.__printed || 0) + 1; }")
        await pg.click("button:has-text('Print report')")
        await pg.wait_for_function("window.__printed >= 1", timeout=15000)
        await pg.emulate_media(media="print")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path=SHOTS + "mb_new_print_run.png", full_page=True)
        await pg.pdf(path=SHOTS + "mb_new_print_run.pdf", format="Letter", print_background=True)
        await pg.emulate_media(media="screen")
        await pg.evaluate("document.getElementById('print-report')?.remove()")

        # the dud test: the virtual board has no backup, so it fails with advice
        await pg.click(".test-item:has-text('Drogue charge')")
        await pg.click(".run-bar .seg button:has-text('Instant')")
        await pg.click(".run-bar button:has-text('Start test')")
        await pg.wait_for_selector(".verdict-box.fail", timeout=60000)
        checks = await pg.locator(".checks li").all_inner_texts()
        print("dud checks:", [c.replace("\n", " | ") for c in checks][:2])
        assert any("charge didn't go off" in c for c in checks)

        # the fault editor shows the new faults sensibly
        await pg.dblclick(".test-item:has-text('Restart while coasting')")
        await pg.wait_for_selector(".modal .rk-card")
        labels = await pg.locator(".modal .fault-row .field > span").all_inner_texts()
        print("restart fault fields:", labels)
        assert "Lasts" not in labels
        await pg.screenshot(path=SHOTS + "mb_new_edit_restart.png")
        await pg.click(".modal-foot button:has-text('Cancel')")
        await pg.dblclick(".test-item:has-text('Drogue charge')")
        await pg.wait_for_selector(".modal .rk-card")
        opts = await pg.locator(".modal .fault-row select").first.locator("option").all_inner_texts()
        dev = await pg.locator(".modal .fault-row select").nth(1).locator("option").all_inner_texts()
        print("device choices:", dev)
        assert any("apogee" in d.lower() for d in dev)
        await pg.click(".modal-foot button:has-text('Cancel')")

        # the limits panel on the Flight computer tab
        await pg.click(".mb-main > .tabs button:has-text('Flight computer')")
        await pg.wait_for_timeout(500)
        txt = await pg.inner_text("body")
        assert "Backup: later by" in txt and "Fail a test when they're off" in txt
        el = pg.locator("text=The flight computer's own altitude and speed").first
        await el.scroll_into_view_if_needed()
        await pg.wait_for_timeout(200)
        await pg.screenshot(path=SHOTS + "mb_new_limits.png")
        await pg.click(".mb-main > .tabs button:has-text('Run')")

        # every ticked test, then the printed summary
        await pg.click(".run-bar .seg button:has-text('Instant')")
        await pg.click(".run-bar button.btn:has-text('ticked test')")
        await pg.wait_for_selector(".suite", timeout=180000)
        await pg.wait_for_timeout(800)
        head = await pg.inner_text(".suite h4")
        print("suite:", head)
        await pg.mouse.move(2, 930)
        await pg.screenshot(path=SHOTS + "mb_new_suite.png")
        await pg.click(".suite-head button:has-text('Print')")
        await pg.wait_for_function("window.__printed >= 2", timeout=15000)
        await pg.emulate_media(media="print")
        await pg.wait_for_timeout(300)
        await pg.pdf(path=SHOTS + "mb_new_print_suite.pdf", format="Letter", print_background=True)
        await pg.emulate_media(media="screen")

        print("errors:", errs)
        assert not errs, errs
        await b.close()

asyncio.run(main())
