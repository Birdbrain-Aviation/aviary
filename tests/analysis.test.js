import test from "node:test";
import assert from "node:assert/strict";
import { simulate, FlightSim, rng } from "../web/shared/js/sim.js";
import { exampleRockets } from "../web/shared/js/rockets.js";
import { parseLogText, guessMapping, buildFlight } from "../web/shared/js/flightlog.js";
import { analyzeFlight, estimateCd, compare } from "../web/shared/js/analysis.js";
import { G0 } from "../web/shared/js/units.js";

// Make a realistic log from the simulator: 100 Hz, noisy baro and accel.
function fakeLog({ rocket, rate = 100, header = "time_ms,pressure_pa,accel_z_g,temp_c,state", pad = 5, withAccel = true, altFeet = false, seed = 7 }) {
  const sim = new FlightSim(rocket, { elevation: 300, tempC: 20 }, { mode: "ideal" });
  const R = rng(seed);
  const lines = [header];
  const dt = 1 / rate;
  let launched = false;
  while (!sim.done && sim.t < 400) {
    if (!launched && sim.t >= pad) { sim.launch(); launched = true; }
    const m = sim.measure({ baroNoise: 3, accelNoise: 0.3 }, R);
    const ms = Math.round(sim.t * 1000) + 12345;
    if (header.startsWith("time_ms,pressure")) lines.push([ms, m.p_pa.toFixed(1), (m.az / G0).toFixed(3), m.temp_c.toFixed(2), sim.phase.toUpperCase()].join(","));
    else lines.push([(sim.t).toFixed(3), (altFeet ? m.alt_m / 0.3048 : m.alt_m).toFixed(2)].join(","));
    sim.step(dt);
  }
  for (let i = 0; i < rate * 4; i++) { const m = sim.measure({ baroNoise: 3, accelNoise: 0.3 }, R); lines.push([Math.round(sim.t * 1000) + 12345, m.p_pa.toFixed(1), (m.az / G0).toFixed(3), m.temp_c.toFixed(2), "LANDED"].join(",")); sim.step(dt); }
  return { text: lines.join("\n"), sim };
}

test("a knock on the pad before launch doesn't move liftoff", () => {
  const rocket = exampleRockets()[0];
  const { text } = fakeLog({ rocket, pad: 8 });
  // 6 g for 80 ms, 3 s before launch (log time starts at 12.345 s)
  const lines = text.split("\n").map((ln, i) => {
    if (!i) return ln;
    const c = ln.split(","); const ts = (Number(c[0]) - 12345) / 1000;
    if (ts > 5 && ts < 5.08) c[2] = "6.000";
    return c.join(",");
  });
  const parsed = parseLogText(lines.join("\n"), "knock.csv");
  const res = analyzeFlight(buildFlight(parsed, guessMapping(parsed)));
  console.log("knock: liftoff at", res.tLift.toFixed(3), "true 8");
  assert.ok(Math.abs(res.tLift - 8) < 0.06, "liftoff time " + res.tLift);
});

test("analyse a noisy baro+accel log", () => {
  const rocket = exampleRockets()[0];
  const { text, sim } = fakeLog({ rocket });
  const parsed = parseLogText(text, "test.csv");
  const map = guessMapping(parsed);
  const roles = Object.fromEntries(map.filter(m => m.role).map(m => [m.role, m.unit]));
  assert.deepEqual(roles, { time: "ms", pressure: "pa", acc: "g", temp: "c", state: "" });
  const flight = buildFlight(parsed, map);
  const res = analyzeFlight(flight);
  const truthApogee = sim.maxH;
  console.log("apogee est", res.apogee.h.toFixed(1), "truth", truthApogee.toFixed(1), "maxV", res.maxV.v.toFixed(1), "truth", sim.maxV.toFixed(1),
    "lift", res.tLift.toFixed(3), "acc", res.maxAcc.g.toFixed(2), "burns", res.burns.length, res.burns.map(b => [b.start.toFixed(2), b.end.toFixed(2)]),
    "segs", res.segments.map(s => s.mean.toFixed(1)), "landing", res.landingSpeed?.toFixed(2), "warn", res.warnings);
  assert.ok(Math.abs(res.apogee.h - truthApogee) < 3, "apogee");
  assert.ok(Math.abs(res.maxV.v - sim.maxV) < 3, "max velocity");
  assert.ok(Math.abs(res.tLift - 5) < 0.06, "liftoff time " + res.tLift);
  assert.equal(res.burns.length, 1);
  assert.ok(Math.abs(res.burns[0].end - res.tLift - 1.5) < 0.1, "burnout");
  assert.equal(res.segments.length, 2, "drogue + main");
  assert.ok(Math.abs(res.segments[0].mean - 15) < 1.5, "drogue rate " + res.segments[0].mean);
  assert.ok(Math.abs(res.segments[1].mean - 5.6) < 0.7, "main rate " + res.segments[1].mean);
  assert.ok(res.landed);
  const cd = estimateCd(res, { mass: 0.75 + 0.0625, diameter: 0.054, site: { elevation: 300 } });
  console.log("Cd", cd.median?.toFixed(3), "n", cd.n, cd.p25?.toFixed(3), cd.p75?.toFixed(3));
  assert.ok(Math.abs(cd.median - 0.5) < 0.05, "Cd " + cd.median);
});

