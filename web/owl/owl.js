// Owl — ground station for any rocket's telemetry.
import { h, clear, toast, modal, numField, textField, selectField, checkField, seg, tabs, debounce, setTheme, fmtTime, stamp, safeName, appHeader, readFileText, pickFile } from "/shared/js/ui.js";
import { host, connectEvents, onEvent, loadSettings } from "/shared/js/host.js";
import { display, fmt, G0 } from "/shared/js/units.js";
import { TimeChart, ChartGroup } from "/shared/js/chart.js";
import { SerialLink, serialSupported, describePort, BAUDS } from "/shared/js/serial.js";
import { LineParser, applyMapping, suggestMapping, PhaseTracker, DEMO_HEADER, demoLine, isNum } from "/shared/js/telemetry.js";
import { ROLES, ROLE_BY_ID, UNIT_CHOICES } from "/shared/js/fields.js";
import { TileMap, distanceBearing, compassName } from "/shared/js/map.js";
import { drawQR } from "/shared/js/qr.js";
import { FlightSim, rng } from "/shared/js/sim.js";
import { loadRockets } from "/shared/js/rockets.js";
import { altitudeFromPressure } from "/shared/js/atmosphere.js";
import { openChecklist, checklistRecord, checklistProgress, openRecoveryMode } from "./fieldtools.js";
import { openCompanion, companionTick } from "./companion.js";

const DEFAULTS = {
  theme: "day", units: "imperial", voice: true, record: true, flightName: "",
  source: { type: "serial", baud: 115200, dtr: true, udpPort: 4210, demoRocket: "", demoSpeed: 1, demoWind: 4, replaySpeed: 1 },
  parser: { format: "auto", delimiter: "auto", prefix: "", fieldNames: "" },
  mapping: {},
  altAgl: false,
  station: { ref: "pad", lat: null, lon: null },
  alarms: { battLow: 0, signalLost: 3 },
};

const RAIL = [["pad", "Pad"], ["boost", "Boost"], ["coast", "Coast"], ["drogue", "Descent"], ["main", "Main"], ["landed", "Landed"]];
const RAIL_INDEX = { pad: 0, boost: 1, coast: 2, descent: 3, drogue: 3, main: 4, landed: 5 };

let set; // settings
let D;   // unit display helpers
const S = {
  source: null, connecting: false,
  t0: performance.now(), packets: 0, recvTimes: [], lastRecv: null,
  clock: { useTlm: null, lastTlm: null, lastT: null, lastRecv: null, offset: 0 },
  parser: null, tracker: new PhaseTracker(),
  latest: {}, fields: {}, fieldOrder: [],
  gps: { last: null, pad: null, padSamples: [], track: [], hadFix: false },
  p0: null, launchT: null, phaseTimes: {},
  events: [], consoleLines: [], consolePaused: false,
  rec: null, signalLost: false, battWarned: false,
};
const ui = {};

const nowS = () => (performance.now() - S.t0) / 1000;

// ------------------------------------------------------------------ startup
async function main() {
  set = await loadSettings(DEFAULTS);
  D = display(set.units);
  setTheme(set.theme);
  S.parser = new LineParser(set.parser);
  connectEvents();
  buildUI();
  loadRockets(host).then((st) => { ui.store = st; renderChecklistBtn(); }).catch(() => {});
  setInterval(tick, 200);
  setInterval(() => companionTick(phoneCtx()), 250);
  window.addEventListener("beforeunload", () => { flushRecording(true); });
}

// ------------------------------------------------------------------ layout
function buildUI() {
  const app = document.getElementById("app");
  ui.pill = h("span", { class: "pill" }, h("span", { class: "dot" }), "Not connected");
  ui.rate = h("span", { class: "muted", style: { fontSize: "13px", minWidth: "58px" } });
  ui.recBtn = h("button", { class: "btn small", title: "Record incoming telemetry to Documents\\Aviary\\Owl Recordings", onclick: toggleRecord });
  ui.connectBtn = h("button", { class: "btn primary", onclick: () => (S.source ? disconnect() : openConnect()) }, "Connect");
  ui.nameInput = h("input", { type: "text", value: set.flightName, placeholder: "Flight name", "aria-label": "Flight name", style: { width: "190px", height: "30px" }, onchange: () => { set.flightName = ui.nameInput.value; set.save(); } });
  ui.checkBtn = h("button", { class: "btn small", title: "Pre-flight checklist for the rocket you're flying", onclick: showChecklist }, "Checklist");
  ui.phoneBtn = h("button", { class: "btn small", title: "Show Owl's readouts and a recovery arrow on your phone", onclick: () => openCompanion(phoneCtx()) }, "Phone");
  const tools = [
    ui.pill, ui.rate, ui.checkBtn, ui.phoneBtn, ui.recBtn,
    h("button", { class: "btn small", title: "Clear the screen and start a new recording, keeping the connection", onclick: newFlight }, "New flight"),
    h("button", { class: "btn small", onclick: openSettings }, "Settings"),
    ui.connectBtn,
  ];
  const header = appHeader("owl", "Owl", ui.nameInput, tools);

  // phase rail + clock
  ui.rail = h("div", { class: "phase-rail", role: "list", "aria-label": "Flight phase" },
    RAIL.map(([k, l]) => h("div", { class: "ph", "data-k": k, role: "listitem" }, l, h("span", { class: "t" }))));
  ui.tplus = h("div", { class: "v" }, "T−");
  const rail = h("div", { class: "owl-rail" }, ui.rail, h("div", { class: "tplus" }, h("div", { class: "k" }, "Flight time"), ui.tplus));

  // hero readout
  ui.altN = h("span", { class: "n" }, "–");
  ui.altU = h("span", { class: "u" }, D.altUnit);
  ui.maxV = h("div", { class: "v" }, "–");
  ui.vsV = h("div", { class: "v" }, "–");
  ui.stateV = h("div", { class: "v" }, "–");
  const hero = h("div", { class: "alt-hero" },
    h("div", { class: "k" }, "Altitude above the pad"),
    h("div", { class: "big" }, ui.altN, ui.altU),
    h("div", { class: "subs" },
      h("div", null, h("div", { class: "k muted" }, "Highest"), ui.maxV),
      h("div", null, h("div", { class: "k muted" }, "Vertical speed"), ui.vsV),
      h("div", null, h("div", { class: "k muted" }, "Flight computer"), ui.stateV)));
  ui.tiles = h("div", { class: "tiles" });
  const readout = h("section", { class: "panel readout", "aria-label": "Live readouts" }, hero, h("div", { class: "panel-body flush" }, ui.tiles));

  // charts
  const group = new ChartGroup();
  const c1 = h("div"), c2 = h("div");
  const charts = h("section", { class: "panel charts" },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Altitude and speed"), h("span", { class: "hint" }, "Drag to zoom, double-click to follow live"),
      h("div", { class: "spacer" }), h("button", { class: "btn small ghost", onclick: () => { ui.altChart.resetView(); } }, "Follow live")),
    h("div", { class: "panel-body flush" }, h("div", { class: "chart-stack" }, c1, c2)));
  ui.c1 = c1; ui.c2 = c2; ui.group = group;

  // recovery
  ui.recBody = h("div", { class: "rec-body" });
  ui.refSeg = seg([["pad", "From the pad"], ["station", "From this laptop"]], set.station.ref, (v) => { set.station.ref = v; set.save(); if (v === "station" && set.station.lat == null) useMyLocation(); renderRecovery(); });
  const recovery = h("section", { class: "panel recovery", "aria-label": "Recovery" },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Recovery"), h("div", { class: "spacer" }),
      h("button", { class: "btn small", title: "Full-screen arrow and distance to the rocket, from this laptop's live location", onclick: () => openRecoveryMode({ D, last: () => S.gps.last, pad: () => S.gps.pad }) }, "Recovery mode"), ui.refSeg),
    h("div", { class: "panel-body flush" }, ui.recBody));

  // map
  ui.mapEl = h("div", { style: { position: "absolute", inset: "0" } });
  ui.followMap = true;
  ui.followBtn = h("button", { class: "btn small on", onclick: () => { ui.followMap = !ui.followMap; ui.followBtn.classList.toggle("on", ui.followMap); renderMap(true); } }, "Follow rocket");
  const mapbox = h("section", { class: "panel mapbox", "aria-label": "Map" },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Map"), h("span", { class: "hint", id: "maphint" }, "Tiles you view are saved for offline use"), h("div", { class: "spacer" }),
      h("button", { class: "btn small", title: "Download the map and ground heights around the map's centre, for use without internet (also used by the 3D views in Heron and Mockingbird)", onclick: () => saveArea(ui.map.lat, ui.map.lon) }, "Save area for offline"), ui.followBtn),
    h("div", { class: "panel-body flush", style: { position: "relative" } }, ui.mapEl));

  // side tabs
  ui.sideBody = h("div", { class: "side-body" });
  ui.sendRow = h("div", { class: "send-row" });
  ui.sideTab = "events";
  const sideTabs = tabs([["events", "Events"], ["console", "Raw data"], ["fields", "Fields"]], "events", (v) => { ui.sideTab = v; renderSide(true); });
  const side = h("section", { class: "panel side" }, sideTabs, ui.sideBody, ui.sendRow);

  const grid = h("main", { class: "owl-grid app-body" }, rail, readout, charts, recovery, mapbox, side);
  app.append(header, grid);

  // charts
  ui.altChart = new TimeChart(c1, { group, streaming: true, xWindow: 90, yLabel: `Altitude (${D.altUnit})`, xLabel: "Time from launch (s)", yIncludeZero: true, xFormat: (x) => `T${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)} s` });
  ui.altChart.addSeries({ id: "alt", label: "Altitude", color: "--d-alt", unit: D.altUnit, digits: 0, width: 2 });
  ui.velChart = new TimeChart(c2, { group, streaming: true, xWindow: 90, yLabel: `Speed (${D.velUnit})`, xLabel: "", xFormat: (x) => `T${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)} s` });
  ui.velChart.addSeries({ id: "vel", label: "Vertical speed", color: "--d-vel", unit: D.velUnit, digits: 0 });
  ui.velChart.addSeries({ id: "acc", label: "Acceleration", color: "--d-acc", unit: "g", digits: 1, axis: "y2", visible: false });
  ui.velChart.o.y2Label = "Acceleration (g)";

  ui.map = new TileMap(ui.mapEl, { lat: 39.5, lon: -98.35, zoom: 4 });
  ui.map.onUserMove = () => { ui.followMap = false; ui.followBtn.classList.remove("on"); };
  renderRecord(); renderRecovery(); renderSide(true); renderReadouts(); renderMap(true);
}

