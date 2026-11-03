import asyncio
import os
from playwright.async_api import async_playwright

# use the system Chrome when there is one, else Playwright's own browser
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
        await pg.screenshot(path="tests/shots/heron_empty.png")
        btn = pg.locator("button:has-text('Try a sample flight')")
        if await btn.count(): await btn.click()
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path="tests/shots/heron_overview.png")
        await pg.click(".tabs button:has-text('Model vs flight')")
        await pg.wait_for_timeout(500)
        await pg.click("button:has-text('Simulate')")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path="tests/shots/heron_model.png")
        await pg.click(".tabs button:has-text('Data and notes')")
        await pg.wait_for_timeout(600)
        await pg.screenshot(path="tests/shots/heron_data.png")
        # tick an Owl recording for compare
        items = pg.locator(".lib-item input[type=checkbox]")
        n = await items.count()
        for i in range(min(n, 3)): await items.nth(i).check()
        await pg.click(".tabs button:has-text('Compare flights')")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path="tests/shots/heron_compare.png")
        await pg.click(".tabs button:has-text('Overview')")
        await pg.wait_for_timeout(500)
        await pg.click("button:has-text('Columns')")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path="tests/shots/heron_columns.png")
        print("\n".join(errs) or "no console errors")
        await b.close()
asyncio.run(main())
