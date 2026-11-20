// Run one Mockingbird test against a sketch compiled for the virtual board.
//
// The board and the simulation advance in lockstep: the board asks for the
// sensors at its own (virtual) time, the simulation catches up to that time
// and answers. A pyro pin going HIGH is a firing of whatever that pin is wired
// to in the task; a servo on the airbrake pin moves the airbrakes. Grading is
// Mockingbird's own, plus pin-level checks only this setup can see: firing
// while disarmed, firing on the pad, and pyro outputs left on.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HILRun, DEFAULT_TOL } from "../../web/shared/js/hil.js";
import { classify } from "./safety.mjs";

const GAP = { p_pa: NaN, temp_c: NaN, ax: NaN, ay: NaN, az: NaN, gx: NaN, gy: NaN, gz: NaN, lat: NaN, lon: NaN, gps_alt: NaN };
const fmtAlt = (m) => `${m.toFixed(0)} m`;
const fmtVel = (v) => `${v.toFixed(1)} m/s`;

// Each test's sensors get a fixed offset, as real parts have: the MPU6050's
// datasheet allows up to ±20 °/s of gyro zero-rate offset and ±50–80 mg of
// accelerometer offset; typical parts are well inside that, so the bench uses
// up to ±2 °/s and ±0.3 m/s² per axis. Code that integrates the gyro without
// measuring its bias on the pad drifts. Seeded by test and seed.
export function sensorBias(seed, id) {
  let h = 2166136261 ^ seed;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const R = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  const u = (a) => (2 * R() - 1) * a;
  return { ax: u(0.3), ay: u(0.3), az: u(0.3), gx: u(2), gy: u(2), gz: u(2) };
}

// Pyro table for HILRun from the task's pin list: channel = position + 1.
export function pyroTable(task) {
  return task.hardware.pyro.map((p, i) => ({ ch: i + 1, action: p.action }));
}