// ------------------------------------------------------------------ sources
function openConnect() {
  let type = set.source.type;
  const cards = h("div", { class: "conn-cards" });
  const body = h("div");
  const pane = h("div");
  const kinds = [
    ["serial", "Serial port", "USB radio receiver or flight computer cable"],
    ["udp", "Wi-Fi (UDP)", "Boards that send packets over a network"],
    ["demo", "Demo flight", "A simulated flight to try Owl"],
    ["replay", "Replay", "Play back a recording"],
  ];
  const state = { port: null, granted: [], replayText: null, replayName: "" };
  const draw = async () => {
    clear(cards);
    for (const [k, t, d] of kinds) cards.append(h("button", { class: "conn-card" + (k === type ? " on" : ""), onclick: () => { type = k; draw(); } }, h("b", null, t), h("span", null, d)));
    clear(pane);
    if (type === "serial") {
      if (!serialSupported()) { pane.append(h("p", { class: "note" }, "Serial ports need Microsoft Edge or Google Chrome. Owl opens in Edge automatically; if you are seeing this in another browser, open the same address in Edge.")); return; }
      state.granted = await new SerialLink().grantedPorts();
      const portLabel = h("span", { class: "muted" }, state.port ? describePort(state.port) : "No port chosen yet");
      const list = h("div", { class: "col", style: { gap: "4px", margin: "8px 0" } });
      state.granted.forEach((p, i) => list.append(h("label", { class: "check" }, h("input", { type: "radio", name: "port", checked: state.port === p, onchange: () => { state.port = p; portLabel.textContent = describePort(p, i); } }), describePort(p, i))));
      pane.append(
        h("div", { class: "row" }, h("button", { class: "btn", onclick: async () => { try { const p = await new SerialLink().choose(); if (p) { state.port = p; draw(); } } catch (e) { toast(e.message, "fault"); } } }, "Choose port…"), portLabel),
        state.granted.length ? h("div", null, h("div", { class: "sub-title" }, "Ports you've used before"), list) : h("p", { class: "note" }, "Your browser lists USB serial devices when you click Choose port. Plug the radio or board in first."),
        h("div", { class: "grid-form", style: { marginTop: "10px" } },
          selectField("Baud rate", set.source.baud, BAUDS.map((b) => [b, String(b)]), (v) => { set.source.baud = Number(v); set.save(); }),
          h("div", { class: "field" }, h("span", null, "On connect"), checkField("Reset the board (DTR)", set.source.dtr, (v) => { set.source.dtr = v; set.save(); }, { title: "Most Arduino boards restart when the port opens with DTR on. Turn this off to connect without restarting." }))),
      );
      if (!state.port && state.granted.length === 1) { state.port = state.granted[0]; portLabel.textContent = describePort(state.port); }
    } else if (type === "udp") {
      let addrs = [];
      try { addrs = (await host.get("/api/udp/status")).addresses || []; } catch { /* */ }
      pane.append(
        h("div", { class: "grid-form" }, numField("Listen on UDP port", set.source.udpPort, "", (v) => { set.source.udpPort = v; set.save(); }, { min: 1, max: 65535, step: 1 })),
        h("p", { class: "note" }, `Send lines of text to this computer${addrs.length ? " (" + addrs.join(", ") + ")" : ""} on that port. Windows may ask to allow Owl through the firewall the first time.`));
    } else if (type === "demo") {
      const store = await loadRockets(host);
      if (!set.source.demoRocket || !store.rockets.find((r) => r.id === set.source.demoRocket)) set.source.demoRocket = store.selected;
      state.store = store;
      pane.append(h("div", { class: "grid-form" },
        selectField("Rocket", set.source.demoRocket, store.rockets.map((r) => [r.id, r.name]), (v) => { set.source.demoRocket = v; set.save(); }),
        selectField("Speed", set.source.demoSpeed, [[1, "Real time"], [2, "2× faster"], [5, "5× faster"]], (v) => { set.source.demoSpeed = Number(v); set.save(); }),
        numField("Wind", +D.vel(set.source.demoWind).toFixed(1), D.velUnit, (v) => { set.source.demoWind = D.fromVel(v ?? 0); set.save(); })),
        h("p", { class: "note" }, "Plays a simulated flight from the rocket profiles shared with Mockingbird and Heron, sent as CSV telemetry with GPS. Edit rockets in Mockingbird."));
    } else if (type === "replay") {
      let files = [];
      try { files = (await host.list("owl")).files.filter((f) => !f.dir && /raw\.txt$/i.test(f.name)); } catch { /* */ }
      const lst = h("div", { class: "col", style: { gap: "4px", maxHeight: "220px", overflow: "auto", margin: "6px 0" } });
      files.slice(0, 40).forEach((f) => lst.append(h("label", { class: "check" }, h("input", { type: "radio", name: "rep", onchange: async () => { state.replayText = await host.read("owl", f.path); state.replayName = f.path.split("/")[0]; } }), f.path.split("/")[0])));
      pane.append(
        files.length ? h("div", null, h("div", { class: "sub-title" }, "Recordings"), lst) : h("p", { class: "note" }, "No recordings yet. Owl records automatically while connected."),
        h("div", { class: "row", style: { marginTop: "8px" } },
          h("button", { class: "btn", onclick: async () => { const f = await pickFile(".txt,.csv,.log"); if (f) { state.replayText = await readFileText(f); state.replayName = f.name; toast(`Loaded ${f.name}`); } } }, "Open a file…"),
          selectField("Speed", set.source.replaySpeed, [[1, "Real time"], [2, "2×"], [5, "5×"], [10, "10×"]], (v) => { set.source.replaySpeed = Number(v); set.save(); })));
    }
  };
  body.append(cards, pane);
  draw();
  modal({
    title: "Connect", body, wide: true,
    actions: [{ label: "Cancel" }, {
      label: "Connect", kind: "primary", onClick: async () => {
        set.source.type = type; set.save();
        try {
          if (type === "serial") { if (!state.port) { toast("Choose a serial port first.", "fault"); return false; } await startSerial(state.port); }
          else if (type === "udp") await startUDP(set.source.udpPort);
          else if (type === "demo") await startDemo(state.store.rockets.find((r) => r.id === set.source.demoRocket));
          else if (type === "replay") { if (!state.replayText) { toast("Pick a recording or open a file first.", "fault"); return false; } startReplay(state.replayText, state.replayName); }
        } catch (e) { toast(e.message, "fault", 7000); return false; }
      },
    }],
  });
}

