// Heron — flight data analyzer for any rocket's logs.
import { marks, h, clear, toast, modal, numField, selectField, seg, tabs, download, setTheme, appHeader, readFileText, pickFile, dropTarget, safeName, stamp } from "/shared/js/ui.js";
import { host, connectEvents, loadSettings } from "/shared/js/host.js";
import { display, fmt, G0 } from "/shared/js/units.js";
import { TimeChart, ChartGroup } from "/shared/js/chart.js";
import { FlightAnimation } from "/shared/js/flightviz.js";
import { gpsTrack } from "/shared/js/flight3d.js";
import { sensorHealth } from "/shared/js/health.js";
import { parseLogText, guessMapping, buildFlight, toCSV } from "/shared/js/flightlog.js";
import { analyzeFlight, estimateCd, compare, median } from "/shared/js/analysis.js";
import { ROLES, ROLE_BY_ID, UNIT_CHOICES } from "/shared/js/fields.js";
import { simulate, FlightSim, rng, PHASE_LABEL } from "/shared/js/sim.js";
import { loadRockets, saveRockets } from "/shared/js/rockets.js";

const DEFAULTS = { theme: "day", units: "imperial", mappings: {}, sampleRates: {}, last: null, site: { elevation: 0, windSpeed: 0 }, predictions: {}, drag: {} };
const AREAS = [["owl", "Owl recordings"], ["mockingbird", "Mockingbird runs"], ["heron", "Imported logs"]];
const CMP_COLORS = ["--d-alt", "--d-acc", "--d-vel", "--d-tmp", "--d-aux1", "--d-aux2", "--d-prs"];
const BAND = {
  boost: { color: "--orange", alpha: 0.13, label: "Boost" }, coast: { color: "--graphite", alpha: 0.06, label: "Coast" },
  descent: { color: "--d-acc", alpha: 0.06, label: "Free fall" }, drogue: { color: "--d-alt", alpha: 0.07, label: "Drogue" },
  main: { color: "--d-vel", alpha: 0.08, label: "Main" }, landed: { color: "--graphite", alpha: 0.04, label: "Landed" },
};

let set, D;
const H = { lib: {}, current: null, compare: new Set(), tab: "overview", cache: new Map(), store: null };
const ui = {};

async function main() {
  set = await loadSettings(DEFAULTS);
  D = display(set.units);
  setTheme(set.theme);
  connectEvents();
  H.store = await loadRockets(host);
  build();
  await refreshLibrary();
  if (set.last) { const [area, ...rest] = set.last.split(":"); const path = rest.join(":"); if (H.lib[area]?.some((f) => f.path === path)) openFromLibrary(area, path).catch(() => {}); }
}

// ------------------------------------------------------------------ layout
function build() {
  const app = document.getElementById("app");
  ui.sub = h("span");
  const tools = [
    seg([["imperial", "ft"], ["metric", "m"]], set.units, (v) => { set.units = v; set.save(); D = display(v); render(); }),
    seg([["day", "Day"], ["night", "Night"]], set.theme, (v) => { set.theme = v; set.save(); setTheme(v); }),
    h("button", { class: "btn primary", onclick: openLocal }, "Open log…"),
  ];
  const header = appHeader("heron", "Heron", ui.sub, tools);
  const dz = h("div", { class: "dropzone" }, h("b", null, "Drop a flight log here"), h("div", null, "CSV or text from any flight computer, or an OpenRocket export"));
  dropTarget(dz, (files) => files.forEach(importFile));
  ui.libList = h("div", { class: "lib-list" });
  const lib = h("aside", { class: "lib", "aria-label": "Flight library" }, dz, ui.libList);
  ui.main = h("section", { class: "main" });
  dropTarget(ui.main, (files) => files.forEach(importFile));
  app.append(header, h("main", { class: "heron app-body" }, lib, ui.main));
  render();
}

async function refreshLibrary() {
  for (const [area] of AREAS) {
    try {
      const r = await host.list(area);
      // flight logs only: not Owl's raw radio log or Mockingbird's serial console
      H.lib[area] = r.files.filter((f) => !f.dir && /\.(csv|txt|tsv|log|dat)$/i.test(f.name) && !/(^|\/)(raw|console)\.txt$/i.test(f.path) && !/(^|\/)montecarlo\.csv$/i.test(f.path) && !/^\./.test(f.name));
    } catch { H.lib[area] = []; }
  }
  renderLibrary();
}

function niceName(area, path) {
  if (area === "owl" || area === "mockingbird") {
    const dir = path.split("/")[0];
    const m = dir.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d)-(\d\d)-\d\d\s*(.*)$/);
    if (!m) return dir;
    // Mockingbird folders are "<time> <rocket> - <test>": the test name matters most
    const parts = area === "mockingbird" ? m[6].split(" - ") : [];
    if (parts.length >= 2) return `${parts.slice(1).join(" - ")} (${parts[0]})`;
    return `${m[6] || "Flight"}, ${m[4]}:${m[5]}`;
  }
  return path.split("/").pop();
}

