// End to end: Mockingbird's engine drives the MockingbirdHIL library running
// the MockingbirdTry example (compiled for this PC), over pipes standing in for
// the USB cable, in real time at 10x speed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { HILRun, defaultPyro, defaultTests } from "../web/shared/js/hil.js";
import { exampleRockets } from "../web/shared/js/rockets.js";

const bin = (name) => new URL(`../build/native/${name}`, import.meta.url).pathname;

function runAgainstSketch(name, rocket, { faults = [], speed = 10, padTime = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(name), [], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", hello = null, stderr = "";
    const lines = [];
    const pyro = defaultPyro(rocket);
    const run = new HILRun({ rocket, site: { elevation: 120, tempC: 20 }, cfg: { rate: 50, padTime, pyro, timeScale: speed }, faults, send: (l) => child.stdin.write(l + "\n") });
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        lines.push(line);
        if (/^\$MBE,(READY|PONG)/.test(line)) hello = line;
        if (!run.done || line.startsWith("$MBE,STATS")) run.handleLine(line);
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    setTimeout(() => { // let the "board" boot, like after a DTR reset
      run.start();
      const t0 = performance.now();
      const timer = setInterval(() => {
        run.advanceTo(((performance.now() - t0) / 1000) * speed);
        if (run.done) { clearInterval(timer); setTimeout(() => child.stdin.end(), 300); }
      }, 4);
    }, 200);
    child.on("close", () => resolve({ rep: run.report(), lines, hello, run, stderr }));
    child.on("error", reject);
  });
}

const haveBins = existsSync(bin("MockingbirdTry")) && existsSync(bin("AddToYourFlightComputer"));

test("MockingbirdTry passes a normal flight through the real library", { skip: !haveBins && "build the native examples first" }, async () => {
  const { rep, hello, run, lines } = await runAgainstSketch("MockingbirdTry", exampleRockets()[0]);
  console.log(hello, rep.verdict, rep.checks.map((c) => `${c.label}: ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`), rep.detections.map((d) => `${d.label} ${d.value}`), "stats", rep.boardStats, "lines back", lines.length);
  assert.match(hello, /READY,MockingbirdTry/);
  assert.equal(rep.verdict, "pass");
  assert.ok(run.fcTlm.alt && run.fcTlm.alt.v.length > 100, "board sends its altitude estimate");
  assert.ok(rep.boardStats && rep.boardStats.good > 2000 && rep.boardStats.bad === 0, "board received every sample intact");
});

test("MockingbirdTry fails the pressure-dip test the same way the virtual board does", { skip: !haveBins && "build the native examples first" }, async () => {
  const t = defaultTests().find((x) => x.id === "pressure-dip");
  const { rep } = await runAgainstSketch("MockingbirdTry", exampleRockets()[0], { faults: t.faults });
  console.log(rep.verdict, rep.checks.map((c) => `${c.label}: ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`));
  assert.equal(rep.verdict, "fail");
  assert.ok(rep.checks.some((c) => c.label.startsWith("Drogue") && !c.ok));
});

test("the integration template answers, stays quiet and never touches a pin", { skip: !haveBins && "build the native examples first" }, async () => {
  const { rep, hello, lines, stderr } = await runAgainstSketch("AddToYourFlightComputer", exampleRockets()[0], { speed: 20, padTime: 2 });
  assert.match(hello, /READY,My flight computer/);
  assert.ok(!lines.some((l) => l.startsWith("$MBE,PYRO")));
  assert.match(stderr, /pin writes: 2\b/, "only the two LOW writes in setup()");
  assert.equal(rep.verdict, "fail", "it has no flight logic yet, so nothing deploys");
});

test("a restart mid-flight really restarts the sketch, and the test resumes", { skip: !haveBins && "build the native examples first" }, async () => {
  const t = defaultTests().find((x) => x.id === "reboot-coast");
  const { rep, lines, stderr } = await runAgainstSketch("MockingbirdTry", exampleRockets()[0], { faults: t.faults });
  console.log(rep.verdict, rep.checks.map((c) => `${c.label}: ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`), rep.reboots);
  assert.match(stderr, /restarting/, "the program re-ran itself");
  assert.equal(lines.filter((l) => /^\$MBE,READY/.test(l)).length, 2, "it said READY again after restarting");
  assert.ok(lines.some((l) => l.startsWith("$MBE,RESTARTING")));
  const r = rep.checks.find((c) => c.label === "Restart");
  assert.ok(r && r.ok, "it came back quickly");
  // the example keeps nothing across a restart, so it wakes up thinking it's on the pad
  assert.equal(rep.verdict, "fail");
  assert.match(r.detail, /forgot it was flying|save the flight phase/i);
});

const haveAirbrakes = existsSync(bin("MockingbirdAirbrakes"));
const airbrakeRocket = () => exampleRockets().find((r) => r.id === "example-airbrakes");

test("the airbrake example lands on the target apogee, on a normal and a strong motor", { skip: !haveAirbrakes && "build the native examples first" }, async () => {
  for (const id of ["nominal", "strong-motor"]) {
    const t = defaultTests(airbrakeRocket()).find((x) => x.id === id);
    const { rep, lines } = await runAgainstSketch("MockingbirdAirbrakes", airbrakeRocket(), { faults: t.faults });
    console.log(id, rep.verdict, rep.checks.map((c) => `${c.label}: ${c.actual} ${c.ok ? "ok" : "FAIL " + c.detail}`), rep.detections.filter((d) => /Airbrakes|Tilt/.test(d.label)).map((d) => d.value));
    assert.ok(lines.some((l) => l.startsWith("$MBA,brake,")), "it sent brake commands");
    const c = rep.checks.find((x) => x.label === "Apogee target");
    assert.ok(c && c.ok, JSON.stringify(c));
    assert.ok(rep.checks.find((x) => x.label === "Airbrakes under power").ok);
    assert.equal(rep.verdict, "pass");
  }
});

test("a sketch's tilt estimate holds the sustainer on a tilted launch (virtual board)", async () => {
  // the virtual board carries the same tilt estimate as the airbrake example
  const { runVirtual } = await import("../web/shared/js/hil.js");
  const rocket = exampleRockets()[1];
  const t = defaultTests(rocket).find((x) => x.id === "tilted-launch");
  const rep = runVirtual({ rocket, site: { elevation: 120, tempC: 20 }, cfg: { rate: 50, padTime: 5, pyro: defaultPyro(rocket) }, faults: t.faults, seed: 2 });
  const c = rep.checks.find((x) => x.label === "Sustainer ignition");
  assert.equal(c.actual, "held off");
  assert.equal(rep.verdict, "pass");
});