async function startSerial(port) {
  const link = new SerialLink({
    onLine: (l) => onLine(l),
    onStatus: (s) => { if (s.type === "lost") { logEvent("Serial device lost", "bad", s.message); disconnect(true); } else if (s.type === "warn") consoleAdd(s.message, "err"); },
  });
  await link.connect(port, { baudRate: set.source.baud, dtr: set.source.dtr });
  attachSource({ type: "serial", label: describePort(port), send: (t) => link.writeLine(t), stop: () => link.close() });
}

let udpHooked = false;
async function startUDP(port) {
  await host.post("/api/udp/start", { port });
  if (!udpHooked) { onEvent("udp", (d) => { if (S.source?.type === "udp") for (const l of d.lines) onLine(l); }); udpHooked = true; }
  attachSource({ type: "udp", label: `UDP port ${port}`, send: (t) => host.post("/api/udp/send", { text: t + "\n" }), stop: () => host.post("/api/udp/stop", {}) });
}

async function startDemo(rocket) {
  if (!rocket) throw new Error("Choose a rocket for the demo.");
  const store = await loadRockets(host);
  const sim = new FlightSim(rocket, { ...store.site, windSpeed: set.source.demoWind }, { mode: "ideal" });
  const R = rng(Date.now() & 0xffff);
  const speed = set.source.demoSpeed || 1, pad = 8, rate = 10;
  let stopped = false, n = 0, batt = 8.25;
  const send = (l) => onLine(l);
  send(DEMO_HEADER);
  const timer = setInterval(() => {
    if (stopped) return;
    for (let k = 0; k < speed; k++) {
      if (!sim.launched && sim.t >= pad) sim.launch();
      sim.step(1 / rate);
      n++;
      if (n % (rate * 10) === 0) send(DEMO_HEADER);
      if (sim.landed && sim.t - sim.landed.t > 25) { send("# demo flight finished"); stopped = true; clearInterval(timer); logEvent("Demo finished", "", "Choose Disconnect or New flight"); return; }
      if (R() < 0.03) continue; // dropped packet
      const m = sim.measure({ baroNoise: 2, accelNoise: 0.15, gpsNoise: 1.5 }, R);
      m.t -= pad; // flight computer clock starts with launch at 0
      batt -= 0.00008;
      const dist = Math.hypot(sim.x, sim.y, sim.h);
      send(demoLine(m, sim.phase, batt, -48 - 20 * Math.log10(1 + dist / 30) + R.gauss() * 2));
    }
  }, 1000 / rate);
  attachSource({ type: "demo", label: `Demo flight (${rocket.name.replace(/^Example:\s*/, "")})`, stop: () => { stopped = true; clearInterval(timer); } });
}

function startReplay(text, name) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const timed = lines.length && lines.slice(0, 20).every((l) => /^\d+\t/.test(l));
  const items = lines.map((l, i) => { if (timed) { const k = l.indexOf("\t"); return [Number(l.slice(0, k)), l.slice(k + 1)]; } return [i * 100, l]; });
  const speed = set.source.replaySpeed || 1;
  const start = performance.now(), t0 = items.length ? items[0][0] : 0;
  let i = 0, stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const el = (performance.now() - start) * speed;
    while (i < items.length && items[i][0] - t0 <= el) onLine(items[i++][1]);
    if (i >= items.length) { clearInterval(timer); logEvent("Replay finished", "", name); stopped = true; }
  }, 25);
  attachSource({ type: "replay", label: `Replay: ${name}`, stop: () => { stopped = true; clearInterval(timer); } });
}

function attachSource(src) {
  S.source = src;
  S.lastRecv = null;
  if (!S.packets) S.t0 = performance.now();
  logEvent("Connected", "good", src.label);
  ui.connectBtn.textContent = "Disconnect";
  ui.connectBtn.classList.remove("primary");
  if (set.record && !S.rec) startRecording();
  renderSide(true);
  tick();
}

async function disconnect(silent = false) {
  const src = S.source;
  S.source = null;
  if (src) { try { await src.stop(); } catch { /* */ } if (!silent) logEvent("Disconnected", "", src.label); }
  ui.connectBtn.textContent = "Connect";
  ui.connectBtn.classList.add("primary");
  flushRecording(true);
  renderSide(true);
  tick();
}

// ------------------------------------------------------------------ data path
function onLine(line) {
  const tr = nowS();
  S.lastRecv = performance.now();
  S.recvTimes.push(tr);
  consoleAdd(line, "rx");
  if (S.rec) S.rec.raw.push(`${Math.round(tr * 1000)}\t${line}`);
  let p;
  try { p = S.parser.parse(line); } catch { p = null; }
  if (!p || p.kind === "text") return;
  if (p.kind === "header") { for (const n of p.names) ensureMapping((p.tag ? p.tag + "." : "") + n, true); return; }
  let roles;
  if (p.gps) roles = { ...p.fields };
  else {
    const fields = {};
    for (const [k, v] of Object.entries(p.fields)) {
      const name = p.tag && !/^\w+\.f\d+$/.test(k) && !k.includes(".") ? `${p.tag}.${k}` : k;
      fields[name] = v;
      ensureMapping(name);
      S.fields[name] = { value: v, t: tr };
    }
    roles = applyMapping(fields, set.mapping);
  }
  packet(roles, tr);
}

