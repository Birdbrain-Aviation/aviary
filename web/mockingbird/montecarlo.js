// Monte Carlo testing: many flights with random wind, motor thrust, mass,
// drag, sensor noise and pad wait, to see how reliably each output fires and
// how much its timing spreads. Against the virtual flight computer it runs in
// the background in seconds; against a real board it runs as a series of
// ordinary tests.

import { h, clear, modal, toast, cssVar, stamp, safeName, download } from "/shared/js/ui.js";
import { disperseRun, runVirtual, summarizeMC, MC_DEFAULTS } from "/shared/js/hil.js";

const fmtS = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)} s` : "–");

// ctx: { set, D, rocket, site, test, pyro, cfg(), virtual, runSeries(tests, onDone), host, saveDir }
export function openMonteCarlo(ctx) {
  const { set, D } = ctx;
  const mc = (set.mc = { ...MC_DEFAULTS, runs: ctx.virtual ? 200 : 20, ...(set.mc || {}) });
  const imperial = D.altUnit === "ft";
  const windK = imperial ? 0.44704 : 1, windU = imperial ? "mph" : "m/s";
  const num = (label, key, { unit = "", k = 1, step = 1, min = 0, max = 1e6, pct = false, hint = "" } = {}) => {
    const shown = pct ? mc[key] * 100 : mc[key] / k;
    const inp = h("input", { type: "number", value: +shown.toFixed(3), step, min, max, onchange: () => { const v = Number(inp.value); if (Number.isFinite(v)) { mc[key] = pct ? v / 100 : v * k; ctx.save(); } } });
    return h("label", { class: "field", title: hint }, h("span", null, label), (unit ? h("div", { class: "unit-input" }, inp, h("span", { class: "unit" }, unit)) : inp));
  };
  const runsMax = ctx.virtual ? 2000 : 200;
  const body = h("div", { class: "mc-form" },
    h("p", { class: "note", style: { marginTop: 0 } }, ctx.virtual
      ? "Runs the virtual flight computer through many varied flights in the background, then shows how often each output fired correctly and how its timing spread."
      : `Runs your flight computer through a series of varied flights, one after another, at ${set.run.speed}×. Keep the charges disconnected the whole time.`),
    h("div", { class: "mc-grid" },
      num("Number of flights", "runs", { step: 1, min: 2, max: runsMax }),
      num("Wind, up to", "windMax", { unit: windU, k: windK, step: 1, hint: "Random speed from calm to this, from any direction" }),
      num("Motor thrust spread", "thrustSd", { unit: "% (1σ)", pct: true, step: 1 }),
      num("Mass spread", "massSd", { unit: "% (1σ)", pct: true, step: 1 }),
      num("Drag spread", "cdSd", { unit: "% (1σ)", pct: true, step: 1 }),
      num("Barometer and accelerometer noise, up to", "noiseMax", { unit: "× normal", step: 0.5, min: 1 }),
      num("Wait on the pad, from", "padMin", { unit: "s", step: 1, min: 2 }),
      num("to", "padMax", { unit: "s", step: 1, min: 2 })),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: mc.keepFaults, onchange: (e) => { mc.keepFaults = e.target.checked; ctx.save(); } }),
      `Include the faults from “${ctx.test.name}”`));
  modal({
    title: "Monte Carlo test", body, wide: true,
    actions: [{ label: "Cancel" }, { label: `Start ${ctx.virtual ? "" : "on the board"}`.trim(), kind: "primary", onClick: () => { start(ctx, mc); } }],
  });
}

function makeRuns(ctx, mc) {
  const base = Math.floor(Math.random() * 1e9);
  const out = [];
  for (let i = 0; i < Math.max(2, Math.round(mc.runs)); i++) {
    const d = disperseRun(ctx.rocket, ctx.site, mc, base + i * 7919);
    const faults = [...(mc.keepFaults ? structuredClone(ctx.test.faults || []) : []), { type: "thrust", params: { factor: d.thrust }, enabled: true }];
    out.push({ d, faults });
  }
  return out;
}

function start(ctx, mc) {
  const runs = makeRuns(ctx, mc);
  if (!ctx.virtual) {
    // real board: an ordinary series of tests, each with its own conditions
    const tests = runs.map((r, i) => ({
      id: `mc-${i}`, name: `Monte Carlo ${i + 1} of ${runs.length}`, faults: r.faults, padTime: Math.round(r.d.padTime),
      rocketOverride: r.d.rocket, siteOverride: r.d.site, noiseScale: r.d.noise, mcParams: r.d.params, note: describe(ctx, r.d.params),
    }));
    ctx.runSeries(tests, (results) => showResults(ctx, mc, results));
    return;
  }
  // virtual: in the background, a few runs per frame
  const bar = h("i"), lbl = h("div", { class: "muted" }, "Starting…");
  let stop = false;
  const dlg = modal({ title: "Monte Carlo test", body: h("div", null, lbl, h("div", { class: "cl-bar mc-bar" }, bar)), onClose: () => { stop = true; }, actions: [{ label: "Stop" }] });
  const results = [];
  const cfg0 = ctx.cfg();
  let i = 0;
  const t0 = performance.now();
  const step = () => {
    if (stop) { if (results.length > 1) showResults(ctx, mc, results); return; }
    const until = performance.now() + 40;
    while (i < runs.length && performance.now() < until) {
      const { d, faults } = runs[i++];
      const cfg = { ...cfg0, padTime: d.padTime, noise: { baro: cfg0.noise.baro * d.noise, accel: cfg0.noise.accel * d.noise, gyro: cfg0.noise.gyro }, timeScale: 1 };
      try { results.push({ rep: runVirtual({ rocket: d.rocket, site: d.site, cfg, faults, seed: d.seed }), params: d.params, seed: d.seed }); }
      catch (e) { results.push({ rep: { verdict: "fail", checks: [{ label: "Run", ok: false, actual: e.message }], outcome: {} }, params: d.params, seed: d.seed }); }
    }
    const left = ((performance.now() - t0) / i) * (runs.length - i) / 1000;
    lbl.textContent = `${i} of ${runs.length} flights${i < runs.length ? `, about ${Math.ceil(left)} s left` : ""}`;
    bar.style.width = `${(100 * i) / runs.length}%`;
    if (i < runs.length) setTimeout(step, 0);
    else { stop = true; dlg.close(); showResults(ctx, mc, results); }
  };
  setTimeout(step, 30);
}

function describe(ctx, p) {
  const D = ctx.D, imperial = D.altUnit === "ft";
  return `Wind ${(p.wind / (imperial ? 0.44704 : 1)).toFixed(0)} ${imperial ? "mph" : "m/s"} from ${Math.round(p.windDir)}°, thrust ${pctS(p.thrust)}, mass ${pctS(p.mass)}, drag ${pctS(p.cd)}, noise ×${p.noise.toFixed(1)}, ${p.padTime.toFixed(0)} s on the pad.`;
}
const pctS = (k) => `${k >= 1 ? "+" : "−"}${Math.abs((k - 1) * 100).toFixed(0)}%`;

// results: [{ rep, params, seed? }]
export function showResults(ctx, mc, results) {
  const { D } = ctx;
  const s = summarizeMC(results);
  const alt = (m) => `${D.fmtAlt(m)} ${D.altUnit}`;
  const body = h("div", { class: "mc-results" });
  body.append(h("div", { class: "mc-head" },
    h("div", { class: "mc-big" }, `${Math.round(s.passRate * 100)}%`),
    h("div", null, h("b", null, `${s.passed} of ${s.runs} flights passed`), h("div", { class: "muted" }, `${ctx.rocket.name} · ${ctx.virtual ? "virtual flight computer" : "your flight computer"}`),
      s.apogee ? h("div", { class: "muted" }, `Apogee ${alt(s.apogee.p5)} to ${alt(s.apogee.p95)} (90% of flights), ${alt(s.apogee.min)} to ${alt(s.apogee.max)} overall`) : "")));
  const table = h("table", { class: "data mc-table" },
    h("thead", null, h("tr", null, ["Output", "Passed", "Timing, 90% of flights", "Typical", "Worst", ""].map((x) => h("th", null, x)))),
    h("tbody", null, s.checks.map((c) => {
      const e = c.errAlt || c.err, isAlt = !!c.errAlt;
      const f = (x) => (isAlt ? `${x >= 0 ? "+" : "−"}${D.fmtAlt(Math.abs(x))} ${D.altUnit}` : fmtS(x));
      const worst = e ? (Math.abs(e.min) > Math.abs(e.max) ? e.min : e.max) : null;
      const cv = h("canvas", { class: "mc-hist", width: 220, height: 34 });
      requestAnimationFrame(() => histogram(cv, results.map((r) => { const k = r.rep.checks.find((x) => x.label === c.label); return k ? { v: isAlt ? k.errAlt : k.err, ok: k.ok } : null; }).filter((x) => x && Number.isFinite(x.v))));
      return h("tr", { class: c.passRate < 1 ? "bad" : "" },
        h("td", null, c.label), h("td", null, `${Math.round(c.passRate * 100)}%${c.never ? ` (${c.never} never fired)` : ""}`),
        h("td", null, e ? `${f(e.p5)} to ${f(e.p95)}` : "–"), h("td", null, e ? f(e.p50) : "–"), h("td", null, worst != null ? f(worst) : "–"), h("td", null, cv));
    })));
  body.append(table);
  // the failed flights, with their conditions, to rerun one
  const fails = results.filter((r) => r.rep.verdict !== "pass").slice(0, 8);
  if (fails.length) {
    body.append(h("h3", null, `Flights that failed${results.length - s.passed > fails.length ? ` (first ${fails.length})` : ""}`),
      h("ul", { class: "mc-fails" }, fails.map((r) => h("li", null,
        h("div", null, h("b", null, r.rep.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.actual}`).join("; ") || "Hard landing"), h("div", { class: "muted" }, describe(ctx, r.params))),
        ctx.rerun ? h("button", { class: "btn small", onclick: () => { dlg.close(); ctx.rerun(r); } }, "Watch this flight") : ""))));
  } else body.append(h("p", { class: "note" }, "Every flight passed."));
  const csv = () => {
    const labels = s.checks.map((c) => c.label);
    const rows = [["run", "verdict", "wind_mps", "wind_from_deg", "thrust", "mass", "drag", "noise", "pad_s", "apogee_m", "landing_mps", ...labels.flatMap((l) => [`${l} ok`, `${l} error`])].join(",")];
    results.forEach((r, i) => {
      const p = r.params;
      rows.push([i + 1, r.rep.verdict, p.wind.toFixed(2), p.windDir.toFixed(0), p.thrust.toFixed(3), p.mass.toFixed(3), p.cd.toFixed(3), p.noise.toFixed(2), p.padTime.toFixed(1),
        r.rep.outcome.apogee?.toFixed(1) ?? "", r.rep.outcome.landingSpeed?.toFixed(2) ?? "",
        ...labels.flatMap((l) => { const c = r.rep.checks.find((x) => x.label === l); return [c ? (c.ok ? 1 : 0) : "", c ? (Number.isFinite(c.errAlt) ? c.errAlt.toFixed(2) : Number.isFinite(c.err) ? c.err.toFixed(3) : "") : ""]; })].join(","));
    });
    return rows.join("\n") + "\n";
  };
  const dlg = modal({
    title: "Monte Carlo results", body, wide: true,
    actions: [
      { label: "Save results", onClick: async () => {
        const dir = `${stamp()} ${safeName(ctx.rocket.name)} - Monte Carlo`;
        try {
          await ctx.host.write("mockingbird", `${dir}/montecarlo.csv`, csv());
          await ctx.host.write("mockingbird", `${dir}/summary.json`, JSON.stringify({ app: "Mockingbird", kind: "monte-carlo", rocket: ctx.rocket.name, settings: mc, summary: s }, null, 2));
          toast(`Saved to Mockingbird Runs\\${dir}`, "go");
        } catch (e) { download(`${dir}.csv`, csv(), "text/csv"); }
        return false;
      } },
      { label: "Done", kind: "primary" },
    ],
  });
}

