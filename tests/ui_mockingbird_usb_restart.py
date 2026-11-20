"""A restart test on a board whose USB port drops while it restarts (a Pico,
an ESP32-S3, a Teensy). A stand-in Web Serial port is wired to MockingbirdTry
compiled for this PC; when the board says RESTARTING, the port disappears for
0.8 s, like USB re-enumerating, and its READY is lost. Mockingbird has to find
the port again, reopen it, ask who's there, and resume the test."""
import asyncio
import os
from playwright.async_api import async_playwright

CHROME = {"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}
URL = "http://127.0.0.1:47730/"
BIN = "build/native/MockingbirdTry"
SHOTS = "tests/shots/"

FAKE_USB = """
(() => {
  class FakePort {
    constructor() { this.gone = false; this.readable = null; this.writable = null; }
    getInfo() { return { usbVendorId: 0x2e8a, usbProductId: 0x000a }; }
    async open(opts) {
      if (this.gone) throw new DOMException("The device has been lost.", "NetworkError");
      const self = this;
      this.readable = new ReadableStream({ start(c) { self.ctrl = c; } });
      this.writable = new WritableStream({ write(chunk) { return self.gone ? undefined : window.__serialWrite(new TextDecoder().decode(chunk)); } });
      window.__serialPush = (t) => { if (self.gone) return; try { self.ctrl.enqueue(new TextEncoder().encode(t)); } catch (e) {} };
      await window.__serialOpen(opts.baudRate);
    }
    async setSignals(s) {}                       // native USB: DTR doesn't reset it
    async close() { try { this.ctrl.close(); } catch (e) {} this.readable = null; this.writable = null; if (!this.gone) await window.__serialClose(); }
  }
  const port = new FakePort();
  const serial = new EventTarget();
  serial.getPorts = async () => (port.gone ? [] : [port]);
  serial.requestPort = async () => port;
  Object.defineProperty(navigator, "serial", { value: serial, configurable: true });
  window.__usbDrop = () => {
    port.gone = true;
    try { port.ctrl.error(new DOMException("The device has been lost.", "NetworkError")); } catch (e) {}
    port.readable = null; port.writable = null;
    const ev = new Event("disconnect"); Object.defineProperty(ev, "port", { value: port }); serial.dispatchEvent(ev);
  };
  window.__usbBack = () => { port.gone = false; serial.dispatchEvent(new Event("connect")); };
})();
"""


async def main():
    os.makedirs(SHOTS, exist_ok=True)
    state = {"proc": None, "drops": 0}
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=["--no-sandbox", "--no-proxy-server"])
        pg = await b.new_page(viewport={"width": 1480, "height": 940})
        errs = []
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))

        async def drop_and_return():
            state["drops"] += 1
            await pg.evaluate("window.__usbDrop()")
            await asyncio.sleep(0.8)
            await pg.evaluate("window.__usbBack()")

        async def pump(proc):
            buf = ""
            while True:
                data = await proc.stdout.read(512)
                if not data:
                    break
                text = data.decode()
                buf += text
                try:
                    await pg.evaluate("t => window.__serialPush && window.__serialPush(t)", text)
                except Exception:
                    break
                if "$MBE,RESTARTING" in buf:
                    buf = ""
                    asyncio.ensure_future(drop_and_return())
                buf = buf[-200:]

        async def on_open(source, baud):
            if not state["proc"]:
                state["proc"] = await asyncio.create_subprocess_exec(BIN, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                asyncio.ensure_future(pump(state["proc"]))

        async def on_write(source, text):
            if state["proc"]:
                state["proc"].stdin.write(text.encode())
                await state["proc"].stdin.drain()

        async def on_close(source):
            proc = state["proc"]
            state["proc"] = None
            if proc:
                try:
                    proc.stdin.close()
                    await asyncio.wait_for(proc.wait(), 2)
                except Exception:
                    proc.kill()

        await pg.expose_binding("__serialOpen", on_open)
        await pg.expose_binding("__serialReset", lambda s: None)
        await pg.expose_binding("__serialWrite", on_write)
        await pg.expose_binding("__serialClose", on_close)
        await pg.add_init_script(FAKE_USB)
        await pg.goto(URL)
        await pg.wait_for_timeout(800)
        if await pg.locator(".app-header button:has-text('Disconnect')").count():
            await pg.click(".app-header button:has-text('Disconnect')")
        await pg.click(".app-header button:has-text('Connect')")
        await pg.click(".conn-card:has-text('Your flight computer')")
        await pg.wait_for_timeout(300)
        await pg.click(".modal-foot button:has-text('Connect')")
        await pg.wait_for_selector(".pill:has-text('Ready: MockingbirdTry')", timeout=10000)

        await pg.click(".mb-main > .tabs button:has-text('Run')")
        await pg.click(".test-item:has-text('Restart while coasting')")
        await pg.click(".run-bar .seg button:has-text('2×')")
        await pg.click(".run-bar button:has-text('Start test')")
        await pg.click(".modal-foot button:has-text('Charges are disconnected')")
        await pg.wait_for_selector(".verdict-box", timeout=120000)
        await pg.wait_for_timeout(1200)
        checks = await pg.eval_on_selector_all(".checks li", "els => els.map(e => e.innerText.replace(/\\n/g, ' | '))")
        print("\n".join(checks))
        await pg.click(".run-side .tabs button:has-text('Events')")
        await pg.wait_for_timeout(300)
        ev = await pg.eval_on_selector_all(".events li", "els => els.map(e => e.innerText.replace(/\\n/g, ' '))")
        print("\n".join(e for e in ev if any(k in e for k in ("USB", "Reconnected", "restart", "back after", "unplugged"))))
        await pg.screenshot(path=SHOTS + "mb_new_usb_restart.png")
        assert state["drops"] == 1, state
        assert any("Reconnected to the board" in e for e in ev), "Mockingbird reopened the port"
        restart = next(c for c in checks if c.startswith("✓ | Restart") or c.startswith("✕ | Restart"))
        assert restart.startswith("✓"), restart
        assert not any("unplugged" in e for e in ev)
        print("errors:", errs)
        assert not errs, errs
        await on_close(None)
        await b.close()

asyncio.run(main())
