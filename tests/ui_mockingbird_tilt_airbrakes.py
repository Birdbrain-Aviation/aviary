"""Mockingbird in the browser: an airbrake rocket aiming for a target apogee,
a tilted two-stage launch the board must not stage, the rocket editor's new
fields, and a Monte Carlo batch scored against the target."""
import asyncio
import os
from playwright.async_api import async_playwright

CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
URL = "http://127.0.0.1:47730/"
SHOTS = "tests/shots/"


async def pick_rocket(pg, name):
    await pg.click(".mb-main > .tabs button:has-text('Rocket')")
    await pg.wait_for_timeout(400)
    sel = pg.locator(".rk-select select")
    opts = await sel.locator("option").all_inner_texts()
    if not any(name in o for o in opts):
        await pg.click(".rk-bar button:has-text('Examples…')")
        await pg.click(f".modal button:has-text('{name}')")
        await pg.wait_for_timeout(400)
    else:
        val = await sel.locator("option", has_text=name).first.get_attribute("value")
        await sel.select_option(val)
        await pg.wait_for_timeout(400)


async def run_test(pg, test, speed="Instant"):
    await pg.click(".mb-main > .tabs button:has-text('Run')")
    await pg.wait_for_timeout(300)
    await pg.click(f".test-item:has(.nm:text-is('{test}'))")
    await pg.click(f".run-bar .seg button:has-text('{speed}')")
    await pg.click(".run-bar button:has-text('Start test')")
    await pg.wait_for_selector(".verdict-box", timeout=120000)
    await pg.wait_for_timeout(800)
    return await pg.eval_on_selector_all(".checks li", "els => els.map(e => e.innerText.replace(/\\n/g, ' | '))")


async def use_virtual(pg):
    """Connect the virtual flight computer and show the Run tab, whatever an
    earlier test left behind."""
    if await pg.locator(".mb-main > .tabs button:has-text('Run')").count():
        await pg.click(".mb-main > .tabs button:has-text('Run')")
    btn = pg.locator("button:has-text('Try it with the virtual flight computer')")
    if await btn.count() and await btn.first.is_visible():
        await btn.first.click()
        await pg.wait_for_selector(".verdict-box", timeout=90000)
        return
    pill = await pg.inner_text(".app-header .pill") if await pg.locator(".app-header .pill").count() else ""
    if "Virtual" in pill:
        return
    if await pg.locator(".app-header button:has-text('Disconnect')").count():
        await pg.click(".app-header button:has-text('Disconnect')")
    await pg.click(".app-header button:has-text('Connect')")
    await pg.click(".conn-card:has-text('Virtual')")
    await pg.click(".modal-foot button:has-text('Connect')")
    await pg.wait_for_selector(".pill:has-text('Virtual')", timeout=10000)


async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox", "--no-proxy-server"])
        pg = await b.new_page(viewport={"width": 1480, "height": 1000})
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(900)
        await use_virtual(pg)

        # airbrakes
        await pick_rocket(pg, "Example: airbrakes to a target")
        txt = await pg.inner_text(".rk-form")
        assert "This rocket has airbrakes" in txt and "Target apogee" in txt and "Stability" in txt and "Rail angle" in txt
        el = pg.locator("text=This rocket has airbrakes").first
        await el.scroll_into_view_if_needed()
        await pg.screenshot(path=SHOTS + "mb_rocket_airbrakes.png")
        checks = await run_test(pg, "Normal flight", "20×")
        print("airbrakes normal:", checks)
        assert any("Apogee target" in c and c.startswith("✓") for c in checks), checks
        assert any("Airbrakes under power" in c and c.startswith("✓") for c in checks)
        legend = await pg.inner_text(".chart-stack3 > div:nth-child(4) .legend")
        print("control chart legend:", legend.replace("\n", " | "))
        assert "Airbrakes open" in legend and "True tilt" in legend
        await pg.mouse.move(2, 990)
        await pg.screenshot(path=SHOTS + "mb_airbrakes_run.png")
        checks = await run_test(pg, "Strong motor")
        print("airbrakes strong:", [c for c in checks if "target" in c])
        assert any("Apogee target" in c and c.startswith("✓") and "can't reach" not in c for c in checks), checks

        # Monte Carlo against the target
        await pg.click(".run-bar button:has-text('Monte Carlo')")
        await pg.wait_for_selector(".modal")
        runs = pg.locator(".modal input[type=number]").first
        await runs.fill("40")
        await runs.dispatch_event("change")
        await pg.click(".modal-foot button:has-text('Start')")
        await pg.wait_for_selector(".mc-results", timeout=240000)
        await pg.wait_for_timeout(800)
        rows = await pg.eval_on_selector_all(".mc-table tbody tr", "els => els.map(e => e.innerText.replace(/\\t|\\n/g, ' | '))")
        print("monte carlo:", rows)
        assert any(r.startswith("Apogee target") for r in rows)
        await pg.screenshot(path=SHOTS + "mb_airbrakes_mc.png")
        await pg.click(".modal-foot button:has-text('Done')")
        await pg.wait_for_timeout(300)

        # tilted two-stage launch
        await pick_rocket(pg, "Example: two-stage G")
        checks = await run_test(pg, "Tilted launch", "20×")
        print("tilted launch:", checks)
        assert any("Sustainer ignition" in c and "held off" in c and c.startswith("✓") for c in checks), checks
        await pg.mouse.move(2, 990)
        await pg.screenshot(path=SHOTS + "mb_tilted_launch.png")

        print("errors:", errs)
        assert not errs, errs
        await b.close()

asyncio.run(main())