function renderLibrary() {
  clear(ui.libList);
  for (const [area, label] of AREAS) {
    const files = H.lib[area] || [];
    ui.libList.append(h("div", { class: "lib-group" }, label, area === "heron" ? h("button", { class: "btn ghost small", title: "Show this folder in File Explorer", onclick: () => host.reveal(area).catch((e) => toast(e.message, "fault")) }, "Folder") : null));
    if (!files.length) ui.libList.append(h("div", { class: "lib-empty" }, area === "owl" ? "Flights recorded in Owl appear here." : area === "mockingbird" ? "Test runs saved in Mockingbird appear here." : "Logs you open are kept here."));
    for (const f of files.slice(0, 80)) {
      const key = `${area}:${f.path}`;
      const cb = h("input", { type: "checkbox", title: "Include in Compare", checked: H.compare.has(key), onclick: (e) => e.stopPropagation(), onchange: () => { cb.checked ? H.compare.add(key) : H.compare.delete(key); if (H.tab === "compare") renderTab(); } });
      const d = new Date(f.modified);
      ui.libList.append(h("div", { class: "lib-item" + (H.current?.key === key ? " on" : ""), title: f.path, onclick: () => openFromLibrary(area, f.path) },
        cb, h("div", { class: "nm" }, niceName(area, f.path)),
        h("div", { class: "dt" }, `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)));
    }
  }
}

// ------------------------------------------------------------------ opening
async function openLocal() {
  const f = await pickFile(".csv,.txt,.tsv,.log,.dat,text/plain");
  if (f) importFile(f);
}

async function importFile(file) {
  try {
    const text = await readFileText(file);
    parseLogText(text, file.name); // validate before saving
    let path = safeName(file.name.replace(/\.[^.]+$/, "")) + (file.name.match(/\.[^.]+$/)?.[0] || ".csv");
    const r = await host.write("heron", path, text, true);
    await refreshLibrary();
    openText(text, { key: `heron:${r.path}`, area: "heron", path: r.path, name: file.name });
  } catch (e) { toast(`Couldn't open ${file.name}: ${e.message}`, "fault", 8000); }
}

async function openFromLibrary(area, path) {
  try {
    const text = await host.read(area, path);
    openText(text, { key: `${area}:${path}`, area, path, name: niceName(area, path) });
  } catch (e) { toast(e.message, "fault"); }
}

function loadFlight(text, meta) {
  const parsed = parseLogText(text, meta.name);
  let mapping = guessMapping(parsed);
  const saved = set.mappings[meta.key];
  if (saved) mapping = mapping.map((m) => { const s = saved.find((x) => x.name === m.name); return s ? { ...m, role: s.role, unit: s.unit, scale: s.scale ?? 1, guessed: false } : m; });
  const flight = buildFlight(parsed, mapping, { sampleRate: set.sampleRates[meta.key] });
  const res = analyzeFlight(flight);
  return { ...meta, text, parsed, mapping, flight, res };
}

function openText(text, meta) {
  try {
    H.current = loadFlight(text, meta);
  } catch (e) {
    H.current = null;
    toast(`Couldn't analyse ${meta.name}: ${e.message}`, "fault", 9000);
    try { const parsed = parseLogText(text, meta.name); H.current = { ...meta, text, parsed, mapping: guessMapping(parsed), failed: e.message }; } catch { /* */ }
  }
  H.cache.set(meta.key, H.current);
  set.last = meta.key; set.save();
  const pk = set.predictions[meta.key];
  if (H.current && !H.current.failed && pk) runPrediction(pk, true);
  else render();
  renderLibrary();
}

// ------------------------------------------------------------------ rendering
function render() {
  clear(ui.main);
  const c = H.current;
  if (!c) { ui.sub.textContent = ""; renderEmpty(); return; }
  ui.sub.textContent = c.name;
  if (c.failed) {
    ui.main.append(h("div", { class: "empty" }, h("h3", null, "Heron couldn't analyse this log yet"), h("p", null, c.failed), h("p", null, "Usually a column just needs labelling. Open Columns and say which column is time, altitude or pressure, and acceleration."), h("button", { class: "btn primary", onclick: openMapping }, "Columns…")));
    return;
  }
  const r = c.res;
  const dur = c.flight.t[c.flight.t.length - 1];
  ui.main.append(h("div", { class: "flight-head" },
    h("h1", null, c.name),
    h("span", { class: "meta" }, `${fmt(c.flight.rows)} samples at ${fmt(r.rate, r.rate < 20 ? 1 : 0)} per second, ${fmt(dur, 0)} s long. Altitude from ${r.altSource}.`),
    h("div", { class: "spacer" }),
    h("div", { class: "row" },
      h("button", { class: "btn small", onclick: openMapping }, "Columns…"),
      h("button", { class: "btn small", onclick: exportMenu }, "Export…"),
      h("button", { class: "btn small", onclick: () => printReport().catch((e) => toast("Couldn't make the report: " + e.message, "fault")) }, "Print report"))));
  if (r.notFlight) {
    const nf = r.notFlight;
    ui.main.append(h("div", { class: "verdict", style: { margin: "0 16px 10px" } },
      h("b", null, "This log doesn't show a flight. "),
      `The biggest change is a ${D.fmtAlt(nf.h)} ${D.altUnit} jump at ${fmt(nf.t, 1)} s into the log that rose and fell back in ${fmt(nf.dur, 2)} s. Nothing can fly that fast: a real ${D.fmtAlt(nf.h)} ${D.altUnit} hop takes about ${fmt(nf.ballistic, 1)} s. It's a pressure blast on the barometer, from a CATO or ejection charge nearby or a gust on the vent holes. The numbers below aren't a flight.`));
  }
  ui.main.append(statStrip());
  ui.tabs = tabs([["overview", "Overview"], ["animation", "Animation"], ["model", "Model vs flight"], ["compare", "Compare flights"], ["data", "Data and notes"]], H.tab, (v) => { H.tab = v; renderTab(); });
  ui.tabBody = h("div", { class: "tab-body" });
  ui.main.append(ui.tabs, ui.tabBody);
  renderTab();
}

function renderEmpty() {
  const zone = h("div", { class: "dropzone", style: { maxWidth: "640px", padding: "28px" } },
    h("h2", { style: { margin: "0 0 8px", fontSize: "22px", color: "var(--ink)" } }, "Open a flight log"),
    h("p", { style: { margin: "0 0 10px" } }, "Heron reads logs from any flight computer or simulator: CSV, tab or space separated text, OpenRocket exports, Owl recordings and Mockingbird runs. It works out liftoff, burnout, apogee, deployments and landing, combines barometer and accelerometer data, and compares the flight with a prediction."),
    h("p", { style: { margin: "0 0 16px" } }, "Column names like Time, Altitude (ft), Pressure and Accel Z are recognised automatically; anything else can be labelled in a few clicks."),
    h("div", { class: "row" }, h("button", { class: "btn primary", onclick: openLocal }, "Open log…"), h("button", { class: "btn", onclick: makeSample }, "Try a sample flight")));
  dropTarget(zone, (files) => files.forEach(importFile));
  ui.main.append(h("div", { style: { padding: "28px" } }, zone));
}

function statStrip() {
  const r = H.current.res, st = r.stats, p = H.current.pred;
  const items = [];
  const delta = (a, b) => {
    if (!p || !Number.isFinite(a) || !Number.isFinite(b) || !b) return null;
    const d = ((a - b) / b) * 100;
    return h("div", { class: "d " + (Math.abs(d) < 3 ? "muted" : d > 0 ? "delta-up" : "delta-down") }, `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}% vs model`);
  };
  const S = (k, v, u, d) => items.push(h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v, u ? h("small", null, u) : ""), d || ""));
  S("Apogee", D.fmtAlt(st.apogee), D.altUnit, delta(st.apogee, p?.summary.apogee));
  S("Time to apogee", fmt(st.timeToApogee, 1), "s", delta(st.timeToApogee, p?.summary.apogeeTime));
  S("Top speed", D.fmtVel(st.maxVelocity), D.velUnit, delta(st.maxVelocity, p?.summary.maxVelocity) || h("div", { class: "d muted" }, `Mach ${fmt(st.maxMach, 2)}`));
  S("Peak acceleration", Number.isFinite(st.maxAccelG) ? fmt(st.maxAccelG, 1) : "–", "g", r.f ? null : h("div", { class: "d muted" }, "from barometer"));
  S(r.burns.length > 1 ? `Burns (${r.burns.length})` : "Burnout", r.burns.map((b) => fmt(b.end - r.tLift, 2)).join(", "), "s");
  const rates = st.descentRates;
  S(rates.length > 1 ? "Descent rates" : "Descent rate", rates.length ? rates.map((x) => D.fmtVel(x)).join(" / ") : "–", D.velUnit);
  S("Landing speed", st.landingSpeed != null ? D.fmtVel(st.landingSpeed, 1) : "–", D.velUnit);
  S("Flight time", st.flightTime != null ? fmt(st.flightTime, 1) : "–", "s");
  if (st.drift != null) S("Drift", D.fmtDist(st.drift), "");
  const hl = health(), bad = hl.filter((x) => x.level !== "ok").length;
  items.push(h("button", { class: "stat stat-link", title: "Open the sensor health checks", onclick: () => { H.tab = "data"; renderTab(); } },
    h("div", { class: "k" }, "Sensor health"), h("div", { class: "v" }, bad ? String(bad) : "OK", bad ? h("small", null, "to check") : ""),
    h("div", { class: "d muted" }, `${hl.length} checks`)));
  return h("div", { class: "stat-strip", role: "list", "aria-label": "Key numbers" }, items);
}

// ------------------------------------------------------------------ report
// A one-page report for printing or saving as a PDF. Charts are drawn at a
// fixed print size and placed as pictures, so nothing is squeezed to fit.
async function printReport() {
  const c = H.current, r = c.res, st = r.stats, L = r.tLift;
  document.getElementById("print-report")?.remove();
  const root = document.documentElement, theme = root.dataset.theme;
  root.dataset.theme = "day";                       // paper is white
  const stage = h("div", { style: { position: "fixed", left: "-20000px", top: "0", width: "800px" } });
  document.body.append(stage);
  const pics = [];
  try {
    const sizes = [210, 140, 140];
    for (const [i, s] of overviewSpecs().entries()) {
      const box = h("div", { style: { width: "800px", height: `${sizes[i] || 140}px`, position: "relative" } });
      stage.append(box);
      const ch = new TimeChart(box, { xLabel: i === (r.f ? 2 : 1) ? "Time from liftoff (s)" : "", tooltip: false, dpr: 3, ...s.opts });
      for (const ser of s.series) ch.addSeries({ ...ser, visible: ser.visible !== false });
      if (s.bands) ch.setBands(s.bands);
      if (s.markers) ch.setMarkers(s.markers);
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      ch.redraw();
      pics.push({ title: s.title, src: ch.toPNG() });
      ch.destroy();
    }
  } finally {
    stage.remove();
    root.dataset.theme = theme;
  }
  const num = (k, v, u) => h("div", { class: "pr-num" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v, u ? h("small", null, " " + u) : ""));
  const rates = st.descentRates;
  const nums = [
    num("Apogee", D.fmtAlt(st.apogee), D.altUnit), num("Time to apogee", fmt(st.timeToApogee, 1), "s"),
    num("Top speed", D.fmtVel(st.maxVelocity), `${D.velUnit} · Mach ${fmt(st.maxMach, 2)}`),
    num("Peak acceleration", Number.isFinite(st.maxAccelG) ? fmt(st.maxAccelG, 1) : "–", "g"),
    num(r.burns.length > 1 ? "Burnouts" : "Burnout", r.burns.map((b) => fmt(b.end - L, 2)).join(", "), "s"),
    num(rates.length > 1 ? "Descent rates" : "Descent rate", rates.length ? rates.map((x) => D.fmtVel(x)).join(" / ") : "–", D.velUnit),
    num("Landing speed", st.landingSpeed != null ? D.fmtVel(st.landingSpeed, 1) : "–", D.velUnit),
    num("Flight time", st.flightTime != null ? fmt(st.flightTime, 1) : "–", "s"),
  ];
  if (st.drift != null) nums.push(num("Drift", D.fmtDist(st.drift), ""));
  const ev = eventList(r).filter((e) => e.kind !== "log");
  const hl = health();
  const logo = h("span", { class: "pr-logo", html: marks.heron });
  const ver = await host.info().then((i) => i.version).catch(() => "");
  const rep = h("div", { id: "print-report" },
    h("header", null, logo, h("div", null, h("div", { class: "pr-kicker" }, "Flight report"), h("h1", null, c.area ? niceName(c.area, c.path) : c.name || "Flight")),
      h("div", { class: "pr-meta" }, h("div", null, `Analysed ${new Date().toLocaleDateString()}`), h("div", null, `${fmt(c.flight.rows)} samples at ${fmt(1 / (r.dtMed || 1 / r.rate), 0)}/s · altitude from ${r.altSource}`))),
    r.notFlight ? h("div", { class: "pr-verdict" }, "This log doesn't show a flight: the biggest change rose and fell faster than anything can fly. The numbers below aren't a flight.") : "",
    h("div", { class: "pr-nums" }, nums),
    h("div", { class: "pr-charts" }, pics.map((p) => h("figure", null, h("figcaption", null, p.title), h("img", { src: p.src, alt: p.title })))),
    h("div", { class: "pr-cols" },
      h("section", null, h("h2", null, "Events"), h("table", null, h("tbody", null, ev.map((e) => h("tr", null, h("td", { class: "t" }, `${e.t >= 0 ? "T+" : "T−"}${Math.abs(e.t).toFixed(2)} s`), h("td", null, e.label)))))),
      h("section", null, h("h2", null, "Sensor health"), h("ul", { class: "pr-health" }, hl.map((x) => h("li", { class: x.level }, h("b", null, x.title), " ", h("span", null, x.detail)))))),
    h("footer", null, h("span", null, `Heron · Aviary ${ver}`.trim()), h("span", null, c.name || "")));
  document.body.append(rep);
  await Promise.all([...rep.querySelectorAll("img")].map((im) => (im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; }))));
  window.print();
}

function health() {
  try { return sensorHealth(H.current.flight, H.current.res, D); } catch (e) { console.warn(e); return []; }
}
function healthList(list = health()) {
  if (!list.length) return h("p", { class: "note", style: { margin: 0 } }, "No sensor checks apply to this log.");
  return h("ul", { class: "health" }, list.map((x) => h("li", { class: x.level }, h("b", null, x.title), h("span", null, x.detail))));
}

function renderTab() {
  ui.tabs?.set(H.tab);
  clear(ui.tabBody);
  ({ overview: tabOverview, animation: tabAnimation, model: tabModel, compare: tabCompare, data: tabData })[H.tab]();
}

function phaseBands(r, shift) {
  return r.phases.filter((p) => BAND[p.phase]).map((p) => ({ x0: p.t0 - shift, x1: p.t1 - shift, ...BAND[p.phase] }));
}
function eventList(r) {
  const ev = [];
  const L = r.tLift;
  ev.push({ t: 0, label: "Liftoff", kind: "hot" });
  r.burns.forEach((b, i) => { if (i > 0) ev.push({ t: b.start - L, label: r.burns.length > 1 ? `Ignition ${i + 1}` : "Ignition" }); ev.push({ t: b.end - L, label: r.burns.length > 1 ? `Burnout ${i + 1}` : "Burnout" }); });
  ev.push({ t: r.apogee.t - L, label: `Apogee ${D.fmtAlt(r.apogee.h)} ${D.altUnit}`, kind: "hot" });
  for (const d of r.deployments) ev.push({ t: d.t - L, label: `Descent ${D.fmtVel(d.before)} → ${D.fmtVel(d.after)} ${D.velUnit}`, kind: "hot" });
  for (const s of r.shocks) ev.push({ t: s.t - L, label: `Shock ${fmt(s.g, 0)} g` });
  if (r.landed) ev.push({ t: r.t[r.iland] - L, label: "Landing", kind: "good" });
  for (const e of r.logEvents) ev.push({ t: e.t - L, label: e.label, kind: "log" });
  return ev.sort((a, b) => a.t - b.t);
}

function makeCharts(container, specs) {
  const group = new ChartGroup();
  const charts = [];
  const stack = h("div", { class: "stack", style: { gridTemplateRows: specs.map((s) => `${s.weight || 1}fr`).join(" ") } });
  container.append(stack);
  for (const s of specs) {
    const body = h("div", { class: "panel-body flush" });
    stack.append(h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, s.title), s.hint ? h("span", { class: "hint" }, s.hint) : "", h("div", { class: "spacer" }),
      h("button", { class: "btn ghost small no-print", title: "Save this chart as a picture", onclick: () => { const a = h("a", { href: chart.toPNG(), download: `${safeName(H.current.name)} ${s.title}.png` }); a.click(); } }, "PNG")), body));
    const chart = new TimeChart(body, { group, xLabel: "Time from liftoff (s)", ...s.opts });
    for (const ser of s.series) if (ser.x && ser.x.length) chart.addSeries(ser);
    if (s.bands) chart.setBands(s.bands);
    if (s.markers) chart.setMarkers(s.markers);
    charts.push(chart);
  }
  return charts;
}

