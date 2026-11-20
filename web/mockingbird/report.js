// Printable test reports: one page for a test, or a summary of a whole set of
// tests. Built when printing (or saving as a PDF) and hidden on screen. Charts
// are drawn at a fixed print size and placed as pictures.

import { marks, h } from "/shared/js/ui.js";
import { fmt } from "/shared/js/units.js";
import { TimeChart } from "/shared/js/chart.js";
import { describeFault } from "/shared/js/hil.js";

const tl = (x) => `T${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)} s`;

// Draw a chart off screen in the day theme and return it as a picture.
async function chartPic(height, opts, series, { markers, bands } = {}) {
  const stage = h("div", { style: { position: "fixed", left: "-20000px", top: "0", width: "800px" } });
  const box = h("div", { style: { width: "800px", height: `${height}px`, position: "relative" } });
  stage.append(box);
  document.body.append(stage);
  try {
    const ch = new TimeChart(box, { tooltip: false, dpr: 3, streaming: false, ...opts });
    for (const s of series) { ch.addSeries(s.spec); ch.setData(s.spec.id, s.x, s.y); }
    if (bands) ch.setBands(bands);
    if (markers) ch.setMarkers(markers);
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    ch.resetView(); ch.redraw();
    const src = ch.toPNG();
    ch.destroy();
    return src;
  } finally { stage.remove(); }
}

async function withDayTheme(fn) {
  const root = document.documentElement, theme = root.dataset.theme;
  root.dataset.theme = "day";
  try { return await fn(); } finally { root.dataset.theme = theme; }
}

function header(kicker, title, metaLines) {
  return h("header", null, h("span", { class: "pr-logo", html: marks.mockingbird }),
    h("div", null, h("div", { class: "pr-kicker" }, kicker), h("h1", null, title)),
    h("div", { class: "pr-meta" }, metaLines.filter(Boolean).map((m) => h("div", null, m))));
}

async function printNode(rep) {
  document.getElementById("print-report")?.remove();
  document.body.append(rep);
  await Promise.all([...rep.querySelectorAll("img")].map((im) => (im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; }))));
  window.print();
}

const checksTable = (checks) => h("table", { class: "pr-checks" },
  h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Check"), h("th", null, "Expected"), h("th", null, "Got"))),
  h("tbody", null, checks.flatMap((c) => [
    h("tr", { class: c.ok ? "ok" : "bad" }, h("td", { class: "ic" }, c.ok ? "✓" : "✕"), h("td", null, c.label + (c.ch ? ` (pyro ${c.ch})` : "")), h("td", null, c.expected || "–"), h("td", null, c.actual || "–")),
    c.detail ? h("tr", { class: "det" }, h("td", null, ""), h("td", { colspan: 3 }, c.detail)) : null,
  ].filter(Boolean))));