function ensureMapping(name) {
  if (!S.fieldOrder.includes(name)) S.fieldOrder.push(name);
  if (set.mapping[name]) return;
  const taken = new Set(Object.values(set.mapping).map((m) => m.role).filter(Boolean));
  set.mapping[name] = { ...suggestMapping(name, taken), tile: false };
  set.save();
  ui.fieldsDirty = true;
}

function timeOf(roles, tr) {
  const c = S.clock;
  let t;
  if (Number.isFinite(roles.time)) {
    if (c.useTlm === null) c.useTlm = true;
    if (c.lastTlm !== null && roles.time < c.lastTlm - 0.5) { c.offset += c.lastTlm - roles.time; logEvent("Flight computer clock restarted", "bad"); }
    c.lastTlm = roles.time;
    t = roles.time + c.offset;
  } else if (c.useTlm && c.lastT !== null) t = c.lastT + (tr - c.lastRecv);
  else t = tr;
  if (c.lastT !== null && t < c.lastT) t = c.lastT;
  c.lastT = t; c.lastRecv = tr;
  return t;
}

function packet(roles, tr) {
  S.packets++;
  if (S.signalLost) { S.signalLost = false; logEvent("Signal back", "good"); speak("Signal back"); }
  const t = timeOf(roles, tr);
  for (const [k, v] of Object.entries(roles)) S.latest[k] = { v, t };

  // altitude: from the altitude field, else from pressure, else from GPS
  let alt = roles.alt;
  if (Number.isFinite(alt)) S.haveBaro = true;
  if (!Number.isFinite(alt) && Number.isFinite(roles.pressure)) {
    S.haveBaro = true;
    if (S.p0 === null || (S.launchT === null && S.tracker.launchT === null)) S.p0 = S.p0 === null ? roles.pressure : S.p0 * 0.98 + roles.pressure * 0.02;
    alt = altitudeFromPressure(roles.pressure, S.p0, 288.15);
  }
  if (!Number.isFinite(alt) && !S.haveBaro && Number.isFinite(roles.gps_alt) && (roles.fix === undefined || roles.fix > 0)) alt = roles.gps_alt;
  const hasAltLike = Number.isFinite(alt) || Number.isFinite(roles.vel) || Number.isFinite(roles.acc) || roles.state;
  if (hasAltLike) {
    const evs = S.tracker.update({ t, alt, vel: roles.vel, acc: roles.acc, state: roles.state, altIsAgl: set.altAgl });
    for (const e of evs) onTrackerEvent(e);
  }

  // GPS
  if (Number.isFinite(roles.lat) && Number.isFinite(roles.lon) && !(roles.lat === 0 && roles.lon === 0) && (roles.fix === undefined || roles.fix > 0)) {
    const fix = { lat: roles.lat, lon: roles.lon, alt: roles.gps_alt, t, at: performance.now() };
    if (!S.gps.hadFix) { S.gps.hadFix = true; logEvent("GPS position received", "good", `${roles.lat.toFixed(5)}, ${roles.lon.toFixed(5)}`); speak("GPS lock"); }
    S.gps.last = fix;
    // The drawn track uses the median of the last few fixes, so GPS jitter
    // doesn't turn it into a scribble. The live position stays raw.
    (S.gps.recent ||= []).push([fix.lat, fix.lon]);
    if (S.gps.recent.length > 5) S.gps.recent.shift();
    const med = (k) => S.gps.recent.map((p) => p[k]).sort((a, b) => a - b)[S.gps.recent.length >> 1];
    const sm = [med(0), med(1)];
    const tr0 = S.gps.track[S.gps.track.length - 1];
    if (!tr0 || distanceBearing(tr0, sm).distance > 4) S.gps.track.push(sm);
    if (S.tracker.launchT === null) {
      S.gps.padSamples.push([fix.lat, fix.lon]);
      if (S.gps.padSamples.length > 30) S.gps.padSamples.shift();
      const ms = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
      S.gps.pad = { lat: ms(S.gps.padSamples.map((p) => p[0])), lon: ms(S.gps.padSamples.map((p) => p[1])) };
      // ground heights for this site, quietly, so the 3D views have terrain later
      if (!S.gps.elevAsked && S.gps.padSamples.length >= 5) { S.gps.elevAsked = true; host.post("/api/tiles/prefetch", { lat: S.gps.pad.lat, lon: S.gps.pad.lon, radius: 3000, mapZoom: 12 }).catch(() => {}); }
    }
    ui.recDirty = true; ui.mapDirty = true;
  }

  // battery
  if (set.alarms.battLow > 0 && Number.isFinite(roles.batt) && roles.batt < set.alarms.battLow && !S.battWarned) {
    S.battWarned = true; logEvent("Battery low", "bad", `${roles.batt.toFixed(2)} V`); speak("Battery low");
  }

  // charts (x = time from launch once known)
  const lt = S.tracker.launchT;
  if (lt !== null && S.launchT === null) shiftChartsToLaunch(lt);
  const x = t - (S.launchT ?? 0);
  if (S.tracker.agl !== null && Number.isFinite(alt)) ui.altChart.append("alt", x, D.alt(S.tracker.agl));
  const vel = Number.isFinite(roles.vel) ? roles.vel : S.tracker.vel;
  if (Number.isFinite(vel) && (Number.isFinite(alt) || Number.isFinite(roles.vel))) ui.velChart.append("vel", x, D.vel(vel));
  if (Number.isFinite(roles.acc)) { const s = ui.velChart.getSeries("acc"); if (s.n === 0) { s.visible = true; ui.velChart._legend(); } ui.velChart.append("acc", x, roles.acc / G0); }

  if (S.rec) S.rec.csv.push([t.toFixed(3), fx(S.tracker.agl, 2), fx(vel, 2), fx(roles.acc, 3), fx(roles.pressure, 1), fx(roles.temp, 2), fx(roles.lat, 7), fx(roles.lon, 7), fx(roles.gps_alt, 1), fx(roles.sats, 0), fx(roles.batt, 3), fx(roles.rssi, 0), roles.state ?? "", S.tracker.phase].join(","));
  ui.readoutsDirty = true;
}
const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : "");

function shiftChartsToLaunch(lt) {
  S.launchT = lt;
  for (const c of [ui.altChart, ui.velChart]) for (const s of c.series) { for (let i = 0; i < s.n; i++) s.x[i] -= lt; }
  ui.altChart.redraw(); ui.velChart.redraw();
}

function onTrackerEvent(e) {
  const T = (tt) => S.launchT !== null || S.tracker.launchT !== null ? tt - (S.launchT ?? S.tracker.launchT) : tt;
  if (e.type === "launch") { S.phaseTimes.boost = 0; logEvent("Launch", "hot", "", 0); speak("Launch"); }
  else if (e.type === "apogee") {
    const a = D.fmtAlt(e.detail);
    logEvent("Apogee", "hot", `${a} ${D.altUnit}`, T(e.t));
    speak(`Apogee, ${a.replace(/,/g, "")} ${set.units === "imperial" ? "feet" : "metres"}`);
    ui.altChart.setMarkers([...(ui.altChart.markers || []), { x: T(e.t), label: `Apogee ${a} ${D.altUnit}` }]);
  } else if (e.type === "phase") {
    S.phaseTimes[e.detail] = T(e.t);
    const kind = e.detail === "landed" ? "good" : e.detail === "main" ? "hot" : "";
    logEvent(e.label, kind, "", T(e.t));
    if (e.detail === "main") speak("Main parachute");
    if (e.detail === "landed") { speak("Landed"); writeSummary(); }
    if (e.detail === "coast") speak("Burnout");
  }
  ui.readoutsDirty = true;
}