function overviewSpecs() {
  const c = H.current, r = c.res, L = r.tLift;
  const t = Float64Array.from(r.t, (x) => x - L);
  const bands = phaseBands(r, L);
  const markers = eventList(r).filter((e) => e.kind !== "log").map((e) => ({ x: e.t, label: e.label, color: e.kind === "good" ? "--go" : "--orange" }));
  const conv = (arr, f) => Float64Array.from(arr, f);
  const pred = c.pred?.series;
  const specs = [
    { title: "Altitude", hint: "Drag to zoom, double-click to reset", weight: 1.25, bands, markers: markers.filter((m) => !m.label.startsWith("Shock")), opts: { yLabel: `Altitude (${D.altUnit})`, yIncludeZero: true },
      series: [
        { id: "raw", label: "Measured", color: "--faint", x: t, y: conv(r.agl, D.alt), unit: D.altUnit, digits: 0, width: 1 },
        { id: "h", label: "Best estimate", color: "--d-alt", x: t, y: conv(r.h, D.alt), unit: D.altUnit, digits: 1, width: 2 },
        pred ? { id: "p", label: "Model", color: "--d-pred", x: pred.t, y: conv(pred.h, D.alt), unit: D.altUnit, digits: 0, dash: [6, 4] } : {},
        c.flight.series.gps_alt ? { id: "g", label: "GPS", color: "--d-tmp", x: t, y: conv(c.flight.series.gps_alt, (v) => D.alt(v - (median(c.flight.series.gps_alt.slice(Math.max(0, r.il - 50), r.il)) || 0))), unit: D.altUnit, digits: 0, width: 1 } : {},
      ] },
    { title: "Vertical speed", bands, opts: { yLabel: `Speed (${D.velUnit})`, yIncludeZero: true },
      series: [
        { id: "vb", label: "From altitude", color: "--faint", x: t, y: conv(r.velBaro, D.vel), unit: D.velUnit, digits: 0, width: 1, visible: false },
        { id: "v", label: "Best estimate", color: "--d-vel", x: t, y: conv(r.v, D.vel), unit: D.velUnit, digits: 1, width: 2 },
        pred ? { id: "pv", label: "Model", color: "--d-pred", x: pred.t, y: conv(pred.v, D.vel), unit: D.velUnit, digits: 0, dash: [6, 4] } : {},
      ] },
  ];
  if (r.f) specs.push({ title: "Acceleration", hint: r.accAxis === "acc_kin" ? "from file" : `accelerometer axis: ${ROLE_BY_ID[r.accAxis]?.label || r.accAxis}`, bands, markers: markers.filter((m) => m.label.startsWith("Shock") || m.label === "Liftoff"), opts: { yLabel: "Acceleration (g)" },
    series: [{ id: "f", label: "Measured (along the rocket)", color: "--d-acc", x: t, y: conv(r.f, (v) => v / G0), unit: "g", digits: 2, width: 1.25 }] });
  return specs.map((s) => ({ ...s, series: s.series.filter((x) => x.id) }));
}

