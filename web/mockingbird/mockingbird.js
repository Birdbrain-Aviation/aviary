// Mockingbird — firmware-in-the-loop tester for any flight computer.
// It simulates a flight of the chosen rocket, streams the sensor readings to a
// real flight computer over USB (or to a built-in virtual one), lets the
// flight computer's pyro commands change the simulated flight, and grades
// what happened.
import { h, clear, toast, modal, selectField, checkField, seg, tabs, setTheme, stamp, safeName, appHeader, confirmBox, pickFile, readFileText } from "/shared/js/ui.js";
import { host, connectEvents, loadSettings } from "/shared/js/host.js";
import { display, fmt, G0 } from "/shared/js/units.js";
import { TimeChart, ChartGroup } from "/shared/js/chart.js";
import { FlightAnimation, phasesFromSamples } from "/shared/js/flightviz.js";
import { openMonteCarlo, showResults as showMCResults } from "./montecarlo.js";
import { replayFromLog } from "/shared/js/replay.js";
import { SerialLink, serialSupported, describePort, BAUDS } from "/shared/js/serial.js";
import { HILRun, VirtualFC, defaultTests, testApplies, describeFault, DEFAULT_FIELDS, DEFAULT_TOL, FAULT_TYPES, withCS } from "/shared/js/hil.js";
import { loadRockets } from "/shared/js/rockets.js";
import { RocketEditor } from "./rocket.js";
import { renderSetup, editTest, pyroFor } from "./setup.js";

const DEFAULTS = {
  theme: "day", units: "imperial", tab: "run",
  link: { baud: 115200, dtr: true, type: "serial" },
  run: {
    rate: 50, padTime: 10, speed: 1, vfcSpeed: 5, protocol: "mb", fields: DEFAULT_FIELDS, template: "{t_ms},{p_pa},{az_g}", templateCS: false,
    noise: { baro: 2, accel: 0.1, gyro: 0.15 }, axis: { up: "z", sign: 1 }, tol: { ...DEFAULT_TOL }, rules: [], showSent: false,
  },
  pyro: {}, tests: null, checked: {}, selectedTest: "nominal", status: {}, history: [],
};
const RAIL = [["pad", "Pad"], ["boost", "Boost"], ["coast", "Coast"], ["descent", "Free fall"], ["drogue", "Drogue"], ["main", "Main"], ["landed", "Landed"]];
const RAIL_INDEX = Object.fromEntries(RAIL.map(([k], i) => [k, i]));

