import test from "node:test";
import assert from "node:assert/strict";
import { HILRun, VirtualFC, defaultPyro, checksum, withCS, defaultTests } from "../web/shared/js/hil.js";
import { exampleRockets } from "../web/shared/js/rockets.js";

function runClosedLoop(rocket, { faults = [], fc = true, cfg = {} } = {}) {
  const pyro = defaultPyro(rocket);
  let run, vfc;
  const fromFC = [];
  run = new HILRun({ rocket, site: { elevation: 200, tempC: 18 }, cfg: { rate: 50, padTime: 5, pyro, ...cfg }, faults, send: (l) => vfc && vfc.receive(l) });
  if (fc) vfc = new VirtualFC({ rocket, pyro, send: (l) => { fromFC.push(l); run.handleLine(l); } });
  run.start();
  let t = 0;
  while (!run.done && t < 600) { t += 0.02; run.advanceTo(t); }
  return { run, rep: run.report(), fromFC };
}

test("checksum matches NMEA style", () => {
  assert.equal(checksum("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,"), "47");
  assert.equal(withCS("MBC,PING"), "$MBC,PING*" + checksum("MBC,PING"));
});

test("virtual flight computer passes a dual-deploy test", () => {
  const { rep, run } = runClosedLoop(exampleRockets()[0]);
  console.log(rep.verdict, rep.checks.map(c => `${c.label}: ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`), rep.detections, "landing", rep.outcome.landingSpeed?.toFixed(2), rep.endReason, "samples", rep.samples);
  assert.equal(rep.verdict, "pass");
  assert.ok(rep.outcome.landingSpeed < 7);
  assert.ok(run.csv().split("\n")[0].includes("fc_alt"));
});

test("two-stage staging is graded", () => {
  const { rep } = runClosedLoop(exampleRockets()[1]);
  console.log(rep.verdict, rep.checks.map(c => `${c.label}: ${c.expected} -> ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`));
  assert.ok(rep.checks.some(c => c.label.includes("Sustainer ignition") && c.ok));
  assert.equal(rep.verdict, "pass");
});

test("no flight computer fails and crashes", () => {
  const { rep } = runClosedLoop(exampleRockets()[0], { fc: false });
  console.log(rep.verdict, rep.checks.map(c => `${c.label}: ${c.actual}`), "impact", rep.outcome.landingSpeed?.toFixed(1));
  assert.equal(rep.verdict, "fail");
  assert.ok(rep.outcome.landingSpeed > 30);
});

test("a big barometer jump before apogee fools the simple flight computer", () => {
  const faults = [{ type: "baro_spike", ref: "apogee", offset: -3, duration: 0.6, params: { delta: 800 } }];
  const { rep } = runClosedLoop(exampleRockets()[0], { faults });
  console.log(rep.verdict, rep.checks.map(c => `${c.label}: ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`));
  assert.equal(rep.verdict, "fail");
});

test("CATO: low apogee, main graded as 'right after apogee'", () => {
  const faults = [{ type: "cato", ref: "whole", params: { stage: 0, after: 0.4 } }];
  const { rep } = runClosedLoop(exampleRockets()[0], { faults });
  const main = rep.checks.find((c) => c.label.startsWith("Main"));
  console.log("cato apogee", rep.outcome.apogee.toFixed(1), rep.checks.map((c) => `${c.label}: ${c.expected} -> ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`));
  assert.ok(rep.outcome.apogee < 120, "apogee should be low after a CATO");
  assert.match(main.expected, /right after apogee/);
  assert.equal(rep.verdict, "pass");
});

test("a knock on the pad doesn't trip launch detection, a real launch still does", () => {
  for (const g of [4, 8]) {
    const faults = [{ type: "accel_spike", ref: "liftoff", offset: -3, duration: 0.08, params: { g } }];
    const { rep } = runClosedLoop(exampleRockets()[0], { faults });
    console.log(g, "g knock:", rep.verdict, rep.checks.map((c) => `${c.label}: ${c.actual} ${c.ok ? "ok" : "FAIL"}`));
    assert.equal(rep.verdict, "pass");
    const det = rep.detections.find((d) => d.label === "Launch detection");
    assert.ok(det && /after liftoff/.test(det.value), det?.value);
    assert.ok(parseFloat(det.value) < 0.6, det.value);   // confirmed quickly
  }
});

test("every default test runs to a verdict", () => {
  for (const rocket of exampleRockets().slice(0, 2)) {
    for (const t of defaultTests(rocket)) {
      const { rep } = runClosedLoop(rocket, { faults: t.faults, cfg: t.padTime ? { padTime: t.padTime } : {} });
      console.log(`${rocket.id} / ${t.name}: ${rep.verdict} (${rep.checks.filter((c) => !c.ok).map((c) => c.label).join(", ") || "all ok"}) apogee ${rep.outcome.apogee.toFixed(0)} m`);
      assert.ok(["pass", "fail"].includes(rep.verdict));
      assert.ok(rep.samples > 100);
    }
  }
});