function tabOverview() {
  const c = H.current, r = c.res;
  const specs = overviewSpecs();
  const wrap = h("div", { style: { display: "grid", gridTemplateColumns: "minmax(0,1fr) 300px", gap: "10px", height: "100%", minHeight: "540px" } });
  const left = h("div", { style: { minHeight: 0 } });
  const ev = eventList(r);
  const evPanel = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Flight events")),
    h("div", { class: "panel-body flush" }, h("ul", { class: "events" }, ev.map((e) => h("li", { class: e.kind === "log" ? "" : e.kind || "" }, h("span", { class: "t" }, `${e.t >= 0 ? "T+" : "T−"}${Math.abs(e.t).toFixed(2)}`), h("span", { class: "what", style: e.kind === "log" ? { fontWeight: 400 } : {} }, e.label), h("span"))))),
    h("div", { style: { padding: "10px 12px", borderTop: "1px solid var(--rule)" } }, h("div", { class: "legend-key" }, Object.entries(BAND).filter(([k]) => r.phases.some((p) => p.phase === k)).map(([, b]) => h("span", null, h("i", { style: { background: `color-mix(in srgb, var(${b.color}) ${Math.round(b.alpha * 300)}%, transparent)` } }), b.label)))));
  wrap.append(left, evPanel);
  ui.tabBody.append(wrap);
  makeCharts(left, specs);
}

// ------------------------------------------------------------------ model vs flight
function siteFromFlight() {
  const r = H.current.res;
  const p = H.current.flight.series.pressure;
  const pPad = p ? median(p.slice(Math.max(0, r.il - Math.round(r.rate * 3)), Math.max(1, r.il - 2))) : null;
  return { elevation: set.site.elevation || 0, tempC: r.padTempC, pressurePa: pPad && pPad > 30000 ? pPad : undefined, windSpeed: 0 };
}