// timeoutMs caps the whole test; idleMs is how long the board may go without
// asking for sensors (an endless loop that never calls millis() or delay()).
export function runTest({ bin, task, rocket, site, test, seed = 1, timeoutMs = 180000, idleMs = 5000 }) {
  return new Promise((resolve) => {
    const hw = task.hardware;
    const pins = new Map(hw.pyro.map((p, i) => [p.pin, { ...p, ch: i + 1 }]));
    const armMode = test.bench?.arm ?? "always";        // "always" | "never"
    const armed = () => armMode !== "never";
    const tmp = mkdtempSync(join(tmpdir(), "bench-"));
    let pendingRestart = false, latest = null, lastUs = 0, booted = false, finished = false, timedOut = false;
    const pinLog = [];             // { pin, val, t }
    const modes = new Map();       // pin -> mode
    const onAt = new Map();        // pyro pin -> time it went HIGH
    const pinFindings = [];        // checks only the pin level can see
    const bias = test.bench?.noBias ? { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 } : sensorBias(seed, test.id);
    const b = (m, k) => (Number.isFinite(m[k]) ? m[k] + bias[k] : m[k]);
    const servoLog = [];

    const run = new HILRun({
      rocket, site, seed, faults: structuredClone(test.faults || []),
      cfg: { rate: task.rate || 100, padTime: test.padTime ?? 10, pyro: pyroTable(task), axis: { up: hw.imu?.up || "z", sign: hw.imu?.sign || 1 }, protocol: "mb", timeScale: 1, tol: { ...DEFAULT_TOL, ...(task.tol || {}) }, maxTime: 400 },
      send: (l) => { if (/^\$MBC,REBOOT/.test(l)) pendingRestart = true; },
      // a data gap reaches the board as sensors that stop answering
      onSample: (m) => { latest = m || GAP; },
    });

    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, BENCH_EEPROM: join(tmp, "eeprom.bin"), BENCH_ARM_PIN: hw.arm ? String(hw.arm.pin) : "-1", BENCH_ARMED_LEVEL: hw.arm ? String(hw.arm.armedLevel ?? 0) : "0" } });
    let consoleText = "", stderr = "";
    child.stdio[3].on("data", (d) => { if (consoleText.length < 200000) consoleText += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const reply = (s) => { try { child.stdin.write(s + "\n"); } catch { /* gone */ } };
    const at = (us) => us / 1e6;
    const advance = (us) => { lastUs = Math.max(lastUs, us); if (!run.done) run.advanceTo(at(us)); };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    let idle = setTimeout(hung, idleMs);
    function hung() { timedOut = true; child.kill("SIGKILL"); }

    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(5) : "nan");
    let buf = "";
    child.stdout.on("data", (d) => {
      clearTimeout(idle); idle = setTimeout(hung, idleMs);
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        handle(line.trim().split(/\s+/));
      }
    });

    function handle(w) {
      const k = w[0];
      if (k === "B") {
        if (!booted) {
          // the sensors have a reading before the board's first look, as on real hardware
          booted = true; run.start();
          const t0 = 1 / run.cfg.rate;
          run.advanceTo(t0); lastUs = t0 * 1e6;
          reply(`C ${Math.round(lastUs)}`);
        }
        else {
          // a restart: every output dropped to LOW and every pin back to an input
          for (const pin of onAt.keys()) pinLog.push({ pin, val: 0, t: at(lastUs), restart: true });
          onAt.clear(); modes.clear();
          reply(`C ${Math.round(lastUs)}`); run.handleLine("$MBE,READY,virtual board");
        }
        return;
      }
      if (k === "M") { modes.set(+w[1], +w[2]); return; }
      if (k === "P") {
        const pin = +w[1], val = +w[2], us = +w[3];
        advance(us);
        const t = at(us);
        pinLog.push({ pin, val, t });
        const p = pins.get(pin);
        if (!p) return;
        if (val) {
          onAt.set(pin, t);
          if (modes.get(pin) !== 1) pinFindings.push({ label: "Pyro pin not an output", ok: false, expected: "pinMode(OUTPUT) before firing", actual: `pin ${pin} written HIGH while not an output`, detail: "On a real board this only turns on a weak pull-up, so the charge won't fire.", severity: "serious" });
          if (!armed()) pinFindings.push({ label: "Fired while disarmed", ok: false, expected: "nothing fires with the arm switch off", actual: `pin ${pin} at T${t - run.launchAt >= 0 ? "+" : "−"}${Math.abs(t - run.launchAt).toFixed(1)} s`, detail: "The arm switch is there so a charge can never fire while people handle the rocket.", severity: "critical" });
          else if (modes.get(pin) === 1) run._act(p.action, t, `pin ${pin}`, p.ch);
        } else if (onAt.has(pin)) {
          const dur = t - onAt.get(pin); onAt.delete(pin);
          if (dur > (task.maxPulse ?? 5)) pinFindings.push({ label: "Pyro left on", ok: false, expected: `off within ${task.maxPulse ?? 5} s`, actual: `pin ${pin} on for ${dur.toFixed(1)} s`, detail: "A channel left on drains the battery and can short through a burnt e-match.", severity: "serious" });
          if (dur < (task.minPulse ?? 0.05)) pinFindings.push({ label: "Pyro pulse too short", ok: false, expected: `at least ${((task.minPulse ?? 0.05) * 1000).toFixed(0)} ms`, actual: `${(dur * 1000).toFixed(0)} ms on pin ${pin}`, detail: "An e-match needs current for some milliseconds; a very short pulse may not light it.", severity: "serious" });
        }
        return;
      }
      if (k === "S") {
        const pin = +w[1], deg = +w[2], us = +w[3];
        advance(us);
        servoLog.push({ pin, deg, t: at(us) });
        const s = hw.servo;
        if (s && pin === s.pin) {
          const frac = (deg - s.closed) / ((s.open - s.closed) || 1);
          run.handleLine(`$MBA,${rocket.airbrakes?.name || "brake"},${Math.max(-0.5, Math.min(1.5, frac)).toFixed(4)}`);
        }
        return;
      }
      if (k === "T") {
        advance(+w[1]);
        if (pendingRestart) { pendingRestart = false; run.handleLine("$MBE,RESTARTING"); reply("R"); return; }
        if (run.done) { reply("E"); return; }
        const m = latest || {};
        reply(`D ${w[1]} ${fmt(m.p_pa)} ${fmt(m.temp_c)} ${fmt(b(m, "ax"))} ${fmt(b(m, "ay"))} ${fmt(b(m, "az"))} ${fmt(b(m, "gx"))} ${fmt(b(m, "gy"))} ${fmt(b(m, "gz"))} ${fmt(m.lat)} ${fmt(m.lon)} ${fmt(m.gps_alt)} ${armed() ? 1 : 0}`);
      }
    }

    child.on("exit", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(idle);
      const crashed = !run.done;
      const why = timedOut ? "The board stopped answering" : `The board stopped (${signal || "exit " + code})`;
      // the rocket flies on without its computer: grade what happens to it
      if (crashed) { run.advanceTo(run.cfg.maxTime + 1); if (!run.done) run.stop(why); }
      const rep = run.report({ fmtAlt, fmtVel });
      const extra = [...pinFindings];
      // pyro outputs left on at the end
      for (const [pin, t0] of onAt) {
        const dur = run.sim.t - t0;
        if (dur > (task.maxPulse ?? 5)) extra.push({ label: "Pyro left on", ok: false, expected: `off within ${task.maxPulse ?? 5} s`, actual: `pin ${pin} on for ${dur.toFixed(0)} s`, detail: "A channel left on drains the battery and can short through a burnt e-match.", severity: "serious" });
      }
      if (crashed) extra.push({ label: "Board kept running", ok: false, expected: "runs until landing", actual: why, detail: timedOut ? "It stopped asking for sensor readings: an endless loop that never calls delay() or millis()?" : stderr.slice(-300) || "", severity: "serious" });
      let checks = [...rep.checks, ...extra];
      let verdict = checks.every((c) => c.ok) && !rep.outcome.hardLanding ? "pass" : "fail";
      if (armMode === "never") {
        // disarmed: success is firing nothing at all; the crash is expected
        checks = [...extra.filter((c) => c.label === "Fired while disarmed" || c.label === "Board kept running"), ...rep.checks.filter((c) => c.label === "On the pad")];
        if (!checks.length) checks.push({ label: "Nothing fired while disarmed", ok: true, expected: "no pyro output", actual: "none", detail: "" });
        verdict = checks.every((c) => c.ok) ? "pass" : "fail";
      }
      const out = {
        test: test.id, name: test.name, verdict, checks, outcome: rep.outcome, endReason: rep.endReason,
        detections: rep.detections, pins: pinLog, servo: servoLog.slice(0, 2000), console: consoleText.slice(-20000),
        crashed, timedOut,
      };
      out.safety = classify(out, { disarmed: armMode === "never", tol: run.cfg.tol });
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
      resolve(out);
    });
    child.on("error", (e) => { stderr += String(e); });
  });
}