// ------------------------------------------------------------------ periodic UI
function tick() {
  // signal-lost detection
  if (S.source && S.lastRecv && !S.signalLost && set.alarms.signalLost > 0 && (performance.now() - S.lastRecv) / 1000 > set.alarms.signalLost) {
    S.signalLost = true; logEvent("Signal lost", "bad", `No data for ${set.alarms.signalLost} s`); speak("Signal lost");
  }
  const tr = nowS();
  S.recvTimes = S.recvTimes.filter((x) => tr - x < 5);
  // status pill
  const age = S.lastRecv ? (performance.now() - S.lastRecv) / 1000 : null;
  let cls = "pill", text = "Not connected";
  if (S.source) {
    if (!S.lastRecv) { cls = "pill caution"; text = "Waiting for data"; }
    else if (S.signalLost) { cls = "pill fault"; text = `No data for ${age.toFixed(0)} s`; }
    else { cls = "pill go live"; text = "Receiving"; }
  }
  ui.pill.className = cls; ui.pill.lastChild.textContent = text;
  if (set.checklist && ui.store && (ui.clTick = (ui.clTick || 0) + 1) % 5 === 0) renderChecklistBtn();
  ui.rate.textContent = S.source && S.recvTimes.length > 1 ? `${(S.recvTimes.length / Math.min(5, tr - S.recvTimes[0] || 1)).toFixed(0)} lines/s` : "";
  renderReadouts();
  if (ui.recDirty) renderRecovery();
  if (ui.mapDirty) renderMap();
  renderSide(false);
  flushRecording(false);
}

function renderReadouts() {
  const tk = S.tracker;
  ui.altN.textContent = tk.agl !== null ? D.fmtAlt(tk.agl) : "No data";
  ui.altN.classList.toggle("nodata", tk.agl === null);
  ui.altU.textContent = D.altUnit;
  ui.maxV.innerHTML = "";
  ui.maxV.append(tk.maxAlt > 0 ? D.fmtAlt(tk.maxAlt) : "–", h("small", null, D.altUnit));
  const vs = tk.vel;
  ui.vsV.innerHTML = "";
  ui.vsV.className = "v " + (vs > 1 ? "vs-up" : vs < -1 ? "vs-down" : "");
  ui.vsV.append(Number.isFinite(vs) && tk.agl !== null ? (vs > 1 ? "↑ " : vs < -1 ? "↓ " : "") + D.fmtVel(Math.abs(vs)) : "–", h("small", null, D.velUnit));
  const st = S.latest.state?.v;
  ui.stateV.textContent = st ? String(st) : "–";

  // rail
  const cur = RAIL_INDEX[tk.phase] ?? 0;
  for (const el of ui.rail.children) {
    const i = RAIL_INDEX[el.dataset.k];
    el.className = "ph" + (i < cur ? " done" : i === cur ? " now" : "");
    const pt = S.phaseTimes[el.dataset.k];
    el.querySelector(".t").textContent = pt !== undefined && i <= cur && pt !== 0 ? `T+${pt.toFixed(1)}` : "";
  }
  // flight clock
  const lt = S.launchT ?? tk.launchT;
  if (lt !== null && S.clock.lastT !== null) {
    const end = tk.phase === "landed" && S.phaseTimes.landed !== undefined ? S.phaseTimes.landed : S.clock.lastT - lt + (S.lastRecv ? (performance.now() - S.lastRecv) / 1000 : 0);
    ui.tplus.textContent = `T+${fmtTime(Math.max(0, end))}`;
  } else ui.tplus.textContent = S.source ? "Waiting for launch" : "–";

  // tiles
  const L = S.latest;
  const tiles = [];
  const add = (k, v, unit, cls = "") => tiles.push(h("div", { class: "tile " + cls }, h("div", { class: "k" }, k), h("div", { class: "v" }, v, unit ? h("small", null, unit) : "")));
  add("Peak acceleration", tk.maxAcc > 0 ? fmt(tk.maxAcc, 1) : Number.isFinite(L.acc?.v) ? fmt(L.acc.v / G0, 1) : "–", "g");
  add("GPS", Number.isFinite(L.sats?.v) ? `${fmt(L.sats.v)} sats` : S.gps.last ? "Fix" : "–", "", S.gps.last ? "" : Number.isFinite(L.sats?.v) && L.sats.v < 4 ? "warn" : "");
  add("Battery", Number.isFinite(L.batt?.v) ? fmt(L.batt.v, 2) : "–", "V", set.alarms.battLow > 0 && L.batt?.v < set.alarms.battLow ? "bad" : "");
  add("Signal", Number.isFinite(L.rssi?.v) ? fmt(L.rssi.v) : "–", "dBm", L.rssi?.v < -110 ? "warn" : "");
  const age = S.lastRecv ? (performance.now() - S.lastRecv) / 1000 : null;
  add("Last data", age === null ? "–" : age < 1 ? "now" : `${fmt(age, 0)} s ago`, "", S.signalLost ? "bad" : "");
  add("Packets", fmt(S.packets), "");
  if (Number.isFinite(L.temp?.v)) add("Temperature", fmt(set.units === "imperial" ? L.temp.v * 1.8 + 32 : L.temp.v, 1), set.units === "imperial" ? "°F" : "°C");
  if (Number.isFinite(L.snr?.v)) add("SNR", fmt(L.snr.v, 1), "dB");
  for (const [name, m] of Object.entries(set.mapping)) {
    if (!m.tile || !S.fields[name]) continue;
    const v = S.fields[name].value;
    add(name, isNum(v) ? fmt(Number(v) * (m.scale ?? 1), 2) : String(v), m.unit || "");
  }
  clear(ui.tiles).append(...tiles);
}

// ------------------------------------------------------------------ recovery
function reference() {
  if (set.station.ref === "station" && set.station.lat != null) return { lat: set.station.lat, lon: set.station.lon, name: "this laptop" };
  if (S.gps.pad) return { ...S.gps.pad, name: "the pad" };
  return null;
}

function renderRecovery() {
  ui.recDirty = false;
  const b = ui.recBody;
  clear(b);
  const last = S.gps.last;
  if (!last) {
    b.append(h("div", { class: "empty", style: { gridColumn: "1 / -1", padding: "14px 4px" } },
      h("h3", null, "No GPS position yet"),
      h("p", null, "When your telemetry includes latitude and longitude (or NMEA sentences from a GPS tracker), the rocket's position, distance and direction appear here, with a code to open it on your phone.")));
    return;
  }
  const ref = reference();
  const db = ref ? distanceBearing([ref.lat, ref.lon], [last.lat, last.lon]) : null;
  const ang = db ? db.bearing : 0;
  const compass = h("div", {
    class: "compass", html: `<svg viewBox="0 0 120 120" width="116" height="116" aria-label="Direction to the rocket">
    <circle cx="60" cy="60" r="56" fill="none" stroke="var(--rule-strong)" stroke-width="2"/>
    <text x="60" y="16" text-anchor="middle" font-size="12" fill="var(--graphite)">N</text>
    <text x="108" y="64" text-anchor="middle" font-size="12" fill="var(--graphite)">E</text>
    <text x="60" y="112" text-anchor="middle" font-size="12" fill="var(--graphite)">S</text>
    <text x="12" y="64" text-anchor="middle" font-size="12" fill="var(--graphite)">W</text>
    ${db ? `<g transform="rotate(${ang} 60 60)"><path d="M60 18 L72 64 L60 56 L48 64 Z" fill="var(--orange)" stroke="var(--ink)" stroke-width="1.5"/><line x1="60" y1="56" x2="60" y2="96" stroke="var(--ink)" stroke-width="3"/></g>` : ""}
    <circle cx="60" cy="60" r="4" fill="var(--ink)"/></svg>`,
  });
  const ageS = (performance.now() - last.at) / 1000;
  b.append(compass,
    h("div", null, h("div", { class: "rec-dist" }, db ? D.fmtDist(db.distance) : "–"), h("div", { class: "rec-dir" }, db ? `${Math.round(db.bearing)}° ${compassName(db.bearing)} of ${ref.name}` : "Waiting for a pad position")),
    h("div", { class: "coords" }, h("b", null, `${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}`), h("div", { class: "muted", style: { fontSize: "13px" } }, ageS < 5 ? "Live position" : `Last position, ${fmtTime(ageS)} ago`)),
    h("div", { class: "row wrap" },
      h("button", { class: "btn small", onclick: () => { navigator.clipboard?.writeText(`${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}`).then(() => toast("Coordinates copied")); } }, "Copy coordinates"),
      h("a", { class: "btn small", href: mapsUrl(last), target: "_blank", rel: "noopener" }, "Open in Google Maps")));
  const qr = h("canvas", { "aria-label": "QR code with the rocket's position" });
  try { drawQR(qr, mapsUrl(last)); } catch { /* */ }
  b.append(h("div", { class: "qr-wrap" }, qr, h("p", { class: "note", style: { margin: 0 } }, "Scan with your phone's camera to navigate to the rocket. It updates with every new position.")));
}
const mapsUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