test("baro-only altitude-in-feet log, no header units", () => {
  const rocket = exampleRockets()[0];
  const { text, sim } = fakeLog({ rocket, header: "Time,Altitude (ft)", altFeet: true });
  const parsed = parseLogText(text.split("\n").filter(l => l.split(",").length === 2 || l.startsWith("Time")).join("\n"), "alt.csv");
  const map = guessMapping(parsed);
  const res = analyzeFlight(buildFlight(parsed, map));
  console.log("ft-log apogee", res.apogee.h.toFixed(1), "truth", sim.maxH.toFixed(1), "maxV", res.maxV.v.toFixed(1), sim.maxV.toFixed(1), "burn end", res.burns[0].end.toFixed(2));
  assert.ok(Math.abs(res.apogee.h - sim.maxH) < 3);
  assert.ok(Math.abs(res.maxV.v - sim.maxV) < 8, "baro-only max v");
});

test("OpenRocket export with # header and events", () => {
  const { series, events } = simulate(exampleRockets()[0], {}, { rate: 20 });
  let txt = "# Rocket 'Test'\n# Simulation 1\n# Time (s),Altitude (m),Vertical velocity (m/s),Vertical acceleration (m/s²),Total velocity (m/s),Air pressure (mbar)\n";
  txt += "# Event IGNITION occurred at t=0 seconds\n# Event LAUNCH occurred at t=0 seconds\n";
  for (let i = 0; i < series.t.length; i++) {
    if (i === 300) txt += "# Event APOGEE occurred at t=" + series.t[i].toFixed(3) + " seconds\n";
    txt += [series.t[i], series.h[i].toFixed(3), series.v[i].toFixed(3), series.a[i].toFixed(3), Math.abs(series.v[i]).toFixed(3), (series.p[i] / 100).toFixed(2)].join(",") + "\n";
  }
  const parsed = parseLogText(txt, "or.csv");
  assert.equal(parsed.format, "openrocket");
  const map = guessMapping(parsed);
  const roles = Object.fromEntries(map.filter(m => m.role).map(m => [m.name, m.role]));
  console.log("openrocket roles", roles, "events", parsed.events.length);
  assert.equal(roles["Time (s)"], "time");
  assert.equal(roles["Altitude (m)"], "alt");
  assert.equal(roles["Vertical velocity (m/s)"], "vel");
  assert.equal(roles["Vertical acceleration (m/s²)"], "acc_kin");
  assert.equal(roles["Air pressure (mbar)"], "pressure");
  assert.ok(!roles["Total velocity (m/s)"]);
  assert.equal(parsed.events.length, 3);
  const res = analyzeFlight(buildFlight(parsed, map));
  assert.ok(Math.abs(res.apogee.h - Math.max(...series.h)) < 2);
});

test("compare against a prediction", () => {
  const rocket = exampleRockets()[0];
  const { text } = fakeLog({ rocket });
  const parsed = parseLogText(text, "x.csv");
  const res = analyzeFlight(buildFlight(parsed, guessMapping(parsed)));
  const r2 = structuredClone(rocket); r2.stages[0].cd = 0.4;
  const pred = simulate(r2, { elevation: 300, tempC: 20 }, { rate: 50 }).series;
  const c = compare(res, pred);
  console.log("compare apogee", c.apogee, "max resid", Math.min(...c.dh).toFixed(1));
  assert.ok(c.apogee.predicted > c.apogee.actual);
  assert.ok(c.t.length > 100);
});
