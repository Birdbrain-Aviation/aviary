// Serial ports through the browser's Web Serial API (Edge and Chrome on
// Windows). The browser shows its own port picker the first time; after that
// the port is remembered and can be reopened with one click.

const VENDORS = {
  0x2341: "Arduino", 0x2a03: "Arduino", 0x1a86: "CH340 USB-serial", 0x10c4: "CP210x USB-serial", 0x0403: "FTDI USB-serial",
  0x2e8a: "Raspberry Pi RP2040/RP2350", 0x16c0: "Teensy", 0x303a: "Espressif ESP32", 0x0483: "STM32", 0x239a: "Adafruit",
  0x1b4f: "SparkFun", 0x067b: "Prolific USB-serial", 0x04d8: "Microchip", 0x1366: "SEGGER J-Link", 0x0d28: "DAPLink", 0x1209: "Open hardware",
};

export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

export function describePort(port, i = 0) {
  const info = port?.getInfo ? port.getInfo() : {};
  const v = info.usbVendorId, p = info.usbProductId;
  if (v === undefined) return port?.label || `Serial port ${i + 1}`;
  const hex = (x) => x.toString(16).padStart(4, "0");
  return `${VENDORS[v] || "USB device"} (${hex(v)}:${hex(p ?? 0)})`;
}

export const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 250000, 460800, 500000, 921600, 1000000];

// A line-oriented serial connection.
export class SerialLink {
  constructor({ onLine, onStatus, onBytes } = {}) {
    this.onLine = onLine; this.onStatus = onStatus; this.onBytes = onBytes;
    this.port = null; this.reader = null; this.writer = null; this.open = false;
    this.rx = 0; this.tx = 0; this.lines = 0; this._buf = "";
    this.eol = "\n";
    this._q = Promise.resolve();
    this._pending = 0;
    if (serialSupported()) {
      navigator.serial.addEventListener("disconnect", (e) => {
        if (e.target === this.port || (e.port && e.port === this.port)) { this._status("lost", "The device was unplugged."); this._teardown(); }
      });
    }
  }

  _status(type, message) { this.onStatus && this.onStatus({ type, message }); }

  async grantedPorts() { return serialSupported() ? navigator.serial.getPorts() : []; }

  async choose(filters) {
    if (!serialSupported()) throw new Error("This window can't use serial ports. Open the app in Microsoft Edge or Google Chrome.");
    try { return await navigator.serial.requestPort(filters ? { filters } : {}); }
    catch (e) { if (e.name === "NotFoundError") return null; throw e; }
  }

  async connect(port, { baudRate = 115200, dtr = true, rts = false, dataBits = 8, stopBits = 1, parity = "none", flowControl = "none" } = {}) {
    if (this.open) await this.close();
    this.port = port;
    try {
      await port.open({ baudRate: Number(baudRate), dataBits, stopBits, parity, flowControl, bufferSize: 65536 });
    } catch (e) {
      this.port = null;
      if (/already open/i.test(e.message)) throw new Error("That port is already open in another program (Arduino IDE serial monitor, another app window, or a terminal). Close it there and try again.");
      throw new Error("Could not open the port: " + e.message);
    }
    try { await port.setSignals({ dataTerminalReady: !!dtr, requestToSend: !!rts }); } catch { /* not all drivers allow it */ }
    this.open = true; this.rx = 0; this.tx = 0; this.lines = 0; this._buf = "";
    this.writer = port.writable.getWriter();
    this._status("open", `Connected at ${baudRate} baud`);
    this._readLoop();
  }

  async _readLoop() {
    const dec = new TextDecoder();
    while (this.open && this.port?.readable) {
      try {
        this.reader = this.port.readable.getReader();
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (!value) continue;
          this.rx += value.length;
          this.onBytes && this.onBytes(value);
          this._feed(dec.decode(value, { stream: true }));
        }
      } catch (e) {
        if (!this.open) break;
        // Framing/overrun errors are recoverable; a lost device is not.
        if (/lost|disconnected|NetworkError/i.test(e.message || e.name)) { this._status("lost", "The device stopped responding or was unplugged."); this._teardown(); break; }
        this._status("warn", e.message || String(e));
      } finally {
        try { this.reader && this.reader.releaseLock(); } catch { /* */ }
        this.reader = null;
      }
    }
  }

  _feed(text) {
    this._buf += text;
    let i;
    while ((i = this._buf.search(/[\r\n]/)) >= 0) {
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (line.length) { this.lines++; this.onLine && this.onLine(line); }
    }
    if (this._buf.length > 8192) { this.onLine && this.onLine(this._buf); this._buf = ""; }
  }

  // Writes are queued so they never interleave.
  write(text) {
    if (!this.open || !this.writer) return Promise.reject(new Error("Not connected"));
    const data = new TextEncoder().encode(text);
    this._pending++;
    this._q = this._q.then(() => this.writer.write(data)).then(() => { this.tx += data.length; }).catch((e) => this._status("warn", "Write failed: " + e.message)).finally(() => { this._pending--; });
    return this._q;
  }
  writeLine(text) { return this.write(text + this.eol); }
  get backlog() { return this._pending; }

  async setSignals(sig) { if (this.port) await this.port.setSignals(sig); }

  // Pulse DTR low then high: resets most Arduino-style boards.
  async resetBoard() {
    if (!this.port) return;
    try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); await new Promise((r) => setTimeout(r, 120)); await this.port.setSignals({ dataTerminalReady: true }); } catch { /* */ }
  }

  _teardown() {
    this.open = false;
    try { this.reader && this.reader.cancel(); } catch { /* */ }
    try { this.writer && this.writer.releaseLock(); } catch { /* */ }
    this.writer = null;
    const p = this.port; this.port = null;
    if (p) p.close().catch(() => {});
  }

  async close() {
    if (!this.port) return;
    this.open = false;
    const r = this.reader;
    try { if (r) { await r.cancel(); r.releaseLock(); } } catch { /* */ }
    try { await this._q; } catch { /* */ }
    try { this.writer && this.writer.releaseLock(); } catch { /* */ }
    this.writer = null;
    try { await this.port.close(); } catch { /* */ }
    this.port = null;
    this._status("closed", "Disconnected");
  }
}