function useMyLocation() {
  if (!navigator.geolocation) { toast("This computer can't provide its location. Enter it in Settings.", "fault"); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    set.station.lat = p.coords.latitude; set.station.lon = p.coords.longitude; set.save();
    toast(`Laptop location set (±${Math.round(p.coords.accuracy)} m)`, "go"); renderRecovery(); renderMap(true);
  }, () => toast("Couldn't get this laptop's location. Turn on Windows location services or enter it in Settings.", "fault", 7000), { enableHighAccuracy: true, timeout: 15000 });
}

function renderMap(force = false) {
  ui.mapDirty = false;
  const m = [];
  const ref = reference();
  if (S.gps.pad) m.push({ lat: S.gps.pad.lat, lon: S.gps.pad.lon, color: "--graphite", label: "Pad" });
  if (set.station.lat != null) m.push({ lat: set.station.lat, lon: set.station.lon, color: "--d-alt", kind: "station", label: "Laptop" });
  if (S.gps.last) m.push({ lat: S.gps.last.lat, lon: S.gps.last.lon, kind: "rocket", color: "--orange", label: "Rocket" });
  ui.map.setTracks([{ points: S.gps.track, color: "--d-alt" }]);
  ui.map.setMarkers(m);
  if (ui.followMap && S.gps.last) {
    const pts = [[S.gps.last.lat, S.gps.last.lon]];
    if (ref) pts.push([ref.lat, ref.lon]);
    if (force || !ui.mapFitted || ui.mapFitT === undefined || performance.now() - ui.mapFitT > 3000) { ui.map.fit(pts, 17); ui.mapFitted = true; ui.mapFitT = performance.now(); }
  } else if (force && set.station.lat != null && !S.gps.last) ui.map.setView(set.station.lat, set.station.lon, 15);
}

// ------------------------------------------------------------------ side panel
function logEvent(what, kind = "", detail = "", tFlight = null) {
  const lt = S.launchT ?? S.tracker.launchT;
  const t = tFlight ?? (lt !== null && S.clock.lastT !== null ? S.clock.lastT - lt : null);
  S.events.unshift({ what, kind, detail, t, clock: new Date() });
  if (S.events.length > 300) S.events.pop();
  if (S.rec) S.rec.events.push({ what, detail, t, clock: new Date().toISOString() });
  ui.eventsDirty = true;
}

function consoleAdd(text, kind) {
  S.consoleLines.push([kind, text]);
  if (S.consoleLines.length > 400) S.consoleLines.splice(0, S.consoleLines.length - 400);
  ui.consoleDirty = true;
}

function renderSide(force) {
  const tab = ui.sideTab;
  if (tab === "events" && (force || ui.eventsDirty)) {
    ui.eventsDirty = false;
    clear(ui.sideBody);
    if (!S.events.length) { ui.sideBody.append(h("div", { class: "empty" }, h("h3", null, "No events yet"), h("p", null, "Connect to a radio, a Wi-Fi board, or start the demo flight. Launch, apogee, deployments, signal loss and landing are logged here and spoken aloud."))); }
    else ui.sideBody.append(h("ul", { class: "events" }, S.events.map((e) => h("li", { class: e.kind }, h("span", { class: "t" }, e.t !== null && e.t !== undefined ? `T${e.t >= 0 ? "+" : "−"}${Math.abs(e.t).toFixed(1)}` : e.clock.toLocaleTimeString()), h("span", { class: "what" }, e.what), h("span", { class: "det" }, e.detail || "")))));
  }
  if (tab === "console" && (force || (ui.consoleDirty && !S.consolePaused))) {
    ui.consoleDirty = false;
    if (force || !ui.consoleEl) {
      clear(ui.sideBody);
      ui.consoleEl = h("div", { class: "console", role: "log", "aria-live": "off" });
      ui.sideBody.append(ui.consoleEl);
    }
    const el = ui.consoleEl;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.textContent = "";
    const frag = document.createDocumentFragment();
    for (const [k, t] of S.consoleLines.slice(-250)) frag.append(h("div", { class: k === "tx" ? "tx" : k === "err" ? "err" : "" }, (k === "tx" ? "› " : "") + t));
    el.append(frag);
    if (atBottom || force) el.scrollTop = el.scrollHeight;
  }
  if (tab === "fields" && (force || ui.fieldsDirty || (ui.fieldsTick = (ui.fieldsTick || 0) + 1) % 5 === 0)) {
    ui.fieldsDirty = false;
    renderFields(force);
  }
  if (force) {
    clear(ui.sendRow);
    if (tab === "console") {
      const inp = h("input", { type: "text", placeholder: S.source?.send ? "Send a line to the board" : "Connect a serial or UDP source to send", disabled: !S.source?.send, "aria-label": "Send text" });
      const sendIt = () => { if (!inp.value || !S.source?.send) return; S.source.send(inp.value); consoleAdd(inp.value, "tx"); inp.value = ""; };
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") sendIt(); });
      ui.sendRow.append(inp, h("button", { class: "btn small", disabled: !S.source?.send, onclick: sendIt }, "Send"),
        h("button", { class: "btn small" + (S.consolePaused ? " on" : ""), onclick: (e) => { S.consolePaused = !S.consolePaused; e.target.classList.toggle("on", S.consolePaused); } }, "Pause"));
      ui.sendRow.style.display = "flex";
    } else ui.sendRow.style.display = "none";
  }
}