test("pressure drift keeps its offset after the window", () => {
  const rocket = exampleRockets()[0];
  const ps = [];
  const run = new HILRun({ rocket, site: {}, cfg: { padTime: 20, noise: { baro: 0, accel: 0, gyro: 0 } }, faults: [{ type: "baro_drift", ref: "liftoff", offset: -18, duration: 12, params: { rate: -60 } }], send: () => {}, onSample: (m) => m && ps.push([m.t, m.p_pa]) });
  run.start();
  run.advanceTo(19.5);
  const at = (tt) => ps.find((p) => p[0] >= tt)[1];
  assert.ok(Math.abs(at(1) - at(0.5)) < 0.01, "no drift before the window");
  assert.ok(Math.abs(at(19) - at(1) + 12) < 0.5, "-60 Pa/min for 12 s is -12 Pa, then held");
});

test("custom line format and text rules", () => {
  const rocket = exampleRockets()[0];
  const lines = [];
  const run = new HILRun({ rocket, site: {}, cfg: { protocol: "custom", template: "{t_ms},{p_pa},{az_g}", templateCS: true, padTime: 1, rules: [{ pattern: "drogue out", action: { type: "deploy", id: "drogue" } }] }, send: (l) => lines.push(l) });
  run.start();
  run.advanceTo(0.5);
  assert.match(lines[0], /^\d+,\d+\.\d,[-\d.]+\*[0-9A-F]{2}$/);
  const r = run.handleLine("Drogue out!");
  assert.equal(r.kind, "action");
  assert.equal(run.actions[0].label, "Drogue deploy");
});

test("a real flight log replays into the flight computer and is graded", async () => {
  const { replayFromLog } = await import("../web/shared/js/replay.js");
  const { FlightSim, rng } = await import("../web/shared/js/sim.js");
  // a 50 Hz log with barometer and accelerometer, from a different rocket than the profile's numbers
  const rocket = exampleRockets()[0];
  const sim = new FlightSim(rocket, { elevation: 150 }, { mode: "ideal" });
  const R = rng(5), rows = ["time_s,pressure_pa,accel_z_g"];
  while (!sim.done && sim.t < 300) { if (!sim.launched && sim.t >= 4) sim.launch(); const m = sim.measure({ baroNoise: 2, accelNoise: 0.2 }, R); rows.push([sim.t.toFixed(3), m.p_pa.toFixed(1), (m.az / 9.80665).toFixed(3)].join(",")); sim.step(0.02); }
  const { replay, summary } = replayFromLog(rows.join("\n"), "test.csv");
  assert.ok(Math.abs(summary.apogee - sim.maxH) < 5, "apogee " + summary.apogee);
  const pyro = defaultPyro(rocket);
  let vfc;
  const run = new HILRun({ rocket, site: { elevation: 150 }, cfg: { rate: 50, padTime: 3, pyro, replay, noise: { baro: 0, accel: 0, gyro: 0 } }, send: (l) => vfc && vfc.receive(l) });
  vfc = new VirtualFC({ rocket, pyro, send: (l) => run.handleLine(l) });
  run.start();
  let t = 0;
  while (!run.done && t < 400) { t += 0.02; run.advanceTo(t); }
  const rep = run.report();
  console.log("replay:", rep.verdict, rep.checks.map((c) => `${c.label}: ${c.actual}`), rep.detections.map((d) => d.value), rep.endReason);
  console.log("pyro timing:", rep.pyroTiming.map((p) => `${p.label}: decision ${p.decisionMs.toFixed(0)} ms, processing ${p.processingUs} µs`));
  assert.equal(rep.verdict, "pass");
  assert.equal(rep.outcome.replay, "test.csv");
  assert.ok(rep.pyroTiming.length >= 2 && rep.pyroTiming.every((p) => p.fromBoard && Number.isFinite(p.decisionMs)));
});


test("Monte Carlo: varied flights against the virtual flight computer", async () => {
  const { disperseRun, runVirtual, summarizeMC, MC_DEFAULTS } = await import("../web/shared/js/hil.js");
  const rocket = exampleRockets()[0];
  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    const d = disperseRun(rocket, { elevation: 200 }, MC_DEFAULTS, 1000 + i);
    const cfg = { rate: 50, padTime: d.padTime, pyro: defaultPyro(rocket), noise: { baro: 2 * d.noise, accel: 0.1 * d.noise, gyro: 0.15 } };
    const rep = runVirtual({ rocket: d.rocket, site: d.site, cfg, faults: [{ type: "thrust", params: { factor: d.thrust } }], seed: d.seed });
    results.push({ rep, params: d.params });
  }
  const s = summarizeMC(results);
  console.log(`MC: ${s.passed}/${s.runs} in ${Date.now() - t0} ms, apogee ${s.apogee.min.toFixed(0)}–${s.apogee.max.toFixed(0)} m`, s.checks.map((c) => `${c.label} ${(c.passRate * 100).toFixed(0)}% err ${c.err?.p5.toFixed(2)}..${c.err?.p95.toFixed(2)} s`));
  assert.equal(s.runs, 20);
  assert.ok(s.passRate > 0.8);
  assert.ok(s.apogee.max > s.apogee.min);
});
