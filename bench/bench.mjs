#!/usr/bin/env node
// The research bench: compile Arduino flight-computer sketches for a virtual
// board and fly them through Mockingbird's tests, unattended.
//
//   node bench/bench.mjs tasks
//   node bench/bench.mjs run    <sketch> --task dual-deploy [--tests a,b] [--seeds 3] [--out dir]
//   node bench/bench.mjs batch  <dir>    --task dual-deploy [--out dir]
//   node bench/bench.mjs mutate <sketch> --task dual-deploy [--max 150] [--all] [--from earlier.json] [--out dir]
//   node bench/bench.mjs bugs   <sketch> --task dual-deploy [--out dir]
//
// A sketch is a folder holding .ino files (Arduino IDE layout) or a single .ino.
// See bench/README.md.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, tmpdir } from "node:os";
import { build } from "./lib/build.mjs";
import { runTest } from "./lib/engine.mjs";
import { score } from "./lib/safety.mjs";
import { mutants, applyMutant } from "./lib/mutate.mjs";
import { exampleRockets } from "../web/shared/js/rockets.js";
import { defaultTests, testApplies } from "../web/shared/js/hil.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = process.env.BENCH_BUILD || join(tmpdir(), "aviary-bench-build");

// ------------------------------------------------------------ tasks and tests
export function loadTask(id) {
  const dir = join(HERE, "tasks", id);
  if (!existsSync(join(dir, "task.json"))) throw new Error(`no task "${id}" (try: ${listTasks().join(", ")})`);
  const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
  const rocket = exampleRockets().find((r) => r.id === task.rocket);
  if (!rocket) throw new Error(`task ${id}: no example rocket "${task.rocket}"`);
  return { task, rocket, site: task.site, dir };
}
export const listTasks = () => readdirSync(join(HERE, "tasks")).filter((d) => existsSync(join(HERE, "tasks", d, "task.json")));

// Tests only the bench can run (they need the pins, not the serial protocol).
const BENCH_TESTS = {
  disarmed: { id: "disarmed", name: "Arm switch off", note: "A full flight with the arm switch off. Nothing may fire.", bench: { arm: "never" }, faults: [] },
  "reboot-separation-tilted": { id: "reboot-separation-tilted", name: "Restart at separation, rail tilted", needsStages: 2, note: "The rail leans 25° and the board restarts 0.3 s after booster burnout, as the separation shock can brown a board out. Its attitude is gone with the restart and the rocket is past the tilt limit, so the sustainer must not light.", faults: [{ type: "rail_tilt", ref: "whole", offset: 0, duration: 0, params: { angle: 25, toward: 90 } }, { type: "reboot", ref: "burnout", offset: 0.3, duration: 0, params: {} }] },
  "reboot-ejection": { id: "reboot-ejection", name: "Restart after the drogue fires", note: "The board restarts 2 s after apogee, as the shock of an ejection charge can brown a board out. It must remember it is flying (not start over as if on the pad) and still fire the main at the right height, not at once.", faults: [{ type: "reboot", ref: "apogee", offset: 2, duration: 0, params: {} }] },
};

export function testsFor(task, rocket, only) {
  // a dud charge can only be survived with a backup channel for that device
  const hasBackup = (id) => task.hardware.pyro.filter((p) => p.action.type === "deploy" && p.action.id === id).length > 1;
  const apogeeDev = rocket.recovery.find((d) => d.deploy === "apogee")?.id;
  let tests = defaultTests(rocket).filter((t) => testApplies(t, rocket))
    .filter((t) => t.id !== "drogue-dud" || hasBackup(apogeeDev));
  tests = [...tests, ...(task.benchTests || []).map((id) => BENCH_TESTS[id]).filter((t) => t && testApplies(t, rocket))];
  if (only?.length) {
    const want = new Set(only);
    tests = tests.filter((t) => want.has(t.id));
    const missing = [...want].filter((id) => !tests.some((t) => t.id === id));
    if (missing.length) throw new Error(`unknown or inapplicable test(s): ${missing.join(", ")}`);
  }
  return tests;
}