// ---------------------------------------------------------------- one test
// R: the report (as shown in the Result tab); ds: the plotted data in SI;
// D: display units; fmtA/fmtV: formatters with units; version: app version.
export async function printRunReport({ R, ds, D, fmtA, fmtV, version }) {
  const rocket = R.rocketProfile || {};
  const verdict = R.stopped ? "stopped" : R.verdict;
  const pics = await withDayTheme(async () => {
    const out = [];
    if (!ds) return out;
    const bands = (ds.bands || []).map((b) => ({ x0: b.x0, x1: Math.max(b.x1, b.x0 + 0.08), color: "--caution", alpha: 0.16, label: b.label }));
    const style = { apogee: ["--orange", undefined], deploy: ["--go", "--go"], action: ["--go", "--go"], bad: ["--fault", "--fault"], fc: ["--d-acc", "--d-acc"] };
    const markers = (ds.markers || []).map((k) => ({ x: k.x, label: k.kind === "apogee" ? `Apogee ${fmtA(k.h)}` : k.text, color: style[k.kind]?.[0] || "--graphite", textColor: style[k.kind]?.[1], dash: k.kind === "fc" ? [2, 3] : undefined }));
    const xFormat = (x) => `${x.toFixed(0)} s`;
    out.push({ title: "Altitude: the simulation's truth and what the flight computer reported", src: await chartPic(220, { yLabel: `Altitude (${D.altUnit})`, xFormat, yIncludeZero: true }, [
      { spec: { id: "truth", label: "True altitude", color: "--d-alt", width: 2 }, x: ds.x, y: ds.h.map(D.alt) },
      { spec: { id: "fc", label: "Flight computer's altitude", color: "--d-acc", dash: [6, 4], width: 1.75 }, x: ds.fcAlt.x, y: ds.fcAlt.y.map(D.alt) }], { markers, bands }) });
    out.push({ title: "Vertical speed", src: await chartPic(150, { yLabel: `Speed (${D.velUnit})`, xLabel: "Time from launch (s)", xFormat, yIncludeZero: true }, [
      { spec: { id: "truth", label: "True vertical speed", color: "--d-vel", width: 2 }, x: ds.x, y: ds.v.map(D.vel) },
      { spec: { id: "fc", label: "Flight computer's speed", color: "--d-acc", dash: [6, 4] }, x: ds.fcVel.x, y: ds.fcVel.y.map(D.vel) }], { markers: markers.map((m) => ({ ...m, label: "" })), bands }) });
    return out;
  });
  const o = R.outcome || {};
  const when = R.meta?.at ? new Date(R.meta.at) : new Date();
  const board = R.meta?.linkType === "virtual" ? "Virtual flight computer" : [R.meta?.hello, R.meta?.link].filter(Boolean).join(" on ");
  const kv = (pairs) => h("div", { class: "pr-kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("span", { class: "k" }, k), h("span", null, v)]));
  const sections = [];
  if (R.pyroTiming?.length) {
    const ms = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(0)} ms` : "–");
    sections.push(h("section", null, h("h2", null, "Pyro timing"), h("table", { class: "pr-small" },
      h("thead", null, h("tr", null, h("th", null, "Output"), h("th", null, "Decision"), h("th", null, "On the board"), h("th", null, "Link"))),
      h("tbody", null, R.pyroTiming.map((p) => h("tr", null, h("td", null, p.label.replace(/ deployment$/, "")), h("td", null, ms(p.decisionMs)),
        h("td", null, p.processingUs == null ? "–" : p.processingUs < 1000 ? `${p.processingUs} µs` : `${(p.processingUs / 1000).toFixed(1)} ms`), h("td", null, p.linkMs != null ? `${p.linkMs.toFixed(0)} ms` : "–")))))));
  }
  if (R.detections?.length) sections.push(h("section", null, h("h2", null, "What the flight computer reported"), kv(R.detections.map((d) => [d.label, d.value]))));
  sections.push(h("section", null, h("h2", null, o.replay ? `Replayed flight (${o.replay})` : "Simulated flight"), kv([
    ["Apogee", Number.isFinite(o.apogee) ? fmtA(o.apogee) : "–"],
    ["Top speed", Number.isFinite(o.maxVelocity) ? fmtV(o.maxVelocity) : "–"],
    ["Landing speed", Number.isFinite(o.landingSpeed) ? `${fmtV(o.landingSpeed)}${o.landingProjected ? " (projected)" : ""}${o.hardLanding ? ", too fast" : ""}` : "–"],
    ["Ended", R.endReason || "–"],
    ["Samples sent", fmt(R.samples || 0)],
    R.boardStats ? ["Board received", `${fmt(R.boardStats.good)}${R.boardStats.bad ? `, ${fmt(R.boardStats.bad)} damaged` : ", none damaged"}`] : null,
  ])));
  if (R.faults?.length) sections.push(h("section", null, h("h2", null, "Faults injected"), h("ul", { class: "pr-list" }, R.faults.map((f) => h("li", null,
    describeFault(f, (k) => rocket.stages?.[k]?.name || `stage ${k + 1}`, (id) => rocket.recovery?.find((d) => d.id === id)?.name || id))))));
  const rep = h("div", { id: "print-report" },
    header("Flight computer test", R.meta?.test?.name || "Test", [
      when.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      `Rocket: ${R.meta?.rocket?.name || rocket.name || "–"}`, board ? `Board: ${board}` : "",
      R.settings ? `${R.settings.rate} samples/s${R.meta?.speed > 1 ? ` at ${R.meta.speed}× speed` : ""}` : ""]),
    h("div", { class: "pr-verdict " + verdict }, h("b", null, verdict === "pass" ? "Passed" : verdict === "fail" ? "Failed" : "Stopped early"),
      R.meta?.test?.note ? h("span", null, R.meta.test.note) : ""),
    h("h2", { class: "pr-h" }, "Checks"),
    (R.checks || []).length ? checksTable(R.checks) : h("p", null, "The rocket has nothing for a flight computer to do."),
    h("div", { class: "pr-charts" }, pics.map((p) => h("figure", null, h("figcaption", null, p.title), h("img", { src: p.src, alt: p.title })))),
    h("div", { class: "pr-cols" }, sections),
    h("footer", null, h("span", null, `Mockingbird · Aviary ${version || ""}`.trim()), h("span", null, R.dir ? `Mockingbird Runs\\${R.dir}` : "")));
  await printNode(rep);
}

// ---------------------------------------------------------------- a set of tests
// s: { rocket, results: [{ test, verdict, firstFail, checks }], at, board }
export async function printSuiteReport({ s, version }) {
  const passed = s.results.filter((r) => r.verdict === "pass").length;
  const when = s.at ? new Date(s.at) : new Date();
  const rows = s.results.flatMap((r) => {
    const bad = (r.checks || []).filter((c) => !c.ok);
    return [
      h("tr", { class: r.verdict === "pass" ? "ok" : "bad" }, h("td", { class: "ic" }, r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✕" : "–"), h("td", null, h("b", null, r.test)),
        h("td", null, r.verdict === "pass" ? "Passed" : r.verdict === "fail" ? `Failed: ${bad.map((c) => c.label).join(", ") || r.firstFail}` : "Stopped")),
      ...bad.filter((c) => c.detail).map((c) => h("tr", { class: "det" }, h("td", null, ""), h("td", { colspan: 2 }, `${c.label}: ${c.detail}`))),
    ];
  });
  const rep = h("div", { id: "print-report" },
    header("Flight computer test set", `${passed} of ${s.results.length} tests passed`, [
      when.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      `Rocket: ${s.rocket}`, s.board ? `Board: ${s.board}` : ""]),
    h("div", { class: "pr-verdict " + (passed === s.results.length ? "pass" : "fail") }, h("b", null, passed === s.results.length ? "All passed" : `${s.results.length - passed} failed`),
      h("span", null, "Each test flies the rocket with a different fault. Open a run in Mockingbird for its charts and every check.")),
    h("table", { class: "pr-checks pr-suite" }, h("tbody", null, rows)),
    h("footer", null, h("span", null, `Mockingbird · Aviary ${version || ""}`.trim()), h("span", null, "")));
  await printNode(rep);
}