function fieldRows(full) {
  const tb = h("tbody");
  for (const name of S.fieldOrder) {
    const m = set.mapping[name] || { role: "" };
    const def = ROLE_BY_ID[m.role];
    const roleSel = h("select", { "aria-label": `Meaning of ${name}`, onchange: () => {
      const r = roleSel.value;
      if (r) for (const [n2, m2] of Object.entries(set.mapping)) if (n2 !== name && m2.role === r) m2.role = "";
      set.mapping[name] = { ...m, role: r, unit: "" }; set.save(); renderFields(true);
      if (full) full();
    } }, h("option", { value: "" }, "Not used"), ROLES.map((r) => h("option", { value: r.role, selected: r.role === m.role }, r.label)));
    const valCell = h("td", { class: "val", "data-f": name });
    const cells = [h("td", null, name), valCell, h("td", null, roleSel)];
    if (full) {
      const units = def ? UNIT_CHOICES[def.kind] : null;
      const unitSel = units ? h("select", { "aria-label": `Unit of ${name}`, onchange: () => { set.mapping[name].unit = unitSel.value; set.save(); } }, units.map((u) => h("option", { value: u, selected: (m.unit || units[0]).toLowerCase() === u.toLowerCase() }, u))) : h("span", { class: "faint" }, "–");
      const scale = h("input", { type: "number", value: m.scale ?? 1, step: "any", style: { width: "80px" }, "aria-label": `Scale for ${name}`, onchange: () => { set.mapping[name].scale = Number(scale.value) || 1; set.save(); } });
      const tile = h("input", { type: "checkbox", checked: !!m.tile, "aria-label": `Show ${name} as a tile`, onchange: () => { set.mapping[name].tile = tile.checked; set.save(); } });
      cells.push(h("td", null, unitSel), h("td", null, scale), h("td", null, tile));
    }
    tb.append(h("tr", null, cells));
  }
  return tb;
}

function renderFields(force) {
  if (force || !ui.fieldTable || !ui.sideBody.contains(ui.fieldTable)) {
    clear(ui.sideBody);
    if (!S.fieldOrder.length) {
      ui.sideBody.append(h("div", { class: "empty" }, h("h3", null, "No fields yet"), h("p", null, "Each value in your telemetry appears here once data arrives. Owl guesses what each one is from its name; correct any guess here. If your lines have no header, list the field names in Settings.")));
      ui.fieldTable = null; return;
    }
    ui.fieldTable = h("table", { class: "data fieldtable" }, h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Latest"), h("th", null, "Meaning"))), fieldRows(null));
    ui.sideBody.append(ui.fieldTable, h("div", { style: { padding: "8px" } }, h("button", { class: "btn small", onclick: openFieldEditor }, "Units, scaling and tiles…")));
  }
  for (const td of document.querySelectorAll("td.val")) { const f = S.fields[td.dataset.f]; td.textContent = f ? String(f.value) : ""; }
}

function openFieldEditor() {
  const wrap = h("div");
  const draw = () => {
    clear(wrap).append(
      h("p", { class: "note", style: { marginTop: 0 } }, "Unit is what the value is sent in. Scale multiplies the raw number first (for example 0.01 for centimetres sent as whole numbers). Tiles show any field as a big readout."),
      h("table", { class: "data" }, h("thead", null, h("tr", null, ["Field", "Latest", "Meaning", "Unit", "Scale", "Tile"].map((x) => h("th", null, x)))), fieldRows(draw)));
    renderFields(false);
  };
  draw();
  modal({ title: "Telemetry fields", body: wrap, wide: true, actions: [{ label: "Done", kind: "primary", onClick: () => { renderFields(true); renderReadouts(); } }] });
}

// ------------------------------------------------------------------ recording
function startRecording() {
  const dir = `${stamp()} ${safeName(set.flightName || S.source?.label || "flight")}`;
  S.rec = { dir, raw: [], csv: ["time_s,alt_agl_m,vel_mps,accel_ms2,pressure_pa,temp_c,lat,lon,gps_alt_m,sats,batt_v,rssi_dbm,state,phase"], events: [], written: 0, launchShift: null };
  renderRecord();
}
function stopRecording() { flushRecording(true); S.rec = null; renderRecord(); }
function toggleRecord() {
  set.record = !set.record; set.save();
  if (set.record && S.source && !S.rec) startRecording();
  if (!set.record && S.rec) { stopRecording(); toast("Recording stopped"); }
  renderRecord();
}
function renderRecord() {
  ui.recBtn.textContent = set.record ? (S.rec ? "Recording" : "Record: on") : "Record: off";
  ui.recBtn.classList.toggle("on", !!S.rec);
  ui.recBtn.title = S.rec ? `Saving to Documents\\Aviary\\Owl Recordings\\${S.rec.dir}` : "Record incoming telemetry to Documents\\Aviary\\Owl Recordings";
}
let flushing = false;
async function flushRecording(final) {
  const r = S.rec;
  if (!r || flushing) return;
  if (!final && r.raw.length < 20 && performance.now() - (r.lastFlush || 0) < 1000) return;
  flushing = true;
  r.lastFlush = performance.now();
  const raw = r.raw.splice(0), csv = r.csv.splice(0);
  try {
    if (raw.length) await host.append("owl", `${r.dir}/raw.txt`, raw.join("\n") + "\n");
    if (csv.length) await host.append("owl", `${r.dir}/telemetry.csv`, csv.join("\n") + "\n");
    if (final) await writeSummary();
  } catch (e) { if (!r.warned) { toast("Couldn't save the recording: " + e.message, "fault"); r.warned = true; } }
  flushing = false;
}
async function writeSummary() {
  const r = S.rec;
  if (!r) return;
  const tk = S.tracker;
  const sum = {
    app: "Owl", flight: set.flightName, source: S.source?.label, written: new Date().toISOString(),
    maxAltitude_m: tk.maxAlt, apogee: tk.apogee, maxVerticalSpeed_mps: tk.maxVel, peakAccel_g: tk.maxAcc,
    pad: S.gps.pad, lastPosition: S.gps.last && { lat: S.gps.last.lat, lon: S.gps.last.lon }, events: r.events,
    checklist: ui.store ? checklistRecord(checkCtx()) : null,
  };
  try { await host.write("owl", `${r.dir}/summary.json`, JSON.stringify(sum, null, 2)); } catch { /* */ }
}

// ------------------------------------------------------------------ phone companion
// What the phone shows: plain numbers in SI, the phone formats them.
function phoneCtx() {
  return {
    host, set, btn: ui.phoneBtn,
    snapshot: () => {
      const tk = S.tracker, L = S.latest, now = performance.now();
      const num = (x) => (Number.isFinite(x) ? x : null);
      return {
        v: 1, name: set.flightName || "", source: S.source?.label || "", connected: !!S.source, units: set.units,
        lastPacketAgo: S.lastRecv ? (now - S.lastRecv) / 1000 : null, signalLost: !!S.signalLost,
        phase: tk.phase, alt: tk.agl, vs: num(tk.vel), max: tk.maxAlt, tplus: ui.tplus?.textContent || "",
        state: L.state?.v ?? null, batt: num(L.batt?.v), rssi: num(L.rssi?.v), sats: num(L.sats?.v),
        fix: S.gps.last ? { lat: S.gps.last.lat, lon: S.gps.last.lon, alt: num(S.gps.last.alt), ago: (now - S.gps.last.at) / 1000 } : null,
        pad: S.gps.pad || null,
        events: S.events.slice(0, 12).map((e) => ({ what: e.what, kind: e.kind, detail: e.detail, t: num(e.t), clock: e.clock?.toISOString?.() || null })),
      };
    },
  };
}

// ------------------------------------------------------------------ field tools
function checkCtx() {
  return {
    set, D, store: ui.store, save: () => set.save(), onChange: renderChecklistBtn,
    state: () => {
      const L = S.latest, st = String(L.state?.v ?? "");
      return {
        connected: !!S.source, recentPackets: !!S.lastRecv && performance.now() - S.lastRecv < 3000,
        batt: Number.isFinite(L.batt?.v) ? L.batt.v : null, battLow: set.alarms.battLow,
        gpsSeen: L.lat !== undefined || L.lon !== undefined, gpsFix: !!S.gps.last && performance.now() - S.gps.last.at < 5000 && (!Number.isFinite(L.sats?.v) || L.sats.v >= 4),
        armed: /arm/i.test(st) ? !/disarm|unarm/i.test(st) : null, recording: !!S.rec,
      };
    },
  };
}
async function showChecklist() {
  ui.store ||= await loadRockets(host);
  openChecklist(checkCtx());
}
function renderChecklistBtn() {
  if (!ui.store || !set.checklist) return;
  const p = checklistProgress(checkCtx());
  ui.checkBtn.textContent = p ? `Checklist ${p.done}/${p.total}` : "Checklist";
  ui.checkBtn.classList.toggle("on", !!p && p.done === p.total);
}

// Download map tiles and ground heights around a point for use offline.
async function saveArea(lat, lon) {
  const hint = document.getElementById("maphint");
  try {
    const r = await host.post("/api/tiles/prefetch", { lat, lon, radius: 3000, mapZoom: 16 });
    toast(`Saving ${r.total} map and elevation tiles around the map's centre`);
    const poll = setInterval(async () => {
      const p = await host.get("/api/tiles/prefetch").catch(() => null);
      if (!p) return;
      hint.textContent = p.running ? `Saving for offline: ${p.done} of ${p.total}` : `Saved for offline${p.failed ? ` (${p.failed} tiles unavailable)` : ""}`;
      if (!p.running) { clearInterval(poll); toast(p.failed && p.failed === p.total ? "Couldn't download: is this laptop online?" : "Area saved for offline use", p.failed === p.total ? "fault" : "go"); }
    }, 800);
  } catch (e) { toast("Couldn't save the area: " + e.message, "fault"); }
}

// ------------------------------------------------------------------ misc
function newFlight() {
  flushRecording(true);
  S.tracker.reset(); S.latest = {}; S.gps = { last: null, pad: null, padSamples: [], track: [], hadFix: false };
  S.p0 = null; S.launchT = null; S.phaseTimes = {}; S.events = []; S.packets = 0; S.battWarned = false;
  S.clock = { useTlm: null, lastTlm: null, lastT: null, lastRecv: null, offset: 0 };
  S.t0 = performance.now();
  for (const c of [ui.altChart, ui.velChart]) { for (const s of c.series) { s.x = []; s.y = []; s.n = 0; } c.setMarkers([]); c.resetView(); }
  S.rec = null;
  if (S.source && set.record) startRecording();
  renderRecord(); renderRecovery(); renderMap(true); renderSide(true);
  logEvent("New flight", "", S.source ? S.source.label : "");
}

let lastSpeech = "";
function speak(text) {
  if (!set.voice || !("speechSynthesis" in window)) return;
  if (text === lastSpeech && speechSynthesis.speaking) return;
  lastSpeech = text;
  try { const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u); } catch { /* */ }
}