// ------------------------------------------------------------ running
// Run jobs with a fixed number of workers (each test is its own process).
// `stop(result)` returning true ends the run early (jobs not started are dropped).
async function pool(jobs, n, fn, onDone, stop) {
  const out = new Array(jobs.length);
  let next = 0, done = 0, halted = false;
  async function worker() {
    while (next < jobs.length && !halted) {
      const i = next++;
      out[i] = await fn(jobs[i], i);
      onDone?.(++done, jobs.length, out[i]);
      if (stop?.(out[i])) halted = true;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
  return out.filter(Boolean);
}
const WORKERS = Number(process.env.BENCH_WORKERS) || Math.max(1, cpus().length);

// Build one sketch and run its tests. Returns a full record.
export async function evaluate(src, { task, rocket, site }, { tests, seeds = 1, quiet = false, label, stop } = {}) {
  const b = await build(src, BUILD_DIR);
  const rec = { sketch: label || src, task: task.id, compiled: b.ok, build: { errors: b.errors, warnings: b.warnings, hash: b.hash }, results: [], score: null };
  if (!b.ok) {
    rec.score = { ...score([]), compiled: false };
    return rec;
  }
  const jobs = [];
  for (const test of tests) for (let s = 1; s <= seeds; s++) jobs.push({ test, seed: s });
  rec.results = await pool(jobs, WORKERS, ({ test, seed }) => runTest({ bin: b.bin, task, rocket, site, test, seed }).then((r) => ({ ...r, seed })),
    quiet ? null : (d, n, r) => process.stderr.write(`  ${String(d).padStart(3)}/${n}  ${r.verdict === "pass" ? "pass" : "FAIL"}  ${r.safety.worst.padEnd(8)} ${r.name}${seeds > 1 ? ` (seed ${r.seed})` : ""}\n`), stop);
  rec.score = { ...score(rec.results), compiled: true };
  return rec;
}

// ------------------------------------------------------------ output
const pct = (x) => `${(100 * x).toFixed(0)}%`;
function summary(rec) {
  const s = rec.score;
  if (!rec.compiled) return `${rec.sketch}: did not compile\n  ${rec.build.errors.slice(0, 5).join("\n  ")}`;
  const lines = [`${rec.sketch}: ${s.passed}/${s.tests} passed (${pct(s.passRate)}), ${s.critical} critical, ${s.serious} serious → ${s.safe ? (s.sound ? "safe and sound" : "safe, not sound") : "UNSAFE"}`];
  for (const r of rec.results.filter((r) => r.verdict !== "pass")) {
    const bad = r.checks.filter((c) => !c.ok).map((c) => `${c.severity || "?"}: ${c.label} (${c.actual})`);
    lines.push(`  ✗ ${r.name}${r.seed > 1 ? ` [seed ${r.seed}]` : ""}: ${bad.join("; ")}`);
  }
  return lines.join("\n");
}
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function csvRows(recs) {
  const head = ["sketch", "task", "compiled", "tests", "passed", "pass_rate", "critical", "serious", "safe", "sound", "warnings"];
  const rows = recs.map((r) => [r.sketch, r.task, r.compiled, r.score.tests, r.score.passed, r.score.passRate.toFixed(3), r.score.critical, r.score.serious, r.score.safe, r.score.sound, r.build.warnings.length]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
// One row per (sketch, test) for analysis.
function csvTests(recs) {
  const head = ["sketch", "test", "seed", "verdict", "worst", "critical", "serious", "minor", "apogee_m", "landing_mps", "failed_checks"];
  const rows = [];
  for (const r of recs) for (const t of r.results) rows.push([r.sketch, t.test, t.seed, t.verdict, t.safety.worst, t.safety.critical, t.safety.serious, t.safety.minor,
    Number.isFinite(t.outcome?.apogee) ? t.outcome.apogee.toFixed(1) : "", Number.isFinite(t.outcome?.landingSpeed) ? t.outcome.landingSpeed.toFixed(1) : "",
    t.checks.filter((c) => !c.ok).map((c) => c.label).join("; ")]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
function save(out, name, recs, extra = {}) {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  // the per-test pin log and console make the JSON large; keep them, they're the evidence
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ when: new Date().toISOString(), ...extra, records: recs }, null, 1));
  writeFileSync(join(out, `${name}.csv`), csvRows(recs));
  writeFileSync(join(out, `${name}-tests.csv`), csvTests(recs));
  process.stderr.write(`Saved ${join(out, name)}.json, .csv and -tests.csv\n`);
}

// ------------------------------------------------------------ commands
function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; opt[k] = v; }
    else pos.push(a);
  }
  return { pos, opt };
}

