import asyncio
import os
from playwright.async_api import async_playwright

# Flight animation in Heron and Mockingbird: plays, scrubs, follows a live run.
CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940})
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error",) else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await pg.goto("http://127.0.0.1:47720/")
        await pg.wait_for_timeout(800)
        btn = pg.locator("button:has-text('Try a sample flight')")
        if await btn.count(): await btn.click()
        await pg.wait_for_timeout(1500)
        await pg.click(".tabs button:has-text('Animation')")
        await pg.wait_for_timeout(1800)
        await pg.screenshot(path="tests/shots/anim_heron_boost.png")
        slider = pg.locator(".fv-slider")
        mx = float(await slider.get_attribute("max"))
        for frac, name in [(0.08, "apogee"), (0.12, "descent"), (0.55, "main"), (0.999, "landed")]:
            await pg.click(".fv-play") if frac == 0.08 else None
            await slider.evaluate("(el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }", str(frac * mx))
            await pg.wait_for_timeout(400)
            await pg.screenshot(path=f"tests/shots/anim_heron_{name}.png")
        await pg.set_viewport_size({"width": 640, "height": 900})
        await pg.wait_for_timeout(500)
        await pg.screenshot(path="tests/shots/anim_heron_narrow.png")
        await pg.set_viewport_size({"width": 1480, "height": 940})

        await pg.goto("http://127.0.0.1:47730/")
        await pg.wait_for_timeout(900)
        t = pg.locator("button:has-text('Try it with the virtual flight computer')")
        if await t.count(): await t.first.click()
        else:
            v = pg.locator("button:has-text('virtual')")
            if await v.count(): await v.first.click()
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path="tests/shots/anim_mb_before.png")
        await pg.click(".seg button:has-text('Animation')")
        st = pg.locator("button:has-text('Start test')")
        if await st.is_visible(): await st.click()
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path="tests/shots/anim_mb_live1.png")
        await pg.wait_for_timeout(6000)
        await pg.screenshot(path="tests/shots/anim_mb_live2.png")
        print("\n".join(errs) or "no console errors")
        await b.close()
asyncio.run(main())