async function runPrediction(spec, silent = false) {
  const c = H.current;
  try {
    if (spec.kind === "sim") {
      const rocket = H.store.rockets.find((x) => x.id === spec.rocketId);
      if (!rocket) throw new Error("That rocket profile no longer exists.");
      const out = simulate(rocket, { ...siteFromFlight(), ...spec.site }, { rate: 50 });
      const lift = out.events.find((e) => e.type === "liftoff")?.t ?? 0;
      c.pred = { ...spec, name: rocket.name, series: { t: out.series.t.map((x) => x - lift), h: out.series.h, v: out.series.v }, summary: out.summary };
    } else if (spec.kind === "file") {
      const text = await host.read(spec.area, spec.path);
      const pf = loadFlight(text, { key: `${spec.area}:${spec.path}`, name: spec.path });
      const pr = pf.res;
      const t = Array.from(pr.t, (x) => x - pr.tLift);
      c.pred = { ...spec, name: spec.path.split("/").pop(), series: { t, h: Array.from(pr.h), v: Array.from(pr.v) }, summary: { apogee: pr.stats.apogee, apogeeTime: pr.stats.timeToApogee, maxVelocity: pr.stats.maxVelocity } };
    }
    set.predictions[c.key] = spec; set.save();
  } catch (e) { if (!silent) toast(e.message, "fault"); c.pred = null; }
  render();
}

// ------------------------------------------------------------------ animation
// Heron's descent phases are labelled from the descent rate; the animation
// shows a drogue for any steady descent slower than free fall.
function animPhases(r, L) {
  return r.phases.map((p) => {
    let phase = p.phase;
    if (phase === "descent") {
      const i0 = r.t.findIndex((x) => x >= p.t0), i1 = r.t.findIndex((x) => x >= p.t1);
      const vs = Array.from(r.v.slice(Math.max(0, i0), i1 > i0 ? i1 : undefined)).filter(Number.isFinite).map((v) => -v);
      if (vs.length && median(vs) < 40) phase = "drogue";
    }
    return { phase, t0: p.t0 - L, t1: p.t1 - L };
  });
}

function tabAnimation() {
  const c = H.current, r = c.res, L = r.tLift;
  const box = h("div", { class: "panel anim-panel" },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Flight animation"),
      h("span", { class: "hint" }, "Replays the best-estimate altitude. Auto speed plays the burn, apogee and deployments in real time and speeds up in between.")),
    h("div", { class: "panel-body flush" }));
  ui.tabBody.append(box);
  const anim = new FlightAnimation(box.lastChild, { units: D, name: (c.name || "Flight").replace(/\.[a-z0-9]{1,4}$/i, "") });
  // logs often keep recording for minutes on the ground; stop a few seconds after landing
  const end = r.landed && Number.isFinite(r.t[r.iland]) ? r.t[r.iland] + 6 : Infinity;
  const n = Math.max(2, r.t.findIndex((x) => x > end) + 1 || r.t.length);
  // GPS gives the 3D view; without it the animation stays 2D
  const S = c.flight.series;
  const trk = S.lat && S.lon ? gpsTrack(Array.from(r.t), S.lat, S.lon, r.tLift) : null;
  anim.setData({
    t: Array.from(r.t.slice(0, n), (x) => x - L), h: Array.from(r.h.slice(0, n)), v: Array.from(r.v.slice(0, n)),
    east: trk ? Array.from(trk.east.slice(0, n)) : null, north: trk ? Array.from(trk.north.slice(0, n)) : null,
    geo: trk ? { lat: trk.lat0, lon: trk.lon0 } : null,
    phases: animPhases(r, L),
    events: eventList(r).filter((e) => e.kind !== "log" && !e.label.startsWith("Shock") && e.t <= end - L),
  });
  if (trk && H.anim3d) anim.setView("3d");
  anim.viewSeg.addEventListener("click", () => { H.anim3d = anim.view === "3d"; });
  anim.play();
}

function tabModel() {
  const c = H.current, r = c.res;
  const box = ui.tabBody;
  const spec = set.predictions[c.key] || { kind: "sim", rocketId: H.store.selected, site: {} };
  // ---- choose prediction ----
  const rocketSel = selectField("Rocket profile", spec.rocketId || H.store.selected, H.store.rockets.map((x) => [x.id, x.name]), (v) => { spec.rocketId = v; });
  const elev = numField("Launch site elevation", Math.round(D.alt(spec.site?.elevation ?? set.site.elevation ?? 0)), D.altUnit, (v) => { spec.site = { ...(spec.site || {}), elevation: D.fromAlt(v || 0) }; set.site.elevation = D.fromAlt(v || 0); set.save(); });
  const files = [];
  for (const [area] of AREAS) for (const f of H.lib[area] || []) if (`${area}:${f.path}` !== c.key) files.push([`${area}|${f.path}`, `${niceName(area, f.path)}`]);
  const fileSel = selectField("Or a predicted flight file", "", [["", "Choose a file…"], ...files], () => {});
  const chooser = h("div", { class: "panel", style: { marginBottom: "10px" } },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Prediction"), h("span", { class: "hint" }, c.pred ? `Showing: ${c.pred.kind === "sim" ? "simulation of " + c.pred.name : c.pred.name}` : "Simulate a rocket profile or load an OpenRocket export to compare")),
    h("div", { class: "panel-body" }, h("div", { class: "grid-form", style: { alignItems: "end" } },
      rocketSel, elev,
      h("button", { class: "btn primary", onclick: () => runPrediction({ kind: "sim", rocketId: rocketSel.input.value, site: spec.site || {} }) }, "Simulate"),
      fileSel,
      h("button", { class: "btn", onclick: () => { const v = fileSel.input.value; if (!v) { toast("Pick a file first, or drop an OpenRocket CSV export onto Heron.", "fault"); return; } const [area, path] = v.split("|"); runPrediction({ kind: "file", area, path }); } }, "Use file"),
      c.pred ? h("button", { class: "btn ghost", onclick: () => { delete set.predictions[c.key]; set.save(); c.pred = null; render(); } }, "Clear") : ""),
      h("p", { class: "note", style: { marginBottom: 0 } }, "Simulations use the rocket profiles shared with Mockingbird. Ground pressure and temperature come from this log when it has them.")));
  box.append(chooser);

  // ---- comparison ----
  const two = h("div", { class: "two" });
  box.append(two);
  const left = h("div", { style: { minHeight: "460px", display: "flex", flexDirection: "column" } });
  const right = h("div", { class: "col", style: { gap: "10px" } });
  two.append(left, right);
  if (c.pred) {
    const cmp = compare(r, c.pred.series);
    const specs = [
      { title: "Altitude, flight and model", weight: 1.2, opts: { yLabel: `Altitude (${D.altUnit})`, yIncludeZero: true }, series: [
        { id: "a", label: "Flight", color: "--d-alt", x: cmp.t, y: cmp.t.map((_, i) => D.alt(cmp.ph[i] + cmp.dh[i])), unit: D.altUnit, digits: 0, width: 2 },
        { id: "m", label: "Model", color: "--d-pred", x: cmp.t, y: cmp.ph.map(D.alt), unit: D.altUnit, digits: 0, dash: [6, 4] }] },
      { title: "Difference (flight minus model)", opts: { yLabel: D.altUnit, y2Label: D.velUnit, yIncludeZero: true, y2IncludeZero: true }, series: [
        { id: "dh", label: "Altitude", color: "--d-alt", x: cmp.t, y: cmp.dh.map(D.alt), unit: D.altUnit, digits: 0 },
        { id: "dv", label: "Speed", color: "--d-vel", x: cmp.t, y: cmp.dv.map(D.vel), unit: D.velUnit, digits: 1, axis: "y2" }] },
    ];
    makeCharts(left, specs);
    const row = (k, a, b, f, u) => { const d = b ? ((a - b) / b) * 100 : NaN; return h("tr", null, h("td", null, k), h("td", { class: "r" }, f(a) + " " + u), h("td", { class: "r" }, f(b) + " " + u), h("td", { class: "r " + (Math.abs(d) < 3 ? "" : d > 0 ? "delta-up" : "delta-down") }, Number.isFinite(d) ? `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}%` : "–")); };
    right.append(h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Numbers")),
      h("div", { class: "panel-body flush" }, h("table", { class: "data" }, h("thead", null, h("tr", null, h("th", null, ""), h("th", { class: "r" }, "Flight"), h("th", { class: "r" }, "Model"), h("th", { class: "r" }, "Difference"))),
        h("tbody", null,
          row("Apogee", cmp.apogee.actual, cmp.apogee.predicted, (x) => D.fmtAlt(x), D.altUnit),
          row("Time to apogee", cmp.timeToApogee.actual, cmp.timeToApogee.predicted, (x) => fmt(x, 1), "s"),
          row("Top speed", cmp.maxVelocity.actual, cmp.maxVelocity.predicted, (x) => D.fmtVel(x), D.velUnit))))));
  } else {
    left.append(h("div", { class: "empty" }, h("h3", null, "No prediction yet"), h("p", null, "Choose a rocket profile and Simulate, or pick a predicted flight file (for example an OpenRocket export). The model's altitude and speed are drawn over the flight, with the difference underneath.")));
  }
  right.append(dragPanel());
}

