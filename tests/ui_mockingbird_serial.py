"""Mockingbird's serial path, end to end: a stand-in Web Serial port in the
browser is wired to the MockingbirdTry example compiled for this PC, so the
real UI, serial code, protocol and Arduino library all run together."""
import asyncio
import os
from playwright.async_api import async_playwright

# use the system Chrome when there is one, else Playwright's own browser
CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}

URL = "http://127.0.0.1:47730/"
BIN = "build/native/MockingbirdTry"
SHOTS = "tests/shots/"

FAKE_SERIAL = """
(() => {
  class FakePort {
    getInfo() { return { usbVendorId: 0x1a86, usbProductId: 0x7523 }; }
    async open(opts) {
      const self = this;
      this.readable = new ReadableStream({ start(c) { self.ctrl = c; } });
      this.writable = new WritableStream({ write(chunk) { return window.__serialWrite(new TextDecoder().decode(chunk)); } });
      window.__serialPush = (t) => { try { self.ctrl.enqueue(new TextEncoder().encode(t)); } catch (e) {} };
      await window.__serialOpen(opts.baudRate);
    }
    async setSignals(s) { if (s.dataTerminalReady) await window.__serialReset(); }
    async close() { try { this.ctrl.close(); } catch (e) {} await window.__serialClose(); }
  }
  const port = new FakePort();
  const serial = new EventTarget();
  serial.getPorts = async () => [port];
  serial.requestPort = async () => port;
  Object.defineProperty(navigator, "serial", { value: serial, configurable: true });
})();
"""

async def main():
    state = {"proc": None, "reader": None, "rx": 0, "tx": 0}
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940})
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error",) else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))

        async def pump(proc):
            while True:
                data = await proc.stdout.read(512)
                if not data:
                    break
                state["rx"] += len(data)
                try:
                    await pg.evaluate("t => window.__serialPush(t)", data.decode())
                except Exception:
                    break

        async def start_board():
            if state["proc"]:
                return
            state["proc"] = await asyncio.create_subprocess_exec(BIN, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
            state["reader"] = asyncio.ensure_future(pump(state["proc"]))

        async def stop_board():
            proc = state["proc"]
            state["proc"] = None
            if proc:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), 2)
                except Exception:
                    proc.kill()

        async def on_open(source, baud):
            await start_board()

        async def on_reset(source):  # DTR: restart the board, like an Arduino auto-reset
            await stop_board()
            await start_board()

        async def on_write(source, text):
            state["tx"] += len(text)
            if state["proc"]:
                state["proc"].stdin.write(text.encode())
                await state["proc"].stdin.drain()

        async def on_close(source):
            await stop_board()

        await pg.expose_binding("__serialOpen", on_open)
        await pg.expose_binding("__serialReset", on_reset)
        await pg.expose_binding("__serialWrite", on_write)
        await pg.expose_binding("__serialClose", on_close)
        await pg.add_init_script(FAKE_SERIAL)
        await pg.goto(URL)
        await pg.wait_for_timeout(800)
        # make sure we start disconnected
        if await pg.locator(".app-header button:has-text('Disconnect')").count():
            await pg.click(".app-header button:has-text('Disconnect')")
        await pg.click(".app-header button:has-text('Connect')")
        await pg.click(".conn-card:has-text('Your flight computer')")
        await pg.wait_for_timeout(300)
        await pg.click(".modal-foot button:has-text('Connect')")
        await pg.wait_for_selector(".pill:has-text('Ready: MockingbirdTry')", timeout=10000)
        print("pill:", await pg.inner_text(".app-header .pill"))
        await pg.screenshot(path=SHOTS + "mb_serial_ready.png")

        await pg.click(".app-main .tabs button:has-text('Run')") if await pg.locator(".app-main .tabs button:has-text('Run')").count() else await pg.click(".tabs button:has-text('Run')")
        await pg.click(".test-item:has-text('Normal flight')")
        await pg.click(".run-bar .seg button:has-text('4×')")
        await pg.click(".run-bar button:has-text('Start test')")
        await pg.click(".modal-foot button:has-text('Charges are disconnected')")
        await pg.wait_for_timeout(9000)
        await pg.screenshot(path=SHOTS + "mb_serial_running.png")
        await pg.wait_for_selector(".verdict-box", timeout=90000)
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=SHOTS + "mb_serial_result.png")
        print("verdict:", await pg.inner_text(".verdict-box .big"))
        kv = await pg.eval_on_selector_all(".result .kv", "els => els.map(e => e.innerText.replace(/\\n/g, ' | '))")
        print("\n".join(kv))
        checks = await pg.eval_on_selector_all(".checks li", "els => els.map(e => e.innerText.replace(/\\n/g, ' '))")
        print("\n".join(checks))
        print(f"bytes to board {state['tx']}, from board {state['rx']}")
        await pg.click(".app-header button:has-text('Disconnect')")
        await pg.wait_for_timeout(500)
        print("\n".join(errs) or "no console errors")
        await stop_board()
        await b.close()

asyncio.run(main())