let set, D, version = "dev";
const M = {
  store: null, link: null, hello: null, rxCount: 0, lastPing: 0, connectedAt: 0,
  run: null, vfc: null, test: null, ticker: null, runStart: 0, speed: 1, finishing: false,
  suite: null, suiteSummary: null, report: null, ds: null,
  events: [], consoleLines: [], log: [], bands: new Map(), bandList: [], markers: [], ci: 0, fci: {}, fcState: null,
  txCount: 0, txBytes: 0, rxDuringRun: 0, slowLink: false, safetyAck: false, rates: [],
};
const ui = { sideTab: "events", view: "charts" };
const currentRocket = () => M.store.rockets.find((r) => r.id === M.store.selected) || M.store.rockets[0];
const currentTest = () => set.tests.find((t) => t.id === set.selectedTest) || set.tests[0];
const fmtA = (m) => `${D.fmtAlt(m)} ${D.altUnit}`;
const fmtV = (v) => `${D.fmtVel(v)} ${D.velUnit}`;
const tlabel = (x) => `T${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;

// ------------------------------------------------------------------ startup
async function main() {
  set = await loadSettings(DEFAULTS);
  D = display(set.units);
  setTheme(set.theme);
  connectEvents();
  try { version = (await host.info()).version || "dev"; } catch { /* */ }
  M.store = await loadRockets(host);
  if (!Array.isArray(set.tests) || !set.tests.length) { set.tests = defaultTests(); set.save(); }
  if (!set.tests.find((t) => t.id === set.selectedTest)) set.selectedTest = set.tests[0].id;
  build();
  setInterval(idleTick, 400);
  window.addEventListener("beforeunload", (e) => { if (M.run) { e.preventDefault(); e.returnValue = ""; } });
}

// ------------------------------------------------------------------ layout
function build() {
  const app = document.getElementById("app");
  ui.pill = h("span", { class: "pill" }, h("span", { class: "dot" }), "Not connected");
  ui.connectBtn = h("button", { class: "btn primary", onclick: () => (M.link ? disconnect() : openConnect()) }, "Connect…");
  ui.sub = h("span");
  const tools = [
    ui.pill,
    seg([["imperial", "ft"], ["metric", "m"]], set.units, (v) => { set.units = v; set.save(); D = display(v); unitsChanged(); }),
    seg([["day", "Day"], ["night", "Night"]], set.theme, (v) => { set.theme = v; set.save(); setTheme(v); }),
    ui.connectBtn,
  ];
  const header = appHeader("mockingbird", "Mockingbird", ui.sub, tools);

  // sidebar: tests + history
  ui.testList = h("div", { class: "test-list", role: "list", "aria-label": "Tests" });
  ui.histList = h("div", { class: "hist-list", "aria-label": "Recent runs" });
  const side = h("aside", { class: "mb-side" },
    h("div", { class: "side-head" }, h("b", null, "Tests"), h("div", { class: "spacer" }),
      h("button", { class: "btn small ghost", title: "Tick or untick every test", onclick: toggleAll }, "All")),
    ui.testList,
    h("div", { class: "side-actions" },
      h("button", { class: "btn small", onclick: () => openTestEditor(null) }, "New test"),
      h("button", { class: "btn small", onclick: () => openTestEditor(currentTest()) }, "Edit"),
      h("button", { class: "btn small ghost", onclick: resetTests }, "Defaults")),
    h("div", { class: "side-head" }, h("b", null, "Recent runs"), h("div", { class: "spacer" }),
      h("button", { class: "btn small ghost", title: "Show the runs folder in File Explorer", onclick: () => host.reveal("mockingbird").catch((e) => toast(e.message, "fault")) }, "Folder")),
    ui.histList);

  // main: tabs
  ui.tabs = tabs([["run", "Run"], ["rocket", "Rocket"], ["fc", "Flight computer"]], set.tab, (v) => showTab(v));
  ui.runTabEl = h("div", { class: "mb-tab run" });
  ui.rocketTabEl = h("div", { class: "mb-tab" });
  ui.fcTabEl = h("div", { class: "mb-tab" });
  const mainEl = h("section", { class: "mb-main" }, ui.tabs, ui.runTabEl, ui.rocketTabEl, ui.fcTabEl);
  app.append(header, h("main", { class: "mb app-body" }, side, mainEl));

  buildRunTab();
  ui.editor = new RocketEditor(ui.rocketTabEl, { store: M.store, units: set.units, onChange: (r, structural) => { if (structural) { renderTests(); renderTestSel(); renderSub(); } } });
  showTab(set.tab);
  renderTests(); renderHistory(); renderSub(); renderPill(); renderBar();
}

function showTab(v) {
  set.tab = v; set.save();
  ui.tabs.set(v);
  ui.runTabEl.classList.toggle("hidden", v !== "run");
  ui.rocketTabEl.classList.toggle("hidden", v !== "rocket");
  ui.fcTabEl.classList.toggle("hidden", v !== "fc");
  if (v === "rocket") ui.editor.render();
  if (v === "fc") renderFC();
}

function renderFC() {
  renderSetup(ui.fcTabEl, {
    set, D, rocket: currentRocket, site: () => M.store.site,
    linkType: () => M.link?.type || null,
    onChange: () => renderBar(),
  });
}

function renderSub() {
  const r = currentRocket();
  ui.sub.textContent = r ? r.name : "";
}

function unitsChanged() {
  ui.editor.setUnits(set.units);
  if (set.tab === "rocket") ui.editor.render();
  if (set.tab === "fc") renderFC();
  setChartLabels();
  if (M.run) {
    // convert what is already drawn so old and new points match
    const k = set.units === "imperial" ? 1 / 0.3048 : 0.3048;
    for (const s of [...ui.altC.series, ...ui.velC.series, ui.senC.getSeries("baro")]) for (let i = 0; i < s.n; i++) s.y[i] *= k;
    applyMarkers(M.markers);
  } else if (M.ds) drawDataset(M.ds, false);
  ui.anim?.setUnits(D);
  renderSide(true);
}

// ------------------------------------------------------------------ run tab
function buildRunTab() {
  ui.rail = h("div", { class: "phase-rail", role: "list", "aria-label": "Simulated flight phase" },
    RAIL.map(([k, l]) => h("div", { class: "ph", "data-k": k, role: "listitem" }, l, h("span", { class: "t" }))));
  ui.clock = h("div", { class: "v" }, "–");
  const top = h("div", { class: "run-top" }, ui.rail, h("div", { class: "tplus" }, h("div", { class: "k" }, "Test time"), ui.clock));

  ui.testSel = h("select", { "aria-label": "Test to run", onchange: () => selectTest(ui.testSel.value) });
  ui.speedBox = h("div");
  ui.startBtn = h("button", { class: "btn primary", onclick: () => startRun(currentTest()) }, "Start test");
  ui.stopBtn = h("button", { class: "btn danger hidden", onclick: () => stopRun() }, "Stop");
  ui.suiteBtn = h("button", { class: "btn", onclick: runChecked });
  ui.mcBtn = h("button", { class: "btn", title: "Many flights with random wind, thrust, mass, drag and noise", onclick: () => startMonteCarlo() }, "Monte Carlo…");
  ui.replayBtn = h("button", { class: "btn", title: "Play a real flight log into the flight computer", onclick: () => openReplay() }, "Replay a log…");
  ui.live = h("div", { class: "live-stats" });
  ui.barNote = h("div", { class: "bar-note" });
  const bar = h("section", { class: "panel run-bar" },
    h("div", { class: "run-bar-row" },
      h("label", { class: "field", style: { minWidth: "260px" } }, h("span", null, "Test"), ui.testSel),
      h("div", { class: "field" }, h("span", null, "Speed"), ui.speedBox),
      ui.startBtn, ui.suiteBtn, ui.mcBtn, ui.replayBtn, ui.stopBtn, h("div", { class: "spacer" }), ui.live),
    ui.barNote);

  const c1 = h("div"), c2 = h("div"), c3 = h("div");
  ui.emptyRun = runEmpty();
  ui.stack = h("div", { class: "chart-stack3" }, c1, c2, c3);
  ui.animBox = h("div", { class: "anim-box hidden" });
  ui.wholeBtn = h("button", { class: "btn small ghost", onclick: () => { ui.altC.o.streaming = false; ui.altC.resetView(); } }, "Whole flight");
  ui.viewSeg = seg([["charts", "Charts"], ["anim", "Animation"]], ui.view, setView);
  const charts = h("section", { class: "panel run-charts" },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Flight"), h("span", { class: "hint" }, "Solid lines are the simulation's truth. Dashed lines are what the flight computer reported."),
      h("div", { class: "spacer" }), ui.wholeBtn, ui.viewSeg),
    h("div", { class: "panel-body flush", style: { position: "relative" } }, ui.stack, ui.animBox, ui.emptyRun));

  ui.sideTabs = tabs([["result", "Result"], ["events", "Events"], ["console", "Console"]], ui.sideTab, (v) => { ui.sideTab = v; renderSide(true); });
  ui.sideBody = h("div", { class: "side-body" });
  ui.sideFoot = h("div", { class: "send-row" });
  const sidePanel = h("section", { class: "panel run-side" }, ui.sideTabs, ui.sideBody, ui.sideFoot);
  ui.runTabEl.append(h("div", { class: "run-grid" }, top, bar, charts, sidePanel));

  const g = new ChartGroup();
  const xFormat = (x) => `${tlabel(x)} s`;
  ui.altC = new TimeChart(c1, { group: g, xLabel: "", yIncludeZero: true, xFormat, streaming: false, xWindow: 60 });
  ui.altC.addSeries({ id: "truth", label: "True altitude", color: "--d-alt", digits: 0, width: 2 });
  ui.altC.addSeries({ id: "fc", label: "Flight computer's altitude", color: "--d-acc", dash: [6, 4], digits: 0, width: 1.75 });
  ui.velC = new TimeChart(c2, { group: g, xLabel: "", yIncludeZero: true, xFormat, streaming: false, xWindow: 60 });
  ui.velC.addSeries({ id: "truth", label: "True vertical speed", color: "--d-vel", digits: 0, width: 2 });
  ui.velC.addSeries({ id: "fc", label: "Flight computer's speed", color: "--d-acc", dash: [6, 4], digits: 0 });
  ui.senC = new TimeChart(c3, { group: g, xLabel: "Time from launch (s)", xFormat, y2Label: "Acceleration (g)", streaming: false, xWindow: 60 });
  ui.senC.addSeries({ id: "baro", label: "Barometer altitude sent", color: "--d-prs", digits: 0, width: 1.25 });
  ui.senC.addSeries({ id: "acc", label: "Nose-axis acceleration sent", color: "--d-aux1", axis: "y2", unit: "g", digits: 2, width: 1.25 });
  setChartLabels();
  renderTestSel(); renderSpeed(); renderSide(true); renderRail("pad", null);
}

function setChartLabels() {
  ui.altC.o.yLabel = `Altitude (${D.altUnit})`; ui.velC.o.yLabel = `Speed (${D.velUnit})`; ui.senC.o.yLabel = `Altitude (${D.altUnit})`;
  for (const s of [...ui.altC.series, ui.senC.getSeries("baro")]) s.unit = D.altUnit;
  for (const s of ui.velC.series) s.unit = D.velUnit;
  for (const c of [ui.altC, ui.velC, ui.senC]) c.redraw();
}

function runEmpty() {
  return h("div", { class: "run-empty" },
    h("h2", null, "Test your flight computer before it flies"),
    h("ol", null,
      h("li", null, "Your flight computer runs its normal code, but reads its sensors from Mockingbird instead of the real chips. The MockingbirdHIL Arduino library makes that a few lines."),
      h("li", null, "Mockingbird simulates the selected rocket's flight and streams barometer, accelerometer, gyro and GPS readings to it over USB, 50 times a second."),
      h("li", null, "When your code fires a pyro channel, that parachute opens or that stage lights in the simulation, so the flight reacts to what your code actually does."),
      h("li", null, "Each test can inject a fault on purpose (a noisy barometer, a pressure spike, a motor that quits) and every deployment and ignition is graded against the plan.")),
    h("div", { class: "row wrap", style: { margin: "4px 0 18px" } },
      h("button", { class: "btn primary", onclick: tryVirtual }, "Try it with the virtual flight computer"),
      h("button", { class: "btn", onclick: () => openConnect() }, "Connect your flight computer…")),
    h("div", { class: "safety" }, h("b", null, "Before testing real hardware: "), "take out igniters and e-matches and unplug the pyro battery. Mockingbird makes the flight computer believe it is flying, so it will try to fire every charge."));
}

function renderTestSel() {
  const rocket = currentRocket();
  clear(ui.testSel);
  for (const t of set.tests) ui.testSel.append(h("option", { value: t.id, selected: t.id === set.selectedTest, disabled: !testApplies(t, rocket) }, t.name + (testApplies(t, rocket) ? "" : " (needs 2+ stages)")));
  const n = set.tests.filter((t) => set.checked[t.id] !== false && testApplies(t, rocket)).length;
  ui.suiteBtn.textContent = `Run ${n} ticked test${n === 1 ? "" : "s"}`;
  ui.suiteBtn.disabled = !n || !!M.run;
}

function renderSpeed() {
  clear(ui.speedBox);
  const virtual = M.link?.type === "virtual";
  const opts = virtual ? [[1, "1×"], [5, "5×"], [20, "20×"], [0, "Instant"]] : [[1, "1×"], [2, "2×"], [4, "4×"]];
  const cur = virtual ? set.run.vfcSpeed : set.run.speed;
  const s = seg(opts, cur, (v) => {
    v = Number(v);
    if (virtual) set.run.vfcSpeed = v; else set.run.speed = v;
    set.save();
    if (M.run && virtual) changeSpeed(v);
    renderBar();
  });
  // a real board was told the time scale when the test started, so it can't change mid-test
  if (M.run && !virtual) for (const b of s.children) b.disabled = true;
  ui.speedBox.append(s);
}

// Virtual runs can change speed while running: keep the simulated time where it is.
function changeSpeed(v) {
  const run = M.run;
  if (!run || v === M.speed) return;
  if (v === 0) { M.ticker?.stop(); M.ticker = null; M.speed = 0; for (const c of [ui.altC, ui.velC, ui.senC]) c.o.streaming = false; instantLoop(); return; }
  M.runStart = performance.now() - (run.sim.t / v) * 1000;
  M.speed = v;
}

function renderBar() {
  const running = !!M.run;
  ui.startBtn.classList.toggle("hidden", running);
  ui.suiteBtn.classList.toggle("hidden", running);
  ui.mcBtn.classList.toggle("hidden", running); ui.replayBtn.classList.toggle("hidden", running);
  ui.stopBtn.classList.toggle("hidden", !running);
  ui.testSel.disabled = running;
  renderTestSel();
  const t = currentTest();
  const parts = [];
  if (M.suite && running) parts.push(h("b", null, `Test ${M.suite.total - M.suite.queue.length} of ${M.suite.total}. `));
  parts.push(t.note || (t.faults.length ? t.faults.map((f) => describeFault(f, (k) => currentRocket().stages[k]?.name || `stage ${k + 1}`)).join("; ") : "No faults."));
  if (M.link?.type === "serial" && !running) parts.push(h("span", { class: "warn-inline" }, " Igniters out and pyro battery unplugged?"));
  if (M.link?.type === "serial" && set.run.speed > 1) parts.push(h("span", { class: "muted" }, ` At ${set.run.speed}× your firmware must time things with hil.millis().`));
  clear(ui.barNote).append(...parts);
}

// ------------------------------------------------------------------ tests sidebar
function renderTests() {
  const rocket = currentRocket();
  clear(ui.testList);
  for (const t of set.tests) {
    const applies = testApplies(t, rocket);
    const st = set.status[rocket.id]?.[t.id];
    const cb = h("input", { type: "checkbox", checked: set.checked[t.id] !== false, disabled: !applies, "aria-label": `Include ${t.name} when running ticked tests`, onclick: (e) => e.stopPropagation(), onchange: () => { set.checked[t.id] = cb.checked; set.save(); renderTestSel(); } });
    ui.testList.append(h("div", { class: "test-item" + (t.id === set.selectedTest ? " on" : "") + (applies ? "" : " na"), role: "listitem", title: t.note || "", onclick: () => selectTest(t.id), ondblclick: () => openTestEditor(t) },
      cb, h("div", { class: "nm" }, t.name),
      st ? h("span", { class: "badge " + st.verdict }, st.verdict === "pass" ? "PASS" : "FAIL") : h("span", { class: "badge" }, "–"),
      h("div", { class: "sub" }, !applies ? "Needs a rocket with 2 or more stages" : t.faults.length ? t.faults.map((f) => FAULT_TYPES[f.type]?.label || f.type).join(", ") : "No faults")));
  }
  renderTestSel();
}

function selectTest(id) {
  set.selectedTest = id; set.save();
  renderTests(); renderBar();
}

function toggleAll() {
  const allOn = set.tests.every((t) => set.checked[t.id] !== false);
  for (const t of set.tests) set.checked[t.id] = !allOn;
  set.save(); renderTests();
}

function openTestEditor(t) {
  const isNew = !t;
  const test = t || { id: "t_" + Math.random().toString(36).slice(2, 8), name: "New test", note: "", faults: [] };
  editTest(test, {
    rocket: currentRocket(), isNew,
    onSave: (nt) => { if (isNew) set.tests.push(nt); else set.tests[set.tests.findIndex((x) => x.id === nt.id)] = nt; set.selectedTest = nt.id; set.save(); renderTests(); renderBar(); },
    onDelete: () => { set.tests = set.tests.filter((x) => x.id !== test.id); if (!set.tests.length) set.tests = defaultTests(); set.selectedTest = set.tests[0].id; set.save(); renderTests(); renderBar(); },
  });
}

async function resetTests() {
  if (!(await confirmBox("Restore default tests", "Replace the test list with Mockingbird's standard tests? Tests you added or edited are removed.", "Restore"))) return;
  set.tests = defaultTests(); set.selectedTest = set.tests[0].id; set.checked = {}; set.save();
  renderTests(); renderBar();
}

function renderHistory() {
  clear(ui.histList);
  if (!set.history.length) { ui.histList.append(h("div", { class: "lib-empty" }, "Finished tests are listed here and saved to Documents\\Aviary\\Mockingbird Runs, where Heron can open them.")); return; }
  for (const r of set.history.slice(0, 30)) {
    const d = new Date(r.at);
    ui.histList.append(h("div", { class: "hist-item" + (M.report?.dir && M.report.dir === r.dir ? " on" : ""), title: r.dir || "", onclick: () => openPast(r) },
      h("span", { class: "dot " + r.verdict }), h("div", null, h("div", { class: "nm" }, r.test), h("div", { class: "dt" }, `${r.verdict === "pass" ? "Passed" : r.verdict === "fail" ? "Failed" : "Stopped"} · ${r.rocket.replace(/^Example:\s*/, "")} · ${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`))));
  }
}

// ------------------------------------------------------------------ connection
function openConnect(after) {
  let type = set.link.type === "virtual" ? "virtual" : "serial";
  const cards = h("div", { class: "conn-cards two" });
  const pane = h("div");
  const state = { port: null, granted: [] };
  const draw = async () => {
    clear(cards);
    for (const [k, t, d] of [["serial", "Your flight computer", "Over its USB cable (or any serial port)"], ["virtual", "Virtual flight computer", "Built in, for trying Mockingbird out"]]) {
      cards.append(h("button", { class: "conn-card" + (k === type ? " on" : ""), onclick: () => { type = k; draw(); } }, h("b", null, t), h("span", null, d)));
    }
    clear(pane);
    if (type === "serial") {
      if (!serialSupported()) { pane.append(h("p", { class: "note" }, "Serial ports need Microsoft Edge or Google Chrome. Mockingbird opens in Edge automatically; if you're seeing this in another browser, open the same address in Edge.")); return; }
      state.granted = await new SerialLink().grantedPorts();
      if (!state.port && state.granted.length === 1) state.port = state.granted[0];
      const portLabel = h("span", { class: "muted" }, state.port ? describePort(state.port) : "No port chosen yet");
      const list = h("div", { class: "col", style: { gap: "4px", margin: "8px 0" } });
      state.granted.forEach((p, i) => list.append(h("label", { class: "check" }, h("input", { type: "radio", name: "port", checked: state.port === p, onchange: () => { state.port = p; portLabel.textContent = describePort(p, i); } }), describePort(p, i))));
      pane.append(
        h("div", { class: "row" }, h("button", { class: "btn", onclick: async () => { try { const p = await new SerialLink().choose(); if (p) { state.port = p; draw(); } } catch (e) { toast(e.message, "fault"); } } }, "Choose port…"), portLabel),
        state.granted.length ? h("div", null, h("div", { class: "sub-title" }, "Ports you've used before"), list) : h("p", { class: "note" }, "Plug the flight computer in first. Close the Arduino IDE's Serial Monitor, because only one program can use a port at a time."),
        h("div", { class: "grid-form", style: { marginTop: "10px" } },
          selectField("Baud rate", set.link.baud, BAUDS.map((b) => [b, String(b)]), (v) => { set.link.baud = Number(v); set.save(); }),
          h("div", { class: "field" }, h("span", null, "On connect"), checkField("Restart the board (DTR)", set.link.dtr, (v) => { set.link.dtr = v; set.save(); }, { title: "Most Arduino boards restart when the port opens with DTR on, so every test starts from a fresh boot." }))),
        h("p", { class: "safety", style: { marginTop: "12px" } }, "Take out igniters and e-matches and unplug the pyro battery before testing."));
    } else {
      pane.append(h("p", { style: { marginTop: 0 } }, "A deliberately simple dual-deploy and staging flight computer that runs inside Mockingbird and speaks the same protocol as the Arduino library. Use it to see how tests work."),
        h("p", { class: "note" }, "It uses a basic filter, so a few of the fault tests are designed to catch it out. That's what they're for."));
    }
  };
  draw();
  modal({
    title: "Connect a flight computer", body: h("div", null, cards, pane), wide: false,
    actions: [{ label: "Cancel" }, {
      label: "Connect", kind: "primary", onClick: async () => {
        set.link.type = type; set.save();
        try {
          if (type === "serial") { if (!state.port) { toast("Choose a serial port first.", "fault"); return false; } await connectSerial(state.port); }
          else connectVirtual();
          if (after) setTimeout(after, type === "virtual" ? 0 : 300);
        } catch (e) { toast(e.message, "fault", 8000); return false; }
      },
    }],
  });
}

async function connectSerial(port) {
  const link = new SerialLink({
    onLine: (l) => fromFC(l),
    onStatus: (s) => {
      if (s.type === "lost") { logEvent("The flight computer was unplugged", "bad"); if (M.run) stopRun("The flight computer was unplugged"); M.link = null; afterLinkChange(); }
      else if (s.type === "warn") consoleAdd(s.message, "err");
    },
  });
  await link.connect(port, { baudRate: set.link.baud, dtr: set.link.dtr });
  M.link = { type: "serial", label: describePort(port), serial: link };
  M.hello = null; M.rxCount = 0; M.connectedAt = performance.now(); M.lastPing = performance.now(); M.safetyAck = false;
  logEvent("Connected", "good", `${describePort(port)} at ${set.link.baud} baud`);
  afterLinkChange();
}

function connectVirtual() {
  M.link = { type: "virtual", label: "Virtual flight computer" };
  M.hello = "Virtual flight computer"; M.rxCount = 0;
  logEvent("Connected", "good", "Virtual flight computer");
  afterLinkChange();
}

async function disconnect() {
  if (M.run && !(await confirmBox("Stop the test?", "A test is running. Disconnecting stops it.", "Stop and disconnect", "danger"))) return;
  if (M.run) stopRun("Disconnected");
  const l = M.link;
  M.link = null; M.hello = null;
  if (l?.serial) { try { await l.serial.close(); } catch { /* */ } }
  if (l) logEvent("Disconnected", "", l.label);
  afterLinkChange();
}

function afterLinkChange() {
  ui.connectBtn.textContent = M.link ? "Disconnect" : "Connect…";
  ui.connectBtn.classList.toggle("primary", !M.link);
  renderPill(); renderSpeed(); renderBar(); renderSide(true);
  if (set.tab === "fc") renderFC();
}

async function tryVirtual() {
  if (M.run) return;
  if (M.link?.type !== "virtual") { if (M.link) await disconnect(); set.link.type = "virtual"; set.save(); connectVirtual(); }
  selectTest(set.tests.find((t) => t.id === "nominal") ? "nominal" : set.tests[0].id);
  startRun(currentTest());
}

function renderPill() {
  let cls = "pill", text = "Not connected";
  if (M.run) { cls = "pill go live"; text = `Testing ${M.clockText || ""}`; }
  else if (M.link?.type === "virtual") { cls = "pill go"; text = "Virtual flight computer"; }
  else if (M.link?.type === "serial") {
    if (M.hello) { cls = "pill go"; text = `Ready: ${M.hello}`; }
    else if (M.rxCount) { cls = "pill caution"; text = "Connected, no Mockingbird reply"; }
    else { cls = "pill caution"; text = "Connected, waiting for the board"; }
  }
  ui.pill.className = cls; ui.pill.lastChild.textContent = text;
  ui.pill.title = M.link?.label || "";
}

// Lines from the flight computer (serial or virtual).
function fromFC(line) {
  M.rxCount++;
  consoleAdd(line, "rx");
  M.log.push(`${logStamp()}\t< ${line}`);
  if (M.log.length > 20000) M.log.splice(0, 5000);
  const hello = line.match(/^\$MBE,(READY|PONG)(?:,([^*]*))?/i);
  if (hello) { const name = (hello[2] || "").trim() || "flight computer"; if (M.hello !== name && M.link?.type === "serial") logEvent("Flight computer answered", "good", name); M.hello = name; renderPill(); }
  // the board's last "samples received" count arrives just after the test stops
  if ((!M.run || M.run.done) && M.lastRunObj && /^\$MBE,STATS,/.test(line)) {
    M.lastRunObj.handleLine(line);
    if (M.report) { M.report.boardStats = M.lastRunObj.fcStats; if (ui.sideTab === "result") renderSide(true); }
  }
  if (M.run && !M.run.done) {
    M.rxDuringRun++;
    const r = M.run.handleLine(line);
    if (line.startsWith("$MBL,")) logEvent(line.slice(5).split("*")[0].trim(), "fc", "flight computer note", runT());
    if (r?.kind === "tlm") M.fcDirty = true;
  }
}

function sendLine(line) {
  const sample = !/^\$MB[CH],/.test(line);
  M.txCount++; M.txBytes += line.length + 1;
  if (!sample || set.run.showSent) consoleAdd(line, "tx");
  if (!sample) M.log.push(`${logStamp()}\t> ${line}`);
  if (M.link?.type === "virtual") M.vfc?.receive(line);
  else if (M.link?.type === "serial") M.link.serial.writeLine(line).catch(() => {});
}

const runT = () => (M.run ? M.run.sim.t - M.run.launchAt : null);
const logStamp = () => (M.run ? (M.run.sim.t - M.run.launchAt).toFixed(3) : new Date().toISOString());

// ------------------------------------------------------------------ running a test
async function startRun(test, fromSuite = false) {
  if (M.run || !test) return;
  const rocket = test.rocketOverride || currentRocket();
  if (!testApplies(test, rocket)) { toast(`"${test.name}" needs a rocket with at least ${test.needsStages} stages.`, "fault"); return; }
  if (!M.link) { openConnect(() => startRun(test, fromSuite)); return; }
  if (M.link.type === "serial" && !M.safetyAck) {
    const ok = await confirmBox("Before the first test", "Mockingbird makes the flight computer believe it is flying, so it will try to fire every pyro channel. Take out all igniters and e-matches and unplug the pyro battery.", "Charges are disconnected, start", "primary");
    if (!ok) { M.suite = null; renderBar(); return; }
    M.safetyAck = true;
  }
  if (M.link.type === "serial" && !M.hello && !fromSuite) {
    const ok = await confirmBox("No reply yet", "The flight computer hasn't answered Mockingbird's PING. That's expected if your firmware doesn't use the MockingbirdHIL library; otherwise check the baud rate and that it calls hil.poll(). Start anyway?", "Start anyway");
    if (!ok) return;
  }
  const virtual = M.link.type === "virtual";
  const pyro = pyroFor(set, rocket);
  const speed = virtual ? set.run.vfcSpeed : set.run.speed;
  // a replay sends the log's own readings, so no extra noise on top
  const noise = test.replay ? { baro: 0, accel: 0, gyro: set.run.noise.gyro } : test.noiseScale ? { baro: set.run.noise.baro * test.noiseScale, accel: set.run.noise.accel * test.noiseScale, gyro: set.run.noise.gyro } : set.run.noise;
  const site = test.siteOverride || M.store.site;
  const cfg = {
    rate: set.run.rate, fields: set.run.fields, protocol: virtual ? "mb" : set.run.protocol, template: set.run.template, templateCS: set.run.templateCS,
    padTime: test.padTime ?? set.run.padTime, timeScale: speed || 1, noise, axis: set.run.axis, pyro, rules: set.run.rules, tol: set.run.tol,
  };
  const replay = test.replay || null;
  resetRunView();
  const { replay: _r, rocketOverride: _ro, siteOverride: _so, ...testMeta } = test;
  M.test = structuredClone(testMeta); M.rocketSnap = structuredClone(rocket); M.cfgSnap = structuredClone(cfg); M.siteSnap = structuredClone(site);
  M.geoSnap = test.replayGeo || siteGeo(site);
  M.txCount = 0; M.txBytes = 0; M.rxDuringRun = 0; M.slowLink = false; M.rates = []; M.log = []; M.lastFlush = 0;
  try {
    M.run = new HILRun({ rocket, site, cfg: replay ? { ...cfg, replay } : cfg, faults: structuredClone(test.faults), send: sendLine, onEvent: onRunEvent, onSample, seed: test.seed ?? ((Math.random() * 1e9) | 0) });
  } catch (e) { toast("Couldn't start: " + e.message, "fault", 8000); M.run = null; return; }
  if (virtual) M.vfc = new VirtualFC({ rocket, pyro, upAxis: cfg.axis.up, upSign: cfg.axis.sign, send: (l) => fromFC(l) });
  M.speed = speed;
  logEvent(`Started ${test.name}`, "", `${cfg.rate}/s${speed > 1 ? `, ${speed}×` : speed === 0 ? ", instant" : ""}`, -cfg.padTime);
  M.run.start();
  M.runStart = performance.now();
  for (const c of [ui.altC, ui.velC, ui.senC]) { c.o.streaming = speed !== 0; c.resetView(); }
  ui.emptyRun.classList.add("hidden");
  ui.sideTab = "events"; ui.sideTabs.set("events");
  renderBar(); renderSpeed(); renderSide(true); renderPill(); renderTestSel();
  if (speed === 0) instantLoop(); else M.ticker = makeTicker(10, runTick);
}

// A timer that keeps running when the window is in the background.
function makeTicker(ms, fn) {
  try {
    const src = `let i=setInterval(()=>postMessage(0),${ms});onmessage=()=>{clearInterval(i);close()}`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = fn;
    return { stop: () => { try { w.postMessage(0); w.terminate(); } catch { /* */ } } };
  } catch {
    const i = setInterval(fn, ms);
    return { stop: () => clearInterval(i) };
  }
}

function runTick() {
  const run = M.run;
  if (!run || M.finishing) return;
  const el = (performance.now() - M.runStart) / 1000;
  try { run.advanceTo(el * M.speed); } catch (e) { stopRun("Error: " + e.message); return; }
  if (M.link?.type === "serial" && M.link.serial.backlog > 150 && !M.slowLink) {
    M.slowLink = true;
    logEvent("Serial link can't keep up", "bad", "Lower the sample rate or raise the baud rate");
    toast("The serial link can't carry this many samples. Lower the sample rate, drop fields, or raise the baud rate.", "fault", 9000);
  }
  if (performance.now() - M.lastFlush > 80) { M.lastFlush = performance.now(); flushCharts(); }
  if (run.done) finishRun();
}

function instantLoop() {
  const run = M.run;
  const step = () => {
    if (M.run !== run || M.finishing) return;
    try { run.advanceTo(run.sim.t + 4); } catch (e) { stopRun("Error: " + e.message); return; }
    flushCharts();
    if (run.done) finishRun(); else setTimeout(step, 0);
  };
  step();
}

function stopRun(reason = "Stopped by you") {
  if (!M.run) return;
  if (M.suite) { M.suite = null; toast("Stopped the remaining tests"); }
  M.run.stop(reason);
  finishRun();
}

function resetRunView() {
  M.events = []; M.bands = new Map(); M.bandList = []; M.markers = []; M.ci = 0; M.fci = {}; M.fcState = null; M.report = null; M.ds = null;
  if (!M.suite) M.suiteSummary = null;
  for (const c of [ui.altC, ui.velC, ui.senC]) { for (const s of c.series) { s.x = []; s.y = []; s.n = 0; } c.setMarkers([]); c.setBands([]); }
  ui.anim?.setData(null);
  renderRail("pad", null);
}

function onSample(m, act) {
  const run = M.run, x = run.sim.t - run.launchAt;
  for (const fl of run.faults) {
    if (fl.ref === "whole" || FAULT_TYPES[fl.type]?.whole) continue;
    // a drift keeps its offset afterwards, but only the drifting part is shaded
    const on = act.includes(fl) && (!FAULT_TYPES[fl.type]?.holds || run.sim.t <= run._faultStart(fl) + Number(fl.duration || 0));
    let b = M.bands.get(fl);
    if (on && !b) { b = { x0: x, x1: x, label: FAULT_TYPES[fl.type]?.label || fl.type, open: true }; M.bands.set(fl, b); M.bandList.push(b); M.bandsDirty = true; }
    else if (on && b?.open) { b.x1 = x; M.bandsDirty = true; }
    else if (!on && b?.open) b.open = false;
  }
}

function onRunEvent(e) {
  const run = M.run;
  if (!run) return;
  const T = e.t - run.launchAt;
  if (e.type === "launch") { logEvent("Motor lit", "hot", "", T); return; }
  if (e.sim) {
    if (e.type === "liftoff") logEvent("Liftoff", "hot", "", T);
    else if (e.type === "railExit") logEvent("Off the rail", "", fmtV(e.v), T);
    else if (e.type === "burnout") logEvent(e.label, "", "", T);
    else if (e.type === "apogee") { logEvent("True apogee", "hot", fmtA(e.h), T); M.markers.push({ x: T, kind: "apogee", h: e.h }); M.markersDirty = true; }
    else if (e.type === "deploy") { logEvent(e.label, "", `${e.source === "motor" ? "motor ejection, " : ""}${fmtV(Math.abs(e.v))}`, T); M.markers.push({ x: T, kind: "deploy", text: e.label }); M.markersDirty = true; }
    else if (e.type === "ignition") logEvent(e.label, "hot", e.source === "direct" ? "direct staging" : "", T);
    else if (e.type === "separation") logEvent(e.label, "", "", T);
    else if (e.type === "dud") logEvent(e.label, "bad", "", T);
    else if (e.type === "landing") logEvent("Touchdown", Math.abs(e.impact) > set.run.tol.safeLanding ? "bad" : "good", fmtV(Math.abs(e.impact)), T);
    return;
  }
  if (e.type === "fc") {
    logEvent(`Flight computer: ${e.label}`, "fc", "", T);
    if (e.name === "STATE") M.fcState = e.value;
    if (["APOGEE", "LAUNCH", "BURNOUT", "LANDED"].includes(e.name)) { M.markers.push({ x: T, kind: "fc", text: `FC ${e.name.toLowerCase()}` }); M.markersDirty = true; }
    return;
  }
  if (e.type === "action") {
    logEvent(e.label, e.bad ? "bad" : e.applied ? "good" : "", e.h !== undefined ? `${fmtA(e.h)}, ${fmtV(e.v)}` : "", T);
    M.markers.push({ x: T, kind: e.bad ? "bad" : "action", text: e.label.replace(/\s*\(.*\)$/, "") }); M.markersDirty = true;
  }
}

const FC_ALT = /^(alt|altitude|agl|h|height|baro_?alt|est_?alt)$/i;
const FC_VEL = /^(vel|velocity|v|vz|speed|vspeed|est_?vel)$/i;

function flushCharts() {
  const run = M.run;
  if (!run) return;
  const L = run.launchAt, T = run.truth, S = run.sensed;
  const at = ui.altC.getSeries("truth"), vt = ui.velC.getSeries("truth"), sb = ui.senC.getSeries("baro"), sa = ui.senC.getSeries("acc");
  for (let i = M.ci; i < T.t.length; i++) {
    const x = T.t[i] - L;
    at.x.push(x); at.y.push(D.alt(T.h[i]));
    vt.x.push(x); vt.y.push(D.vel(T.v[i]));
    sb.x.push(x); sb.y.push(D.alt(S.baro[i]));
    sa.x.push(x); sa.y.push(S.acc[i]);
  }
  M.ci = T.t.length;
  for (const s of [at, vt, sb, sa]) s.n = s.x.length;
  for (const [name, ser] of Object.entries(run.fcTlm)) {
    const target = FC_ALT.test(name) ? ui.altC.getSeries("fc") : FC_VEL.test(name) ? ui.velC.getSeries("fc") : null;
    if (!target) continue;
    const conv = target === ui.altC.getSeries("fc") ? D.alt : D.vel;
    for (let i = M.fci[name] || 0; i < ser.t.length; i++) { const x = ser.t[i] - L; if (target.n && x < target.x[target.n - 1]) continue; target.x.push(x); target.y.push(conv(ser.v[i])); target.n++; }
    M.fci[name] = ser.t.length;
  }
  if (M.bandsDirty) { M.bandsDirty = false; const b = bandSpecs(M.bandList); for (const c of [ui.altC, ui.velC, ui.senC]) c.setBands(b); }
  if (M.markersDirty) { M.markersDirty = false; applyMarkers(M.markers); }
  for (const c of [ui.altC, ui.velC, ui.senC]) c.redraw();
  renderRail(run.sim.phase, run);
  if (ui.view === "anim" && performance.now() - (M.lastAnimFeed || 0) > 150) { M.lastAnimFeed = performance.now(); feedAnim(); }
}

const bandSpecs = (list) => list.map((b) => ({ x0: b.x0, x1: Math.max(b.x1, b.x0 + 0.08), color: "--caution", alpha: 0.16, label: b.label }));

function applyMarkers(list) {
  const style = { apogee: ["--orange", undefined], deploy: ["--go", "--go"], action: ["--go", "--go"], bad: ["--fault", "--fault"], fc: ["--d-acc", "--d-acc"] };
  const m = list.map((k) => ({ x: k.x, label: k.kind === "apogee" ? `Apogee ${fmtA(k.h)}` : k.text, color: style[k.kind][0], textColor: style[k.kind][1], dash: k.kind === "fc" ? [2, 3] : undefined }));
  ui.altC.setMarkers(m);
  ui.velC.setMarkers(m.map((x) => ({ ...x, label: "" })));
  ui.senC.setMarkers(m.map((x) => ({ ...x, label: "" })));
}

function renderRail(phase, run) {
  const cur = RAIL_INDEX[phase] ?? 0;
  for (const el of ui.rail.children) {
    const i = RAIL_INDEX[el.dataset.k];
    el.className = "ph" + (i < cur ? " done" : i === cur ? " now" : "");
  }
  if (run) {
    const x = run.sim.t - run.launchAt;
    M.clockText = `${tlabel(x)} s`;
    ui.clock.textContent = M.clockText;
  } else if (!M.ds) ui.clock.textContent = "–";
}

async function finishRun() {
  const run = M.run;
  if (!run || M.finishing) return;
  M.finishing = true;
  M.ticker?.stop(); M.ticker = null;
  flushCharts();
  const stopped = !["Landed", "All expected actions happened", "Time limit reached"].includes(run.endReason);
  let rep;
  try { rep = run.report({ fmtAlt: fmtA, fmtVel: fmtV }); }
  catch (e) { rep = { verdict: "fail", checks: [], detections: [], outcome: {}, endReason: run.endReason, actions: [], fcEvents: [], samples: run.sent, faults: run.faults, error: e.message }; }
  const at = new Date().toISOString();
  const rocket = M.rocketSnap, test = M.test;
  M.report = { ...rep, stopped, fcLines: M.rxDuringRun, slowLink: M.slowLink, meta: { test, rocket: { id: rocket.id, name: rocket.name }, at, link: M.link?.label || "", linkType: M.link?.type || "", hello: M.hello, speed: M.speed, units: set.units } };
  M.ds = datasetFromRun(run);
  M.run = null; M.vfc = null; M.finishing = false;
  if (ui.view === "anim") feedAnim();
  M.lastRunObj = run;
  if (!stopped) {
    (set.status[rocket.id] ||= {})[test.id] = { verdict: rep.verdict, at };
    logEvent(rep.verdict === "pass" ? "Test passed" : "Test failed", rep.verdict === "pass" ? "good" : "bad", run.endReason, runTFrom(run));
  } else logEvent("Test stopped", "bad", run.endReason, runTFrom(run));
  let dir = null;
  if (M.link?.type === "serial") await new Promise((r) => setTimeout(r, 700)); // the board's final sample count
  if (run.fcStats) M.report.boardStats = run.fcStats;
  try { dir = await saveRun(run, M.report); } catch (e) { toast("Couldn't save the run: " + e.message, "fault", 8000); }
  M.report.dir = dir;
  set.history.unshift({ dir, testId: test.id, test: test.name, rocketId: rocket.id, rocket: rocket.name, verdict: stopped ? "stopped" : rep.verdict, at, apogee: rep.outcome?.apogee });
  set.history = set.history.slice(0, 60);
  set.save();
  for (const c of [ui.altC, ui.velC, ui.senC]) { c.o.streaming = false; c.resetView(); }
  if (M.suite) M.suite.results.push({ test: test.name, verdict: stopped ? "stopped" : rep.verdict, firstFail: rep.checks?.find((c) => !c.ok)?.label || "", dir,
    ...(M.suite.onDone ? { rep: { verdict: rep.verdict, checks: rep.checks, outcome: rep.outcome }, params: test.mcParams } : {}) });
  ui.sideTab = "result"; ui.sideTabs.set("result");
  renderTests(); renderHistory(); renderBar(); renderSpeed(); renderSide(true); renderPill();
  if (M.suite) {
    if (M.suite.queue.length) setTimeout(nextInSuite, M.link?.type === "virtual" ? 400 : 2500);
    else finishSuite();
  } else toast(stopped ? "Test stopped" : rep.verdict === "pass" ? `Passed: ${test.name}` : `Failed: ${test.name}`, stopped ? "" : rep.verdict === "pass" ? "go" : "fault");
}
const runTFrom = (run) => run.sim.t - run.launchAt;

async function saveRun(run, rep) {
  const dir = `${stamp()} ${safeName(rep.meta.rocket.name.replace(/^Example:\s*/, ""))} - ${safeName(rep.meta.test.name)}`;
  await host.write("mockingbird", `${dir}/flight.csv`, run.csv());
  const doc = { app: "Mockingbird", version, savedAt: rep.meta.at, ...rep, rocketProfile: M.rocketSnap, site: M.siteSnap || M.store.site, geo: M.geoSnap || null, settings: M.cfgSnap, bands: M.bandList.map((b) => ({ x0: b.x0, x1: b.x1, label: b.label })), markers: M.markers };
  await host.write("mockingbird", `${dir}/report.json`, JSON.stringify(doc, null, 2));
  await host.write("mockingbird", `${dir}/console.txt`, M.log.join("\n") + "\n");
  M.log = [];
  return dir;
}

// Plain SI copy of a run, so the charts can be redrawn in other units.
// ------------------------------------------------------------------ animation
function setView(v) {
  ui.view = v;
  ui.viewSeg.set(v);
  ui.stack.classList.toggle("hidden", v !== "charts");
  ui.wholeBtn.classList.toggle("hidden", v !== "charts");
  ui.animBox.classList.toggle("hidden", v !== "anim");
  if (v === "anim") {
    if (!ui.anim) ui.anim = new FlightAnimation(ui.animBox, { units: D, name: "Mockingbird run" });
    feedAnim(true);
  } else for (const c of [ui.altC, ui.velC, ui.senC]) c.redraw();
}

const animEvents = (markers) => markers.filter((k) => k.kind !== "fc").map((k) => ({ t: k.x, label: k.kind === "apogee" ? `Apogee ${fmtA(k.h)}` : k.text, kind: k.kind === "bad" ? "bad" : "" }));

const siteGeo = (st) => (st && Number.isFinite(Number(st.lat)) && Number.isFinite(Number(st.lon)) && !(Number(st.lat) === 0 && Number(st.lon) === 0) ? { lat: Number(st.lat), lon: Number(st.lon) } : null);

function feedAnim(fresh = false) {
  if (!ui.anim) return;
  ui.anim.setUnits(D);
  const run = M.run;
  if (run) {
    ui.anim.name = `${M.rocketSnap?.name || "Rocket"} - ${M.test?.name || "test"}`;
    const L = run.launchAt, x = run.truth.t.map((t) => t - L);
    ui.anim.setData({ t: x, h: run.truth.h, v: run.truth.v, east: run.truth.x, north: run.truth.y, geo: M.geoSnap, phases: phasesFromSamples(x, run.truth.phase), events: animEvents(M.markers) }, { live: true });
  } else if (M.ds) {
    const ds = M.ds;
    ui.anim.name = M.report?.dir || (M.report?.meta ? `${M.report.meta.rocket?.name} - ${M.report.meta.test?.name}` : "Mockingbird run");
    ui.anim.setData({ t: ds.x, h: ds.h, v: ds.v, east: ds.east, north: ds.north, geo: ds.geo || siteGeo(ds.site), phases: ds.ph ? phasesFromSamples(ds.x, ds.ph) : [], events: animEvents(ds.markers) });
    if (fresh) ui.anim.play();
  } else ui.anim.setData(null);
}

function datasetFromRun(run) {
  const L = run.launchAt;
  const fc = (re) => { const k = Object.keys(run.fcTlm).find((n) => re.test(n)); return k ? { x: run.fcTlm[k].t.map((t) => t - L), y: run.fcTlm[k].v } : { x: [], y: [] }; };
  return { x: run.truth.t.map((t) => t - L), h: run.truth.h.slice(), v: run.truth.v.slice(), baro: run.sensed.baro.slice(), acc: run.sensed.acc.slice(), ph: run.truth.phase.slice(), east: run.truth.x.slice(), north: run.truth.y.slice(), site: structuredClone(M.siteSnap || M.store.site), geo: M.geoSnap, fcAlt: fc(FC_ALT), fcVel: fc(FC_VEL), markers: M.markers.slice(), bands: M.bandList.map((b) => ({ ...b })), phase: run.sim.phase, end: run.sim.t - L };
}

function drawDataset(ds, replay = true) {
  const set2 = (c, id, x, y) => c.setData(id, x, y);
  set2(ui.altC, "truth", ds.x, ds.h.map(D.alt));
  set2(ui.velC, "truth", ds.x, ds.v.map(D.vel));
  set2(ui.senC, "baro", ds.x, ds.baro.map(D.alt));
  set2(ui.senC, "acc", ds.x, ds.acc);
  set2(ui.altC, "fc", ds.fcAlt.x, ds.fcAlt.y.map(D.alt));
  set2(ui.velC, "fc", ds.fcVel.x, ds.fcVel.y.map(D.vel));
  const b = bandSpecs(ds.bands);
  for (const c of [ui.altC, ui.velC, ui.senC]) { c.setBands(b); c.o.streaming = false; c.resetView(); }
  applyMarkers(ds.markers);
  renderRail(ds.phase, null);
  ui.clock.textContent = Number.isFinite(ds.end) ? `${tlabel(ds.end)} s` : "–";
  ui.emptyRun.classList.add("hidden");
  if (ui.view === "anim") feedAnim(replay);
}

async function openPast(r) {
  if (M.run) { toast("Wait for the current test to finish."); return; }
  if (!r.dir) { toast("That run wasn't saved.", "fault"); return; }
  try {
    const doc = JSON.parse(await host.read("mockingbird", `${r.dir}/report.json`));
    const csv = await host.read("mockingbird", `${r.dir}/flight.csv`);
    M.report = { ...doc, dir: r.dir };
    M.suiteSummary = null;
    M.lastRunObj = null;
    M.ds = datasetFromCSV(csv, doc);
    drawDataset(M.ds);
    if (set.tab !== "run") showTab("run");
    ui.sideTab = "result"; ui.sideTabs.set("result");
    renderSide(true); renderHistory();
  } catch (e) { toast("Couldn't open that run: " + e.message, "fault"); }
}

function datasetFromCSV(text, doc) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(",");
  const col = (n) => head.indexOf(n);
  const iT = col("time_s"), iH = col("alt_m"), iV = col("vel_mps"), iP = col("phase"), iB = col("sensed_baro_alt_m"), iA = col("sensed_accel_g");
  const fcA = head.findIndex((n) => n.startsWith("fc_") && FC_ALT.test(n.slice(3))), fcV = head.findIndex((n) => n.startsWith("fc_") && FC_VEL.test(n.slice(3)));
  const iE = col("east_m"), iN = col("north_m");
  const ds = { east: iE >= 0 ? [] : null, north: iN >= 0 ? [] : null, site: doc.site || null, geo: doc.geo || null, x: [], h: [], v: [], ph: [], baro: [], acc: [], fcAlt: { x: [], y: [] }, fcVel: { x: [], y: [] }, markers: doc.markers || [], bands: doc.bands || [], phase: "pad", end: NaN };
  const shift = (doc.settings?.padTime ?? 0) && doc.liftoff !== undefined ? doc.liftoff - doc.settings.padTime : 0; // csv is relative to liftoff
  const num = (s) => (s === "" || s === undefined ? NaN : Number(s));
  for (const ln of lines) {
    const c = ln.split(",");
    const x = num(c[iT]) + shift;
    ds.x.push(x); ds.h.push(num(c[iH])); ds.v.push(num(c[iV]));
    ds.baro.push(iB >= 0 ? num(c[iB]) : NaN); ds.acc.push(iA >= 0 ? num(c[iA]) : NaN);
    if (fcA >= 0 && c[fcA] !== "") { ds.fcAlt.x.push(x); ds.fcAlt.y.push(num(c[fcA])); }
    if (fcV >= 0 && c[fcV] !== "") { ds.fcVel.x.push(x); ds.fcVel.y.push(num(c[fcV])); }
    ds.ph.push(iP >= 0 ? c[iP] : "");
    if (ds.east) { ds.east.push(num(c[iE])); ds.north.push(num(c[iN])); }
    if (iP >= 0) ds.phase = c[iP] || ds.phase;
  }
  ds.end = ds.x[ds.x.length - 1];
  return ds;
}

// ------------------------------------------------------------------ suites
function runChecked() {
  if (M.run) return;
  const rocket = currentRocket();
  const list = set.tests.filter((t) => set.checked[t.id] !== false && testApplies(t, rocket));
  if (!list.length) { toast("Tick at least one test."); return; }
  if (!M.link) { openConnect(() => runChecked()); return; }
  M.suite = { queue: list.map((t) => t.id), total: list.length, results: [], rocket: rocket.name, started: new Date().toISOString() };
  M.suiteSummary = null;
  nextInSuite();
}

function nextInSuite() {
  if (!M.suite) return;
  const id = M.suite.queue.shift();
  const t = typeof id === "object" ? id : set.tests.find((x) => x.id === id);
  if (!t) { if (M.suite.queue.length) nextInSuite(); else finishSuite(); return; }
  if (typeof id !== "object") { set.selectedTest = t.id; set.save(); renderTests(); }
  startRun(t, true);
}

function finishSuite() {
  const s = M.suite;
  M.suite = null;
  if (!s) return;
  M.suiteSummary = s;
  if (s.onDone) { s.onDone(s.results.filter((r) => r.rep && r.verdict !== "stopped")); renderSide(true); renderBar(); return; }
  const passed = s.results.filter((r) => r.verdict === "pass").length;
  toast(`${passed} of ${s.results.length} tests passed`, passed === s.results.length ? "go" : "fault", 7000);
  renderSide(true); renderBar();
}

// ------------------------------------------------------------------ Monte Carlo and replay
function mcCtx() {
  const rocket = currentRocket(), test = currentTest();
  const virtual = M.link?.type === "virtual";
  const pyro = pyroFor(set, rocket);
  return {
    set, D, rocket, site: M.store.site, test, pyro, virtual, host, save: () => set.save(),
    cfg: () => ({ rate: set.run.rate, fields: set.run.fields, protocol: "mb", padTime: set.run.padTime, timeScale: 1, noise: set.run.noise, axis: set.run.axis, pyro, rules: set.run.rules, tol: set.run.tol }),
    runSeries: (tests, onDone) => {
      M.suite = { queue: tests, total: tests.length, results: [], rocket: rocket.name, started: new Date().toISOString(), onDone, mc: true };
      M.suiteSummary = null;
      nextInSuite();
    },
    // watch one of the flights from the summary, with its exact conditions
    rerun: (r) => {
      if (!r.params) return;
      const p = r.params;
      const rk = structuredClone(rocket); for (const st of rk.stages) { st.dryMass *= p.mass; st.cd *= p.cd; }
      startRun({ id: "mc-watch", name: "Monte Carlo flight", faults: [...(set.mc?.keepFaults ? structuredClone(test.faults || []) : []), { type: "thrust", params: { factor: p.thrust }, enabled: true }],
        padTime: Math.round(p.padTime), rocketOverride: rk, siteOverride: { ...M.store.site, windSpeed: p.wind, windDir: p.windDir }, noiseScale: p.noise, seed: r.seed });
    },
  };
}
function startMonteCarlo() {
  if (M.run) return;
  if (!M.link) { openConnect(() => startMonteCarlo()); return; }
  openMonteCarlo(mcCtx());
}

// Pick a log (from the Aviary folders or anywhere), check what Heron finds
// in it, then play it into the flight computer.
async function openReplay() {
  if (M.run) return;
  const AREAS = [["heron", "Heron library"], ["owl", "Owl recordings"]];
  const list = h("div", { class: "replay-list" }, h("p", { class: "muted" }, "Looking for logs…"));
  const info = h("div", { class: "replay-info" });
  let chosen = null;
  const choose = (text, name) => {
    clear(info);
    try {
      const r = replayFromLog(text, name);
      const sm = r.summary;
      chosen = { ...r, name };
      info.append(h("h3", null, name),
        r.replay.notFlight ? h("div", { class: "safety" }, "Heron doesn't think this log shows a real flight (the biggest change came and went too fast). It can still be replayed.") : "",
        h("div", { class: "kv" },
          h("span", { class: "k" }, "Apogee"), h("span", null, `${fmtA(sm.apogee)} at T+${sm.timeToApogee.toFixed(1)} s`),
          h("span", { class: "k" }, "Burnout"), h("span", null, `T+${sm.burnout.toFixed(2)} s`),
          h("span", { class: "k" }, "Landing"), h("span", null, sm.flightTime != null ? `T+${sm.flightTime.toFixed(1)} s` : "not in the log (the replay ends with the log)"),
          h("span", { class: "k" }, "Pad data"), h("span", null, `${sm.padBefore.toFixed(1)} s before liftoff, as recorded`),
          h("span", { class: "k" }, "Acceleration"), h("span", null, sm.accel),
          h("span", { class: "k" }, "Position"), h("span", null, r.geo ? "GPS, so the 3D view uses the real site" : "no GPS: the 3D view uses the rocket profile's site")),
        h("p", { class: "note" }, `Graded against “${currentRocket().name}”: its deployment rules say when each output should fire on this flight.`));
      startBtn.disabled = false;
    } catch (e) { chosen = null; startBtn.disabled = true; info.append(h("div", { class: "safety" }, "Couldn't read that log: " + e.message)); }
  };
  const startBtn = h("button", { class: "btn primary", disabled: true, onclick: () => {
    if (!chosen) return;
    dlg.close();
    startRun({ id: "replay", name: `Replay: ${chosen.name}`, faults: [], note: `Real flight data from ${chosen.name}, sent as it was recorded.`, padTime: Math.max(2, Math.min(10, Math.floor(chosen.summary.padBefore) || 2)), replay: chosen.replay, replayGeo: chosen.geo });
  } }, "Replay into the flight computer");
  const dlg = modal({ title: "Replay a real flight", wide: true, body: h("div", { class: "replay" }, h("div", null,
    h("button", { class: "btn small", onclick: async () => { const f = await pickFile(".csv,.txt,.tsv,.log,.dat"); if (f) choose(await readFileText(f), f.name); } }, "Open a file…"), list), info),
    actions: [{ label: "Cancel" }] });
  dlg.el.querySelector(".modal-foot").append(startBtn);
  clear(list);
  for (const [area, label] of AREAS) {
    let files = [];
    try { files = (await host.list(area)).files.filter((f) => !f.dir && /\.(csv|txt|tsv|log|dat)$/i.test(f.name) && !/(^|\/)(raw|console)\.txt$/i.test(f.path)); } catch { /* */ }
    if (!files.length) continue;
    list.append(h("h4", null, label), h("ul", null, files.slice(0, 40).map((f) => h("li", null, h("button", { class: "linkish", onclick: async () => choose(await host.read(area, f.path), f.path.split("/").pop() === "telemetry.csv" ? f.path.split("/")[0] : f.name) }, f.path.split("/").pop() === "telemetry.csv" ? f.path.split("/")[0] : f.name)))));
  }
  if (!list.children.length) list.append(h("p", { class: "muted" }, "No logs in the Heron library or Owl recordings yet. Open a file instead."));
}

// ------------------------------------------------------------------ side panel
function logEvent(what, kind = "", detail = "", t = null) {
  M.events.unshift({ what, kind, detail, t, clock: new Date() });
  if (M.events.length > 400) M.events.pop();
  ui.eventsDirty = true;
}

function consoleAdd(text, kind) {
  M.consoleLines.push([kind, text]);
  if (M.consoleLines.length > 600) M.consoleLines.splice(0, M.consoleLines.length - 600);
  ui.consoleDirty = true;
}

function renderSide(force = false) {
  const tab = ui.sideTab;
  if (tab === "events" && (force || ui.eventsDirty)) {
    ui.eventsDirty = false;
    clear(ui.sideBody);
    if (!M.events.length) ui.sideBody.append(h("div", { class: "empty" }, h("h3", null, "Nothing yet"), h("p", null, "Simulated events (liftoff, burnout, apogee), what the flight computer reported, and every pyro channel it fired appear here as the test runs.")));
    else ui.sideBody.append(h("ul", { class: "events" }, M.events.map((e) => h("li", { class: e.kind }, h("span", { class: "t" }, e.t !== null && e.t !== undefined ? tlabel(e.t) : e.clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })), h("span", { class: "what" }, e.what), h("span", { class: "det" }, e.detail || "")))));
  }
  if (tab === "console" && (force || (ui.consoleDirty && !ui.consolePaused))) {
    ui.consoleDirty = false;
    if (force || !ui.consoleEl || !ui.sideBody.contains(ui.consoleEl)) { clear(ui.sideBody); ui.consoleEl = h("div", { class: "console", role: "log" }); ui.sideBody.append(ui.consoleEl); }
    const el = ui.consoleEl;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.textContent = "";
    const frag = document.createDocumentFragment();
    for (const [k, t] of M.consoleLines.slice(-300)) frag.append(h("div", { class: k === "tx" ? "tx" : k === "err" ? "err" : k === "sys" ? "sys" : /^\$MBE,/.test(t) ? "ev" : "" }, (k === "tx" ? "› " : "") + t));
    el.append(frag);
    if (atBottom || force) el.scrollTop = el.scrollHeight;
  }
  if (tab === "result" && force) renderResult();
  if (force) renderFoot();
}

function renderFoot() {
  clear(ui.sideFoot);
  if (ui.sideTab !== "console") { ui.sideFoot.style.display = "none"; return; }
  ui.sideFoot.style.display = "flex";
  const serial = M.link?.type === "serial";
  const inp = h("input", { type: "text", placeholder: serial ? "Send a line to the board" : "Connect a board to send", disabled: !serial, "aria-label": "Send text" });
  const sendIt = () => { if (!inp.value || !serial) return; M.link.serial.writeLine(inp.value); consoleAdd(inp.value, "tx"); inp.value = ""; renderSide(false); };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") sendIt(); });
  ui.sideFoot.append(...[inp,
    h("button", { class: "btn small", disabled: !serial, onclick: sendIt }, "Send"),
    h("button", { class: "btn small" + (set.run.showSent ? " on" : ""), title: "Also show every sample line Mockingbird sends", onclick: (e) => { set.run.showSent = !set.run.showSent; set.save(); e.target.classList.toggle("on", set.run.showSent); } }, "Samples"),
    serial ? h("button", { class: "btn small", title: "Restart the board by pulsing DTR", onclick: async () => { M.hello = null; renderPill(); await M.link.serial.resetBoard(); consoleAdd("Board restarted (DTR)", "sys"); } }, "Restart") : null].filter(Boolean));
}

function renderResult() {
  const R = M.report;
  clear(ui.sideBody);
  const box = h("div", { class: "result" });
  ui.sideBody.append(box);
  if (M.suiteSummary) box.append(suiteTable(M.suiteSummary));
  if (!R) {
    if (!M.suiteSummary) box.append(h("div", { class: "empty" }, h("h3", null, "No result yet"), h("p", null, "When a test finishes, the verdict and every check appear here. Pick a past run on the left to see it again.")));
    return;
  }
  const verdict = R.stopped ? "stopped" : R.verdict;
  const when = R.meta?.at ? new Date(R.meta.at) : null;
  box.append(h("div", { class: "verdict-box " + verdict },
    h("div", { class: "big" }, verdict === "pass" ? "Passed" : verdict === "fail" ? "Failed" : "Stopped early"),
    h("div", { class: "who" }, `${R.meta?.test?.name || "Test"} · ${R.meta?.rocket?.name || ""}`),
    h("div", { class: "muted", style: { fontSize: "13px" } }, [when ? when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "", R.meta?.link ? ` · ${R.meta.link}` : "", R.meta?.hello && R.meta.linkType === "serial" ? ` (${R.meta.hello})` : ""].join(""))));
  if (R.error) box.append(h("div", { class: "res-sec" }, h("p", { class: "note", style: { color: "var(--fault)" } }, "The grader hit an error: " + R.error)));
  if (R.meta?.linkType === "serial" && R.fcLines === 0) box.append(h("div", { class: "res-sec" }, h("div", { class: "safety" }, "Mockingbird heard nothing from the flight computer during this test. Check the baud rate, that the firmware calls hil.poll(), and that the Serial Monitor is closed.")));
  if (R.slowLink) box.append(h("div", { class: "res-sec" }, h("div", { class: "safety" }, "The serial link couldn't keep up, so samples arrived late. Lower the sample rate or raise the baud rate.")));
  if (R.meta?.test?.note) box.append(h("div", { class: "res-sec note" }, R.meta.test.note));
  const checks = R.checks || [];
  box.append(h("div", { class: "res-sec flush" }, h("h4", null, "Checks"),
    checks.length ? h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : "bad" },
      h("span", { class: "ic", "aria-label": c.ok ? "passed" : "failed" }, c.ok ? "✓" : "✕"),
      h("span", { class: "lab" }, c.label + (c.ch ? ` (pyro ${c.ch})` : "")),
      h("span", { class: "ea" }, `Expected ${c.expected}. Got ${c.actual || "–"}.`),
      c.detail ? h("span", { class: "det" }, c.detail) : null)))
      : h("p", { class: "note", style: { padding: "0 12px" } }, "This rocket has nothing for a flight computer to do: no pyro deployments or staging. Add a drogue or main with a pyro channel on the Rocket tab.")));
  if (R.pyroTiming?.length) {
    const ms = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(0)} ms` : "–");
    const us = (x) => (x == null ? "–" : x < 1000 ? `${x} µs` : `${(x / 1000).toFixed(1)} ms`);
    const head = h("thead", null, h("tr", null,
      h("th", null, "Output"),
      h("th", { title: "From when it should have fired to the sample the board acted on" }, "Decision"),
      h("th", { title: "From reading that sample to firing, measured on the board" }, "On the board"),
      h("th", { title: "From firing to the message reaching this PC" }, "Link")));
    const rows = R.pyroTiming.map((p) => h("tr", null,
      h("td", null, p.label.replace(/ deployment$/, "")), h("td", null, ms(p.decisionMs)), h("td", null, us(p.processingUs)), h("td", null, p.linkMs != null ? `${p.linkMs.toFixed(0)} ms` : "–")));
    const sec = h("div", { class: "res-sec flush" }, h("h4", null, "Pyro timing"), h("table", { class: "data pt-table" }, head, h("tbody", null, rows)));
    if (R.pyroTiming.some((p) => !p.fromBoard)) sec.append(h("p", { class: "note", style: { padding: "0 12px" } }, "Update the MockingbirdHIL library on the board to get its own timing; without it, the decision time includes the serial link."));
    box.append(sec);
  }
  if (R.detections?.length) box.append(h("div", { class: "res-sec" }, h("h4", null, "What the flight computer reported"), h("div", { class: "kv" }, R.detections.flatMap((d) => [h("span", { class: "k" }, d.label), h("span", null, d.value)]))));
  const o = R.outcome || {};
  box.append(h("div", { class: "res-sec" }, h("h4", null, o.replay ? `How the replayed flight went (${o.replay})` : "How the simulated flight went"), h("div", { class: "kv" },
    h("span", { class: "k" }, "Apogee"), h("span", null, Number.isFinite(o.apogee) ? fmtA(o.apogee) : "–"),
    h("span", { class: "k" }, "Top speed"), h("span", null, Number.isFinite(o.maxVelocity) ? fmtV(o.maxVelocity) : "–"),
    h("span", { class: "k" }, "Landing speed"), h("span", { class: o.hardLanding ? "bad-text" : "" }, Number.isFinite(o.landingSpeed) ? `${fmtV(o.landingSpeed)}${o.landingProjected ? " (projected)" : ""}${o.hardLanding ? ", too fast" : ""}` : "–"),
    h("span", { class: "k" }, "Ended"), h("span", null, R.endReason || "–"),
    h("span", { class: "k" }, "Samples sent"), h("span", null, fmt(R.samples || 0)),
    ...(R.boardStats ? [h("span", { class: "k" }, "Board received"), h("span", { class: R.boardStats.bad ? "bad-text" : "" }, `${fmt(R.boardStats.good)}${R.boardStats.bad ? `, ${fmt(R.boardStats.bad)} damaged` : ", none damaged"}`)] : []))));
  const bs = R.boardStats;
  if (bs && (bs.bad > 0 || bs.good < 0.97 * (R.samples || 0))) box.append(h("div", { class: "res-sec" }, h("div", { class: "safety" }, `The board missed ${fmt(Math.max(0, (R.samples || 0) - bs.good))} samples. Call hil.poll() more often (long SD card writes block it), lower the sample rate, or drop fields you don't use.`)));
  if (R.faults?.length) box.append(h("div", { class: "res-sec" }, h("h4", null, "Faults injected"), h("ul", { class: "plain" }, R.faults.map((f) => h("li", null, describeFault(f, (k) => R.rocketProfile?.stages?.[k]?.name || `stage ${k + 1}`))))));
  if (R.dir) box.append(h("div", { class: "res-sec" }, h("h4", null, "Saved"),
    h("div", { class: "note", style: { wordBreak: "break-word" } }, `Documents\\Aviary\\Mockingbird Runs\\${R.dir}`),
    h("div", { class: "row", style: { marginTop: "6px" } }, h("button", { class: "btn small", onclick: () => host.reveal("mockingbird", `${R.dir}/flight.csv`).catch((e) => toast(e.message, "fault")) }, "Show in folder"),
      h("span", { class: "note" }, "Heron lists it under Mockingbird runs."))));
}

