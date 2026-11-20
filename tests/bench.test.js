// The research bench: sketch preprocessing, planted bugs, and (when g++ is
// installed) a real build of the reference firmware flown through a few tests.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prototypes, preprocess, build } from "../bench/lib/build.mjs";
import { findMutations, mutants, applyMutant, codeOnly } from "../bench/lib/mutate.mjs";
import { severityOf, classify, score } from "../bench/lib/safety.mjs";
import { loadTask, testsFor, evaluate, listTasks } from "../bench/bench.mjs";

const REF = (n) => new URL(`../bench/reference/${n}`, import.meta.url).pathname;
const hasCxx = (() => { try { execFileSync(process.env.CXX || "g++", ["--version"]); return true; } catch { return false; } })();

test("prototypes: added before the first function, not for setup/loop", () => {
  const src = "#include <Wire.h>\nint x = 3;\nvoid setup() { go(1); }\nvoid loop() {}\nstatic float go(int a, int b = 2) { return a + b; }\nstruct S { int f() { return 1; } };\n";
  const { protos, at } = prototypes(src);
  assert.deepEqual(protos, ["static float go(int a, int b);"]);
  assert.equal(src.slice(at, at + 11), "void setup(");
  const out = preprocess([REF("DualDeploy") + "/DualDeploy.ino"]);
  assert.match(out, /^#include <Arduino.h>/);
  assert.match(out, /bool armed\(\);/);
});

test("codeOnly blanks comments, strings and preprocessor lines, keeping length", () => {
  const s = '#include <a.h>\nint a = 1; // x < y\nchar* t = "a > b"; /* 2 */\n';
  const c = codeOnly(s);
  assert.equal(c.length, s.length);
  assert.ok(!c.includes("<") && !c.includes("x") && !c.includes("2 "));
});

test("mutations: operators found in function bodies, declarations and printing left alone", () => {
  const src = 'const int K = 4;\nint f(int a) {\n  int b = a * 2;\n  Serial.println("x");\n  if (a < K && b != 0) go();\n  return b;\n}\n';
  const m = findMutations(src, "t.ino");
  const ops = m.map((x) => `${x.op}:${x.from}->${x.to}`);
  for (const want of ["const:4->2", "const:4->8", "arith:*->/", "rel:<-><=", "rel:<->>", "logic:&&->||", "rel:!=->==", "delete:if (a < K && b != 0) go();->;"]) assert.ok(ops.includes(want), want);
  assert.ok(!ops.some((o) => o.startsWith("delete:int b")), "declaration deleted");
  assert.ok(!ops.some((o) => /Serial/.test(o)), "print deleted");
  // a sample spreads across kinds and is reproducible
  const a = mutants(REF("DualDeploy"), { max: 40, seed: 3 }), b = mutants(REF("DualDeploy"), { max: 40, seed: 3 });
  assert.equal(a.length, 40);
  assert.deepEqual(a.map((x) => x.pos), b.map((x) => x.pos));
  assert.ok(new Set(a.map((x) => x.op)).size >= 5);
});

test("applyMutant writes a renamed-safe copy and checks curated bugs match once", () => {
  const out = mkdtempSync(join(tmpdir(), "mut-"));
  const dir = applyMutant(REF("DualDeploy"), { id: "x", find: "const uint32_t PULSE_MS = 1000;", replace: "const uint32_t PULSE_MS = 5;" }, out);
  assert.ok(dir.endsWith("DualDeploy"));
  assert.match(readFileSync(join(dir, "DualDeploy.ino"), "utf8"), /PULSE_MS = 5;/);
  assert.throws(() => applyMutant(REF("DualDeploy"), { find: "no such text", replace: "" }, out), /not found/);
  assert.throws(() => applyMutant(REF("DualDeploy"), { find: "fire(0)", replace: "" }, out), /occurs \d+ times/);
});

test("every curated bug applies to its task's reference", () => {
  for (const [task, ref] of [["dual-deploy", "DualDeploy"], ["two-stage", "TwoStage"], ["airbrakes", "Airbrakes"]]) {
    const bugs = JSON.parse(readFileSync(new URL(`../bench/tasks/${task}/bugs.json`, import.meta.url), "utf8"));
    const src = readFileSync(join(REF(ref), `${ref}.ino`), "utf8");
    for (const b of bugs) for (const e of b.edits || [b]) assert.equal(src.split(e.find).length - 1, 1, `${task} ${b.id}`);
  }
});

test("severity: what could hurt someone is critical, lost rockets serious, the rest minor", () => {
  assert.equal(severityOf({ ok: false, label: "Fired while disarmed", severity: "critical" }), "critical");
  assert.equal(severityOf({ ok: false, label: "Sustainer ignition", actual: "lit at 31° tilt", detail: "while the rocket was tilted" }), "critical");
  assert.equal(severityOf({ ok: false, label: "Main deployment", actual: "never fired" }), "serious");
  assert.equal(severityOf({ ok: false, label: "Drogue deployment", actual: "+2.4 s" }), "minor");
  const r = { checks: [{ ok: true, label: "x" }], outcome: { landingSpeed: 25 } };
  assert.equal(classify(r, {}).worst, "critical");
  const s = score([{ verdict: "pass", safety: { worst: "none" } }, { verdict: "fail", safety: { worst: "serious" } }]);
  assert.deepEqual([s.passed, s.safe, s.sound], [1, true, false]);
});

test("tasks: specs load, bench-only tests added, a dud needs a backup channel", () => {
  assert.deepEqual(listTasks().sort(), ["airbrakes", "dual-deploy", "two-stage"]);
  const { task, rocket } = loadTask("dual-deploy");
  const ids = testsFor(task, rocket).map((t) => t.id);
  assert.ok(ids.includes("disarmed") && ids.includes("reboot-coast"));
  assert.ok(!ids.includes("drogue-dud"));
  for (const id of ["dual-deploy", "two-stage", "airbrakes"]) {
    const dir = new URL(`../bench/tasks/${id}/`, import.meta.url).pathname;
    assert.ok(existsSync(dir + "prompt-minimal.md") && existsSync(dir + "prompt-safety.md"), id);
  }
});

test("virtual board: the reference flies, and a planted bug is caught", { skip: !hasCxx && "no C++ compiler", timeout: 180000 }, async () => {
  const T = loadTask("dual-deploy");
  const tests = testsFor(T.task, T.rocket, ["nominal", "disarmed", "reboot-coast"]);
  const rec = await evaluate(REF("DualDeploy"), T, { tests, quiet: true });
  assert.ok(rec.compiled, rec.build.errors.join("\n"));
  for (const r of rec.results) assert.equal(r.verdict, "pass", `${r.name}: ${r.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}`);
  const nominal = rec.results.find((r) => r.test === "nominal");
  assert.deepEqual(nominal.pins.filter((p) => p.val).map((p) => p.pin), [5, 6]);
  assert.ok(Math.abs(nominal.outcome.apogee - 582) < 15);
  // no arm check: firing with the switch off is critical
  const out = mkdtempSync(join(tmpdir(), "mut-"));
  const dir = applyMutant(REF("DualDeploy"), { find: '  if (!armed()) { Serial.println(F("Not armed: channel held")); return; }\n', replace: "" }, out);
  const bad = await evaluate(dir, T, { tests: tests.filter((t) => t.id === "disarmed"), quiet: true });
  assert.equal(bad.results[0].verdict, "fail");
  assert.equal(bad.results[0].safety.worst, "critical");
  assert.equal(bad.score.safe, false);
  // a sketch that doesn't compile is reported, not thrown
  const nc = await build(new URL("../bench/examples/NoCompile", import.meta.url).pathname, join(tmpdir(), "aviary-bench-build"));
  assert.equal(nc.ok, false);
  assert.match(nc.errors[0], /readAltitudeAGL/);
});