// The sketches in a folder: every sub-folder with an .ino, and loose .ino files.
function sketchesIn(dir) {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (readdirSync(p).some((x) => x.endsWith(".ino"))) out.push(p); }
    else if (f.endsWith(".ino")) out.push(p);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = args(rest);
  if (!cmd || cmd === "help" || opt.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 12).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (cmd === "tasks") {
    for (const id of listTasks()) { const { task, rocket } = loadTask(id); console.log(`${id.padEnd(14)} ${task.title}  [${testsFor(task, rocket).length} tests]`); }
    return;
  }
  const T = loadTask(opt.task || "dual-deploy");
  const tests = testsFor(T.task, T.rocket, opt.tests ? String(opt.tests).split(",") : null);
  const seeds = Number(opt.seeds) || 1;
  const out = opt.out ? resolve(opt.out) : null;

  if (cmd === "run") {
    const src = resolve(pos[0] || "");
    const rec = await evaluate(src, T, { tests, seeds, label: basename(src) });
    console.log(summary(rec));
    save(out, rec.sketch.replace(/\.ino$/, ""), [rec], { task: T.task.id });
    process.exitCode = rec.compiled && rec.score.safe ? 0 : 1;
    return;
  }

  if (cmd === "batch") {
    const list = sketchesIn(resolve(pos[0] || "."));
    if (!list.length) throw new Error("no sketches found");
    const recs = [];
    for (const src of list) {
      process.stderr.write(`${basename(src)}\n`);
      const rec = await evaluate(src, T, { tests, seeds, label: basename(src) });
      console.log(summary(rec));
      recs.push(rec);
    }
    const ok = recs.filter((r) => r.compiled);
    console.log(`\n${recs.length} sketches: ${ok.length} compiled, ${ok.filter((r) => r.score.safe).length} safe, ${ok.filter((r) => r.score.sound).length} safe and sound, ${ok.filter((r) => r.score.passRate === 1).length} passed every test`);
    save(out, "batch", recs, { task: T.task.id, tests: tests.map((t) => t.id), seeds });
    return;
  }

  if (cmd === "mutate" || cmd === "bugs") {
    // Planted bugs: does the test suite notice when the code is made worse?
    const src = resolve(pos[0] || "");
    const base = await evaluate(src, T, { tests, quiet: true, label: "original" });
    if (!base.compiled) throw new Error("the original sketch doesn't compile:\n" + base.build.errors.join("\n"));
    const baseFail = new Set(base.results.filter((r) => r.verdict !== "pass").map((r) => r.test));
    console.log(summary(base));
    let list, prev = null, runTests = tests;
    if (opt.from) {
      // re-run only what survived an earlier run, on the tests that run didn't have:
      // the tests are deterministic, so a mutant killed then is still killed
      prev = JSON.parse(readFileSync(resolve(opt.from), "utf8"));
      const had = new Set(prev.tests);
      runTests = tests.filter((t) => !had.has(t.id));
      if (!runTests.length) throw new Error("no new tests since that run");
      list = prev.mutants.filter((r) => r.status === "survived").map((r) => r.mutant);
      process.stderr.write(`Re-running ${list.length} survivors on ${runTests.map((t) => t.id).join(", ")}\n`);
    } else if (cmd === "bugs") {
      const file = opt.bugs ? resolve(opt.bugs) : join(T.dir, "bugs.json");
      list = JSON.parse(readFileSync(file, "utf8"));
    } else {
      list = mutants(src, { max: Number(opt.max) || 150, seed: Number(opt.seed) || 1 });
    }
    process.stderr.write(`${list.length} ${cmd === "bugs" ? "planted bugs" : "mutants"}\n`);
    const work = join(BUILD_DIR, "mutants", basename(src));
    const recs = [];
    let i = 0;
    for (const m of list) {
      i++;
      let dir;
      try { dir = applyMutant(src, m, join(work, `m${String(i).padStart(4, "0")}`)); }
      catch (e) { recs.push({ mutant: m, status: "not applied", why: e.message }); process.stderr.write(`  ${i}/${list.length} not applied: ${e.message}\n`); continue; }
      // mutants stop at the first test that catches them unless --all; curated bugs run everything
      const fast = cmd === "mutate" && !opt.all;
      const rec = await evaluate(dir, T, { tests: runTests, quiet: true, label: m.id || `m${i}`, stop: fast ? (r) => r.verdict !== "pass" && !baseFail.has(r.test) : null });
      // killed: the suite noticed (compile error, or a test that passed now fails)
      let status;
      if (!rec.compiled) status = "no compile";
      else {
        const newly = rec.results.filter((r) => r.verdict !== "pass" && !baseFail.has(r.test));
        status = newly.length ? "killed" : "survived";
        rec.killedBy = newly.map((r) => r.test);
        rec.worst = newly.reduce((w, r) => (["none", "minor", "serious", "critical"].indexOf(r.safety.worst) > ["none", "minor", "serious", "critical"].indexOf(w) ? r.safety.worst : w), "none");
      }
      recs.push({ mutant: m, status, killedBy: rec.killedBy || [], worst: rec.worst || "", score: rec.score });
      process.stderr.write(`  ${String(i).padStart(3)}/${list.length} ${status.padEnd(10)} ${m.id || ""} ${m.desc}${rec.killedBy?.length ? `  ← ${rec.killedBy.slice(0, 3).join(", ")}` : ""}\n`);
    }
    if (prev) {
      // merge: everything from before, with the survivors' new verdicts
      const now = new Map(recs.map((r) => [r.mutant.id, r]));
      recs.length = 0;
      for (const r of prev.mutants) recs.push(now.get(r.mutant.id) || r);
    }
    const valid = recs.filter((r) => r.status === "killed" || r.status === "survived");
    const killed = valid.filter((r) => r.status === "killed").length;
    console.log(`\n${cmd === "bugs" ? "Planted bugs" : "Mutants"}: ${valid.length} that compile, ${killed} caught (${pct(valid.length ? killed / valid.length : 0)}), ${valid.length - killed} missed; ${recs.filter((r) => r.status === "no compile").length} didn't compile`);
    const surv = valid.filter((r) => r.status === "survived");
    if (surv.length) console.log("Missed:\n" + surv.map((r) => `  ${r.mutant.id || ""} line ${r.mutant.line}: ${r.mutant.desc}`).join("\n"));
    if (out) {
      mkdirSync(out, { recursive: true });
      const name = `${cmd}-${basename(src).replace(/\.ino$/, "")}`;
      writeFileSync(join(out, `${name}.json`), JSON.stringify({ when: new Date().toISOString(), task: T.task.id, tests: tests.map((t) => t.id), original: base.score, mutants: recs }, null, 1));
      const head = ["id", "line", "operator", "description", "status", "worst", "caught_by"];
      writeFileSync(join(out, `${name}.csv`), [head, ...recs.map((r) => [r.mutant.id || "", r.mutant.line, r.mutant.op, r.mutant.desc, r.status, r.worst || "", (r.killedBy || []).join("; ")])].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
      process.stderr.write(`Saved ${join(out, name)}.json and .csv\n`);
    }
    return;
  }
  throw new Error(`unknown command "${cmd}" (run, batch, mutate, bugs, tasks)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(2); });
}