function dragPanel() {
  const c = H.current, r = c.res;
  const rocket = H.store.rockets.find((x) => x.id === (c.pred?.rocketId || set.predictions[c.key]?.rocketId || H.store.selected));
  const d = set.drag[c.key] || {};
  let mass = d.mass, diam = d.diameter;
  if ((!mass || !diam) && rocket) {
    const top = rocket.stages[rocket.stages.length - 1];
    mass ||= top.dryMass + (top.motor ? (top.motor.totalMass - top.motor.propMass) * (top.motorCount || 1) : 0);
    diam ||= top.diameter;
  }
  const out = h("div");
  const calc = () => {
    clear(out);
    const cd = estimateCd(r, { mass, diameter: diam, site: siteFromFlight() });
    if (!cd || cd.median == null) { out.append(h("p", { class: "note" }, cd?.note || "Enter the mass and diameter to estimate drag.")); return; }
    out.append(h("div", { class: "row", style: { alignItems: "baseline", gap: "14px" } }, h("div", { class: "cd-big" }, fmt(cd.median, 2)), h("div", { class: "note" }, `drag coefficient, middle half ${fmt(cd.p25, 2)}–${fmt(cd.p75, 2)}, from ${cd.n} coast samples (${cd.source})`)));
    const chartBox = h("div", { style: { height: "180px", position: "relative", marginTop: "8px" } });
    out.append(chartBox);
    const ch = new TimeChart(chartBox, { xLabel: "Mach number", xUnit: "", yLabel: "Cd", legend: false, xFormat: (x) => `Mach ${x.toFixed(3)}`, yFixed: [0, Math.max(1, cd.p75 * 2)] });
    ch.addSeries({ id: "cd", label: "Cd", color: "--d-acc", x: cd.mach, y: cd.cd, style: "points", radius: 1.6, digits: 3 });
    if (rocket) {
      const top = rocket.stages.length - 1;
      const r2 = structuredClone(rocket); r2.stages[top].cd = cd.median;
      const sim = simulate(r2, siteFromFlight(), { rate: 20 });
      const ap = sim.summary.apogee;
      const diff = ((ap - r.apogee.h) / r.apogee.h) * 100;
      out.append(h("div", { class: "verdict" }, `With Cd ${fmt(cd.median, 2)} instead of ${fmt(rocket.stages[top].cd, 2)}, the ${rocket.name} model predicts ${D.fmtAlt(ap)} ${D.altUnit}. This flight reached ${D.fmtAlt(r.apogee.h)} ${D.altUnit} (${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)}% gap).`));
      out.append(h("button", { class: "btn", onclick: async () => {
        const live = H.store.rockets.find((x) => x.id === rocket.id);
        live.stages[top].cd = +cd.median.toFixed(3);
        await saveRockets(host, H.store);
        toast(`Saved Cd ${fmt(cd.median, 2)} to ${rocket.name}. Mockingbird and future predictions use it.`, "go", 6000);
        if (c.pred?.kind === "sim") runPrediction(set.predictions[c.key]); else render();
      } }, `Save Cd ${fmt(cd.median, 2)} to ${rocket.name}`));
    }
  };
  const massF = numField("Mass after burnout", mass ? +mass.toFixed(3) : "", "kg", (v) => { mass = v; set.drag[c.key] = { mass, diameter: diam }; set.save(); calc(); }, { title: "Rocket plus empty motor casing" });
  const diaF = numField("Body diameter", diam ? +(diam * 1000).toFixed(1) : "", "mm", (v) => { diam = v / 1000; set.drag[c.key] = { mass, diameter: diam }; set.save(); calc(); });
  const panel = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Drag from the coast phase"), h("span", { class: "hint" }, "Where models usually go wrong")),
    h("div", { class: "panel-body" }, h("div", { class: "grid-form two" }, massF, diaF), h("div", { style: { marginTop: "10px" } }, out)));
  setTimeout(calc, 0);
  return panel;
}