function openSettings() {
  const p = { ...set.parser };
  const body = h("div", { class: "col", style: { gap: "14px" } },
    h("div", null, h("div", { class: "sub-title" }, "Display"),
      h("div", { class: "grid-form" },
        selectField("Units", set.units, [["imperial", "Feet"], ["metric", "Metres"]], (v) => { set.units = v; set.save(); }),
        selectField("Theme", set.theme, [["day", "Day (bright sun)"], ["night", "Night"]], (v) => { set.theme = v; set.save(); setTheme(v); }),
        h("div", { class: "field" }, h("span", null, "Voice"), checkField("Speak events aloud", set.voice, (v) => { set.voice = v; set.save(); })))),
    h("div", null, h("div", { class: "sub-title" }, "Telemetry format"),
      h("div", { class: "grid-form" },
        selectField("Format", p.format, [["auto", "Detect automatically"], ["csv", "Comma or space separated"], ["kv", "name=value pairs"], ["json", "JSON lines"], ["nmea", "NMEA GPS only"]], (v) => { p.format = v; }),
        selectField("Separator", p.delimiter, [["auto", "Detect"], [",", "Comma"], [";", "Semicolon"], ["\t", "Tab"], [" ", "Space"], ["|", "Bar"]], (v) => { p.delimiter = v; }),
        textField("Only lines starting with", p.prefix, (v) => { p.prefix = v; }, { placeholder: "e.g. $TLM" })),
      h("div", { style: { marginTop: "10px" } }, textField("Field names for lines without a header (in order)", p.fieldNames, (v) => { p.fieldNames = v; }, { placeholder: "e.g. time_ms, alt_m, vel, lat, lon, sats, batt" })),
      h("p", { class: "note" }, "If your board prints a header line (names separated like the data), Owl reads it by itself. Check and correct what each field means under Fields.")),
    h("div", null, h("div", { class: "sub-title" }, "Altitude"),
      h("div", { class: "grid-form" },
        selectField("Altitude in telemetry is", set.altAgl ? "agl" : "msl", [["msl", "Zeroed by Owl at the pad"], ["agl", "Already above ground"]], (v) => { set.altAgl = v === "agl"; set.save(); }))),
    h("div", null, h("div", { class: "sub-title" }, "Alarms"),
      h("div", { class: "grid-form" },
        numField("Warn when battery below", set.alarms.battLow || "", "V", (v) => { set.alarms.battLow = v || 0; set.save(); }, { title: "0 or blank turns it off" }),
        numField("Signal lost after", set.alarms.signalLost, "s", (v) => { set.alarms.signalLost = v || 0; set.save(); }))),
    h("div", null, h("div", { class: "sub-title" }, "This laptop's location (for distance and direction)"),
      h("div", { class: "grid-form" },
        numField("Latitude", set.station.lat ?? "", "°", (v) => { set.station.lat = v; set.save(); }),
        numField("Longitude", set.station.lon ?? "", "°", (v) => { set.station.lon = v; set.save(); }),
        h("div", { class: "field" }, h("span", null, " "), h("button", { class: "btn", onclick: useMyLocation }, "Use Windows location")))),
    h("div", null, h("div", { class: "sub-title" }, "Files"),
      h("div", { class: "row wrap" },
        h("button", { class: "btn", onclick: () => host.reveal("owl").catch((e) => toast(e.message, "fault")) }, "Open recordings folder"),
        h("button", { class: "btn", onclick: async () => { try { const s = await host.get("/api/tiles/stats"); toast(`${fmt(s.tiles)} map tiles saved (${fmt(s.bytes / 1048576, 1)} MB)`); } catch (e) { toast(e.message, "fault"); } } }, "Offline map storage"))));
  modal({
    title: "Settings", body, wide: true,
    actions: [{ label: "Done", kind: "primary", onClick: () => {
      set.parser = p; set.save();
      S.parser = new LineParser(p);
      if (D.system !== set.units) {
        const k = set.units === "imperial" ? 1 / 0.3048 : 0.3048;
        for (const s of [ui.altChart.getSeries("alt"), ui.velChart.getSeries("vel")]) for (let i = 0; i < s.n; i++) s.y[i] *= k;
        ui.altChart.setMarkers([]);
      }
      D = display(set.units);
      ui.altChart.o.yLabel = `Altitude (${D.altUnit})`; ui.velChart.o.yLabel = `Speed (${D.velUnit})`;
      ui.altChart.getSeries("alt").unit = D.altUnit; ui.velChart.getSeries("vel").unit = D.velUnit;
      renderReadouts(); renderRecovery(); renderMap(true);
    } }],
  });
}

main().catch((e) => { document.body.append(h("pre", { style: { padding: "20px" } }, "Owl failed to start: " + e.stack)); });