// Small histogram: passes in ink, failures in orange.
function histogram(cv, pts) {
  const c = cv.getContext("2d"), W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H);
  if (pts.length < 2) return;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
  const N = 24, ok = new Array(N).fill(0), bad = new Array(N).fill(0);
  for (const p of pts) { const k = Math.min(N - 1, Math.floor(((p.v - lo) / (hi - lo)) * N)); (p.ok ? ok : bad)[k]++; }
  const mx = Math.max(...ok.map((x, i) => x + bad[i]));
  const bw = W / N;
  c.fillStyle = cssVar("--ink"); c.globalAlpha = 0.75;
  ok.forEach((x, i) => { const hh = (x / mx) * (H - 2); c.fillRect(i * bw + 1, H - hh, bw - 2, hh); });
  c.globalAlpha = 1; c.fillStyle = cssVar("--orange");
  bad.forEach((x, i) => { if (!x) return; const h0 = (ok[i] / mx) * (H - 2), hh = (x / mx) * (H - 2); c.fillRect(i * bw + 1, H - h0 - hh, bw - 2, hh); });
  // zero line
  if (lo < 0 && hi > 0) { const x0 = ((0 - lo) / (hi - lo)) * W; c.fillStyle = cssVar("--faint"); c.fillRect(Math.round(x0), 0, 1, H); }
}
