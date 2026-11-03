import test from "node:test";
import assert from "node:assert/strict";
import { simulate, FlightSim, rng } from "../web/shared/js/sim.js";
import { exampleRockets } from "../web/shared/js/rockets.js";
import { parseEng, quickMotor, impulseClass, thrustAt, motorMass } from "../web/shared/js/motors.js";
import { siteAtmosphere, altitudeFromPressure, isaPressure } from "../web/shared/js/atmosphere.js";

test("atmosphere round trip", () => {
  const atm = siteAtmosphere({ elevation: 1190, tempC: 25 });
  for (const h of [0, 100, 1000, 3000]) {
    const p = atm.pressure(h);
    assert.ok(Math.abs(atm.heightFromPressure(p) - h) < 0.01, `h=${h}`);
  }
  assert.ok(Math.abs(isaPressure(0) - 101325) < 1e-6);
  assert.ok(Math.abs(isaPressure(1000) - 89874.6) < 5);
  assert.ok(Math.abs(atm.density(0) - atm.pGround / (287.05287 * 298.15)) < 1e-9);
});

test("motor classes and quick motor impulse", () => {
  assert.equal(impulseClass(120), "G");
  assert.equal(impulseClass(9), "C");
  assert.equal(impulseClass(80.5), "G");
  assert.equal(impulseClass(80), "F");
  const m = quickMotor({ designation: "G80", totalImpulse: 120 });
  assert.ok(Math.abs(m.totalImpulse - 120) < 0.5, "impulse " + m.totalImpulse);
  assert.equal(m.cls, "G");
  assert.ok(Math.abs(motorMass(m, 999) - (m.totalMass - m.propMass)) < 1e-9);
  assert.ok(thrustAt(m, 0.5) > 50);
});

test("parse a RASP .eng file", () => {
  const eng = `; test motor
G80T 29 124 4-7-10 0.0625 0.125 Test
0.01 40
0.05 95
1.0 82
1.5 75
1.6 0
`;
  const [m] = parseEng(eng);
  assert.equal(m.name, "G80T");
  assert.equal(m.diameter, 0.029);
  assert.equal(m.t[0], 0);
  assert.ok(m.totalImpulse > 120 && m.totalImpulse < 135, String(m.totalImpulse));
});

test("single-stage dual deploy flight is sane", () => {
  const r = exampleRockets()[0];
  const { summary, events } = simulate(r, { elevation: 200, tempC: 20 });
  console.log("dual-deploy summary", JSON.stringify(summary, (k, v) => typeof v === "number" ? +v.toFixed(2) : v));
  assert.ok(summary.apogee > 300 && summary.apogee < 1500, "apogee " + summary.apogee);
  assert.ok(summary.landingVelocity > 3 && summary.landingVelocity < 9, "landing " + summary.landingVelocity);
  const types = events.map((e) => e.type);
  for (const t of ["ignition", "liftoff", "railExit", "burnout", "apogee", "deploy", "landing"]) assert.ok(types.includes(t), t);
  const main = events.find((e) => e.id === "main");
  assert.ok(Math.abs(main.h - 152.4) < 2, "main at " + main.h);
});

test("two-stage flight stages and goes higher", () => {
  const [one, two] = exampleRockets();
  const a = simulate(one, {}).summary, b = simulate(two, {}).summary;
  console.log("two-stage summary", JSON.stringify(b, (k, v) => typeof v === "number" ? +v.toFixed(2) : v));
  assert.equal(b.burnoutTimes.length, 2);
  assert.ok(b.apogee > a.apogee, `${b.apogee} vs ${a.apogee}`);
});

test("no deployment means a hard landing", () => {
  const r = structuredClone(exampleRockets()[0]);
  const sim = new FlightSim(r, {}, { mode: "external" });
  sim.launch();
  while (!sim.done && sim.t < 200) sim.step(0.01);
  const land = sim.events.find((e) => e.type === "landing");
  assert.ok(Math.abs(land.impact) > 40, "impact " + land.impact);
});

test("sensors: pad reads +1 g, pressure matches altitude", () => {
  const r = exampleRockets()[0];
  const sim = new FlightSim(r, { elevation: 100 }, { mode: "ideal" });
  const R = rng(42);
  const m = sim.measure({ baroNoise: 0, accelNoise: 0 }, R);
  assert.ok(Math.abs(m.az - 9.80665) < 1e-6);
  sim.launch();
  for (let i = 0; i < 300; i++) sim.step(0.01);
  const m2 = sim.measure({ baroNoise: 0 }, R);
  assert.ok(Math.abs(sim.atm.heightFromPressure(m2.p_pa) - sim.h) < 0.01);
});