// ------------------------------------------------------------------ compare
function tabCompare() {
  const keys = [H.current.key, ...[...H.compare].filter((k) => k !== H.current.key)];
  if (keys.length < 2) {
    ui.tabBody.append(h("div", { class: "empty" }, h("h3", null, "Pick flights to compare"), h("p", null, "Tick the boxes next to flights in the library. Their altitude and speed are drawn on the same time scale, starting at liftoff, with the key numbers side by side.")));
    return;
  }
  const flights = [];
  const load = async () => {
    for (const k of keys) {
      if (!H.cache.has(k)) {
        const [area, ...rest] = k.split(":"); const path = rest.join(":");
        try { H.cache.set(k, loadFlight(await host.read(area, path), { key: k, area, path, name: niceName(area, path) })); } catch (e) { toast(`${niceName(area, path)}: ${e.message}`, "fault"); continue; }
      }
      const f = H.cache.get(k);
      if (f && f.res) flights.push(f);
    }
    const ser = (fn, unit, digits) => flights.map((f, i) => ({ id: "f" + i, label: f.name, color: CMP_COLORS[i % CMP_COLORS.length], x: Float64Array.from(f.res.t, (x) => x - f.res.tLift), y: Float64Array.from(fn(f.res)), unit, digits, width: i === 0 ? 2.2 : 1.5 }));
    const charts = h("div", { style: { height: "520px" } });
    ui.tabBody.append(charts);
    makeCharts(charts, [
      { title: "Altitude", opts: { yLabel: `Altitude (${D.altUnit})`, yIncludeZero: true }, weight: 1.3, series: ser((r) => Array.from(r.h, D.alt), D.altUnit, 0) },
      { title: "Vertical speed", opts: { yLabel: `Speed (${D.velUnit})`, yIncludeZero: true }, series: ser((r) => Array.from(r.v, D.vel), D.velUnit, 0) },
    ]);
    const rows = flights.map((f, i) => { const s = f.res.stats; return h("tr", null, h("td", null, h("span", { style: { display: "inline-block", width: "12px", height: "3px", background: `var(${CMP_COLORS[i % CMP_COLORS.length]})`, marginRight: "6px", verticalAlign: "middle" } }), f.name),
      h("td", { class: "r" }, D.fmtAlt(s.apogee)), h("td", { class: "r" }, fmt(s.timeToApogee, 1)), h("td", { class: "r" }, D.fmtVel(s.maxVelocity)), h("td", { class: "r" }, Number.isFinite(s.maxAccelG) ? fmt(s.maxAccelG, 1) : "–"),
      h("td", { class: "r" }, s.descentRates.map((x) => D.fmtVel(x)).join(" / ") || "–"), h("td", { class: "r" }, s.landingSpeed != null ? D.fmtVel(s.landingSpeed, 1) : "–")); });
    ui.tabBody.append(h("div", { class: "panel", style: { marginTop: "10px" } }, h("div", { class: "panel-body flush" }, h("table", { class: "data" },
      h("thead", null, h("tr", null, ["Flight", `Apogee (${D.altUnit})`, "To apogee (s)", `Top speed (${D.velUnit})`, "Peak (g)", `Descent (${D.velUnit})`, `Landing (${D.velUnit})`].map((x, i) => h("th", { class: i ? "r" : "" }, x)))), h("tbody", null, rows)))));
  };
  load();
}

// ------------------------------------------------------------------ data and notes
function tabData() {
  const c = H.current, r = c.res;
  const mapped = c.mapping.filter((m) => m.role);
  const w = [...r.warnings];
  ui.tabBody.append(h("div", { class: "two" },
    h("div", { class: "col", style: { gap: "10px" } },
      h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "How Heron read this file"), h("div", { class: "spacer" }), h("button", { class: "btn small", onclick: openMapping }, "Columns…")),
        h("div", { class: "panel-body flush" }, h("table", { class: "data" }, h("thead", null, h("tr", null, h("th", null, "Column"), h("th", null, "Read as"), h("th", null, "Unit"))),
          h("tbody", null, mapped.map((m) => h("tr", null, h("td", null, m.name), h("td", null, ROLE_BY_ID[m.role].label), h("td", null, (m.unit || "–") + (m.guessed ? " (guessed)" : "")))))))),
      h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Plot any column")), h("div", { class: "panel-body" }, columnPlot()))),
    h("div", { class: "col", style: { gap: "10px" } },
      h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Sensor health"), h("span", { class: "hint" }, "Problems with the flight computer's data, not the flight")),
        h("div", { class: "panel-body" }, healthList())),
      h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Notes")),
        h("div", { class: "panel-body" }, w.length ? h("ul", { class: "warn-list" }, w.map((x) => h("li", null, x))) : h("p", { class: "note", style: { margin: 0 } }, "Nothing unusual in this log."))),
      h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Sensors and detection")),
        h("div", { class: "panel-body flush" }, h("table", { class: "data" }, h("tbody", null,
          [["File format", c.parsed.format === "openrocket" ? "OpenRocket export" : `Text, ${c.parsed.delimiter === "\t" ? "tab" : c.parsed.delimiter} separated`],
           ["Rows", fmt(c.flight.rows)], ["Sample rate", `${fmt(r.rate, 1)} per second`],
           ["Altitude source", r.altSource], ["Barometer noise on the pad", `${fmt(D.alt(r.sigmaH), 2)} ${D.altUnit}`],
           ["Accelerometer", r.f ? `${ROLE_BY_ID[r.accAxis]?.label || r.accAxis}, noise ${fmt(r.sigmaA / G0, 3)} g` : "none"],
           ["Liftoff found by", r.liftSource], ["Ground level in file", `${fmt(D.alt(r.ground), 1)} ${D.altUnit}`],
           ["Pad temperature used", `${fmt(r.padTempC, 1)} °C`]].map(([k, v]) => h("tr", null, h("td", null, k), h("td", null, v))))))))));
}

function columnPlot() {
  const c = H.current;
  const cols = c.parsed.columns.filter((x) => !x.isText);
  const box = h("div", { style: { height: "240px", position: "relative", marginTop: "8px" } });
  let chart = null;
  const draw = (idx) => {
    if (chart) chart.destroy();
    clear(box);
    const col = c.parsed.columns[idx];
    const tcol = c.mapping.find((m) => m.role === "time");
    const tt = c.flight.t;
    const vals = Float64Array.from({ length: tt.length }, (_, i) => col.values[i]);
    chart = new TimeChart(box, { xLabel: "Time from start of log (s)", yLabel: col.name, legend: false });
    chart.addSeries({ id: "c", label: col.name, color: "--d-aux1", x: tt, y: vals, digits: 3 });
    if (!tcol) toast("No time column is set, so the x axis assumes a fixed sample rate.");
  };
  const sel = selectField("Column", "", cols.map((x) => [c.parsed.columns.indexOf(x), x.name]), (v) => draw(Number(v)));
  setTimeout(() => cols.length && draw(c.parsed.columns.indexOf(cols[0])), 0);
  return h("div", null, sel, box);
}