function suiteTable(s) {
  const passed = s.results.filter((r) => r.verdict === "pass").length;
  return h("div", { class: "res-sec flush suite" },
    h("h4", null, `${passed} of ${s.results.length} tests passed · ${s.rocket}`),
    h("table", { class: "data" }, h("tbody", null, s.results.map((r) => h("tr", { class: "clickable", onclick: () => { const hr = set.history.find((x) => x.dir === r.dir); if (hr) openPast(hr); } },
      h("td", null, h("span", { class: "badge " + r.verdict }, r.verdict === "pass" ? "PASS" : r.verdict === "fail" ? "FAIL" : "STOP")),
      h("td", null, r.test), h("td", { class: "muted" }, r.firstFail))))));
}

// ------------------------------------------------------------------ periodic
function idleTick() {
  // keep asking a newly connected board who it is
  if (M.link?.type === "serial" && !M.hello && !M.run && performance.now() - M.lastPing > 2500 && performance.now() - M.connectedAt > 1500) {
    M.lastPing = performance.now();
    sendLine(withCS("MBC,PING"));
  }
  renderPill();
  if (M.run) {
    const el = Math.max(0.5, (performance.now() - M.runStart) / 1000);
    ui.live.textContent = `${fmt(M.run.sent / el, 0)} samples/s · ${fmt(M.txBytes / el / 1000, 1)} kB/s · ${fmt(M.rxDuringRun)} lines back${M.fcState ? ` · board says ${M.fcState}` : ""}`;
  } else ui.live.textContent = "";
  renderSide(false);
}

main().catch((e) => { document.body.append(h("pre", { style: { padding: "20px" } }, "Mockingbird failed to start: " + e.stack)); });