// ------------------------------------------------------------------ columns dialog
function openMapping() {
  const c = H.current;
  const map = c.mapping.map((m) => ({ ...m }));
  let rate = set.sampleRates[c.key] || 100;
  const tb = h("tbody");
  const drawRows = () => {
    clear(tb);
    for (const m of map) {
      const col = c.parsed.columns[m.index];
      const sample = col.isText ? col.text.find((x) => x) : Array.from(col.values.slice(0, 50)).find(Number.isFinite);
      const def = ROLE_BY_ID[m.role];
      const roleSel = h("select", { "aria-label": `Meaning of ${m.name}`, onchange: () => { const r = roleSel.value; if (r) for (const o of map) if (o !== m && o.role === r) o.role = ""; m.role = r; m.unit = ""; m.guessed = false; drawRows(); } },
        h("option", { value: "" }, "Not used"), ROLES.map((r) => h("option", { value: r.role, selected: r.role === m.role }, r.label)));
      const units = def ? UNIT_CHOICES[def.kind] : null;
      const unitSel = units ? h("select", { "aria-label": `Unit of ${m.name}`, onchange: () => { m.unit = unitSel.value; m.guessed = false; } }, units.map((u) => h("option", { value: u, selected: (m.unit || units[0]).toLowerCase() === u.toLowerCase() }, u + (m.guessed && (m.unit || "").toLowerCase() === u.toLowerCase() ? " (guessed)" : "")))) : h("span", { class: "faint" }, "–");
      const sc = h("input", { type: "number", value: m.scale ?? 1, step: "any", style: { width: "80px" }, onchange: () => { m.scale = Number(sc.value) || 1; } });
      tb.append(h("tr", null, h("td", null, m.name), h("td", { class: "sample" }, sample === undefined ? "" : String(sample)), h("td", null, roleSel), h("td", null, unitSel), h("td", null, sc)));
    }
  };
  drawRows();
  const body = h("div", null,
    h("p", { class: "note", style: { marginTop: 0 } }, "Heron needs a time column and at least one of altitude, pressure or acceleration. Units marked “guessed” were worked out from the numbers; check them, especially altitude (feet or metres)."),
    h("table", { class: "data mapping-table" }, h("thead", null, h("tr", null, ["Column", "First value", "Meaning", "Unit", "Scale"].map((x) => h("th", null, x)))), tb),
    h("div", { class: "grid-form", style: { marginTop: "12px" } }, numField("Samples per second (only used if there is no time column)", rate, "Hz", (v) => { rate = v || 100; })));
  modal({
    title: "Columns", body, wide: true,
    actions: [{ label: "Cancel" }, { label: "Apply", kind: "primary", onClick: () => {
      set.mappings[c.key] = map.map((m) => ({ name: m.name, role: m.role, unit: m.unit, scale: m.scale }));
      set.sampleRates[c.key] = rate; set.save();
      openText(c.text, { key: c.key, area: c.area, path: c.path, name: c.name });
    } }],
  });
}

// ------------------------------------------------------------------ export
function exportMenu() {
  const c = H.current, r = c.res;
  const base = safeName(c.name.replace(/\.[^.]+$/, ""));
  const processed = () => {
    const L = r.tLift;
    const phaseAt = (t) => r.phases.find((p) => t >= p.t0 && t < p.t1)?.phase || "";
    const t = Array.from(r.t, (x) => x - L);
    return toCSV(["time_from_liftoff_s", "altitude_agl_m", "altitude_measured_agl_m", "vertical_speed_mps", "accel_axial_g", "phase"],
      [t, Array.from(r.h), Array.from(r.agl), Array.from(r.v), r.f ? Array.from(r.f, (v) => v / G0) : t.map(() => NaN), Array.from(r.t, phaseAt)], 4);
  };
  const summary = () => {
    const s = r.stats;
    return [`${c.name}`, `Analysed by Heron on ${new Date().toLocaleString()}`, "",
      `Apogee: ${D.fmtAlt(s.apogee)} ${D.altUnit} at T+${fmt(s.timeToApogee, 2)} s`,
      `Top speed: ${D.fmtVel(s.maxVelocity)} ${D.velUnit} (Mach ${fmt(s.maxMach, 2)})`,
      `Peak acceleration: ${fmt(s.maxAccelG, 1)} g`, `Burnout: ${r.burns.map((b) => "T+" + fmt(b.end - r.tLift, 2) + " s").join(", ")}`,
      `Coast to apogee: ${fmt(s.coastTime, 2)} s`, `Descent rates: ${s.descentRates.map((x) => D.fmtVel(x) + " " + D.velUnit).join(", ") || "n/a"}`,
      `Landing speed: ${s.landingSpeed != null ? D.fmtVel(s.landingSpeed, 1) + " " + D.velUnit : "n/a"}`, `Flight time: ${s.flightTime != null ? fmt(s.flightTime, 1) + " s" : "n/a"}`,
      s.drift != null ? `Drift: ${D.fmtDist(s.drift)}` : "", "", "Events:", ...eventList(r).map((e) => `  T${e.t >= 0 ? "+" : "-"}${Math.abs(e.t).toFixed(2)}  ${e.label}`),
      ...(r.warnings.length ? ["", "Notes:", ...r.warnings.map((w) => "  " + w)] : [])].join("\n");
  };
  modal({
    title: "Export", body: h("div", { class: "col" },
      h("button", { class: "btn", onclick: () => download(`${base} processed.csv`, processed(), "text/csv") }, "Processed data (CSV): time from liftoff, altitude, speed, acceleration, phase"),
      h("button", { class: "btn", onclick: () => download(`${base} summary.txt`, summary()) }, "Summary (text)"),
      h("button", { class: "btn", onclick: () => { navigator.clipboard.writeText(summary()).then(() => toast("Summary copied")); } }, "Copy summary to the clipboard"),
      h("p", { class: "note" }, "For a PDF, use Print report and choose “Save as PDF”. Each chart also has its own PNG button.")),
    actions: [{ label: "Done" }],
  });
}

// ------------------------------------------------------------------ sample flight
async function makeSample() {
  const rocket = H.store.rockets.find((x) => x.id === "example-dual") || H.store.rockets[0];
  const sim = new FlightSim(rocket, { elevation: 230, tempC: 21 }, { mode: "ideal" });
  const R = rng(20261102);
  const lines = ["time_ms,pressure_pa,accel_z_g,temp_c,state"];
  let launched = false;
  while (!sim.done && sim.t < 600) {
    if (!launched && sim.t >= 4) { sim.launch(); launched = true; }
    const m = sim.measure({ baroNoise: 3, accelNoise: 0.25 }, R);
    lines.push([Math.round(sim.t * 1000) + 51234, m.p_pa.toFixed(1), (m.az / G0).toFixed(3), m.temp_c.toFixed(2), sim.phase.toUpperCase()].join(","));
    sim.step(0.01);
  }
  for (let i = 0; i < 1000; i++) { const m = sim.measure({ baroNoise: 3, accelNoise: 0.25 }, R); lines.push([Math.round(sim.t * 1000) + 51234, m.p_pa.toFixed(1), (m.az / G0).toFixed(3), m.temp_c.toFixed(2), "LANDED"].join(",")); sim.step(0.01); }
  const text = lines.join("\n") + "\n";
  const r = await host.write("heron", "Sample flight (simulated).csv", text, false);
  await refreshLibrary();
  openText(text, { key: `heron:${r.path}`, area: "heron", path: r.path, name: "Sample flight (simulated)" });
  toast("Opened a simulated 100 Hz flight log with barometer and accelerometer noise.", "", 6000);
}

main().catch((e) => { document.body.append(h("pre", { style: { padding: "20px" } }, "Heron failed to start: " + e.stack)); });
