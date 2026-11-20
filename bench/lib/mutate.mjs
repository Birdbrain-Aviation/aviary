// Planted bugs ("mutants"): small, mechanical changes to a sketch that a good
// test suite should notice. Each mutant changes one thing in one place:
//
//   rel     a comparison:   <  ↔ <=,  >  ↔ >=,  < ↔ >,  == ↔ !=
//   const   a number:       ×0.5 and ×2 (0 becomes 1)
//   arith   arithmetic:     + ↔ -,  * ↔ /,  += ↔ -=
//   logic   && ↔ ||,  true ↔ false,  !x → x
//   delete  a whole statement removed (calls and assignments, not declarations)
//
// The mutation score (the share of compiling mutants that some test catches)
// measures the tests, not the sketch: it says how much a "pass" is worth.
// A mutant that survives is either a gap in the tests or a change that makes
// no difference (an "equivalent mutant"); the report lists survivors so a
// person can tell which.
//
// Curated bugs (tasks/<task>/bugs.json) are the same idea written by hand:
// { "id", "desc", "find", "replace" } with `find` occurring exactly once, or
// { "id", "desc", "edits": [{ "find", "replace" }, ...] } for a bug that
// touches several places.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

// Blank comments, strings, character literals and preprocessor lines (same
// length, newlines kept) so the scanner sees only code.
export function codeOnly(s) {
  let out = "", i = 0, lineStart = true;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (lineStart && c === "#") { while (i < s.length && s[i] !== "\n") { out += " "; if (s[i] === "\\" && s[i + 1] === "\n") { out += "\n"; i++; } i++; } continue; }
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") { while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) { out += s[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; out += " "; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") { out += " "; i++; } out += s[i] === "\n" ? "\n" : " "; i++; }
      out += " "; i++; lineStart = false; continue;
    }
    if (c === "\n") lineStart = true; else if (!/\s/.test(c)) lineStart = false;
    out += c; i++;
  }
  return out;
}

const DECL = /^(?:static\s+|const\s+|constexpr\s+|volatile\s+|unsigned\s+|signed\s+)*(?:void|bool|boolean|char|byte|int|long|short|float|double|size_t|String|auto|u?int(?:8|16|32|64)_t|sensors_event_t|File|struct\s+\w+|enum\s+\w+)\b(?!\s*\()/;

// Statements whose removal can't change a flight on this bench: printing, and
// sensor settings the virtual sensors don't model (oversampling, filters, bus
// speed). Deleting them would only add equivalent mutants.
const NO_EFFECT = /^(?:Serial\d?\.\w+|Wire\d?\.(?:begin|setClock)|\w+\.(?:set(?:Temperature|Pressure)Oversampling|setIIRFilterCoeff|setOutputDataRate|setFilterBandwidth|setSampleRateDivisor|setHighPassFilter))\s*\(/;

// All candidate mutations in one file's text.
export function findMutations(text, file) {
  const code = codeOnly(text);
  const out = [];
  const lineOf = (pos) => text.slice(0, pos).split("\n").length;
  const add = (pos, len, to, op, desc) => out.push({ file, pos, len, from: text.slice(pos, pos + len), to, op, line: lineOf(pos), desc });
  const prevSig = (i) => { let j = i - 1; while (j >= 0 && /\s/.test(code[j])) j--; return j >= 0 ? code[j] : ""; };
  const prevWord = (i) => { let j = i - 1; while (j >= 0 && /\s/.test(code[j])) j--; let k = j; while (k >= 0 && /\w/.test(code[k])) k--; return code.slice(k + 1, j + 1); };

  // depth tracking so we know which top-level braces are function bodies
  let depth = 0, angle = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i], n = code[i + 1] || "", p = code[i - 1] || "";
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; continue; }
    // numbers (not part of an identifier; hex left alone)
    if (/\d/.test(c) && !/[\w.]/.test(p)) {
      const m = code.slice(i).match(/^(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)([fFuUlL]*)/);
      if (m && !/^0[xXbB]/.test(code.slice(i, i + 2))) {
        const lit = m[1], suffix = m[2], v = Number(lit), isF = /[.eE]/.test(lit);
        // skip array indexes and sizes: the usual result is a crash, not a flight bug
        const inBracket = p === "[" || prevSig(i) === "[";
        // a baud rate or bus address can't change how the rocket flies
        const setup = /\.begin\w*\s*\(\s*$/.test(code.slice(Math.max(0, i - 24), i));
        if (!inBracket && !setup) {
          const fmt = (x) => (isF ? (Number.isInteger(x) ? x.toFixed(1) : String(+x.toPrecision(6))) : String(Math.round(x))) + suffix;
          const seen = new Set([lit + suffix]);
          for (const [x, why] of v === 0 ? [[1, "0 → 1"]] : [[v * 0.5, "halved"], [v * 2, "doubled"]]) {
            const to = fmt(x);
            if (seen.has(to)) continue;
            seen.add(to);
            add(i, m[0].length, to, "const", `${lit}${suffix} ${why} (${to})`);
          }
        }
        i += m[0].length - 1;
        continue;
      }
    }
    if (depth === 0) continue; // operators only inside function bodies and initialisers below
    const two = c + n;
    if (two === "->" || two === "<<" || two === ">>" || two === "::") { i++; continue; }
    if (two === "&&") { add(i, 2, "||", "logic", "&& → ||"); i++; continue; }
    if (two === "||") { add(i, 2, "&&", "logic", "|| → &&"); i++; continue; }
    if (two === "==") { add(i, 2, "!=", "rel", "== → !="); i++; continue; }
    if (two === "!=") { add(i, 2, "==", "rel", "!= → =="); i++; continue; }
    if (two === "<=") { add(i, 2, "<", "rel", "<= → <"); add(i, 2, ">", "rel", "<= → >"); i++; continue; }
    if (two === ">=") { add(i, 2, ">", "rel", ">= → >"); add(i, 2, "<", "rel", ">= → <"); i++; continue; }
    if (two === "+=") { add(i, 2, "-=", "arith", "+= → -="); i++; continue; }
    if (two === "-=") { add(i, 2, "+=", "arith", "-= → +="); i++; continue; }
    if (two === "++" || two === "--" || two === "*=" || two === "/=" || two === "|=" || two === "&=") { i++; continue; }
    if (c === "<" || c === ">") {
      // a template argument list (min<int>(...)) isn't a comparison
      if (c === "<" && /\w/.test(p) && /^<\s*[\w:]+\s*>/.test(code.slice(i))) { angle++; continue; }
      if (c === ">" && angle) { angle--; continue; }
      add(i, 1, c + "=", "rel", `${c} → ${c}=`);
      add(i, 1, c === "<" ? ">" : "<", "rel", `${c} → ${c === "<" ? ">" : "<"}`);
      continue;
    }
    if ("+-*/".includes(c) && n !== "=") {
      const ps = prevSig(i);
      const binary = /[\w)\]]/.test(ps) && !/^(return|case)$/.test(prevWord(i));
      if (!binary) continue;
      // a pointer declaration (Type* name): only a type name before the *
      if (c === "*" && /^(?:(?:const|static|volatile|struct|unsigned)\s+)*[A-Za-z_][\w:]*(?:<[^<>]*>)?\s*$/.test(code.slice(Math.max(code.lastIndexOf("\n", i), code.lastIndexOf(";", i), code.lastIndexOf("{", i), code.lastIndexOf("(", i), code.lastIndexOf(",", i)) + 1, i).trimStart())) continue;
      const to = { "+": "-", "-": "+", "*": "/", "/": "*" }[c];
      add(i, 1, to, "arith", `${c} → ${to}`);
      continue;
    }
    if (c === "!" && n !== "=") { add(i, 1, "", "logic", "! removed"); continue; }
    if (/[tf]/.test(c) && !/\w/.test(p)) {
      if (code.startsWith("true", i) && !/\w/.test(code[i + 4] || "")) { add(i, 4, "false", "logic", "true → false"); i += 3; continue; }
      if (code.startsWith("false", i) && !/\w/.test(code[i + 5] || "")) { add(i, 5, "true", "logic", "false → true"); i += 4; continue; }
    }
  }

  // statement deletion inside function bodies
  depth = 0;
  let start = -1, paren = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{") { depth++; start = i + 1; }
    else if (c === "}") { depth--; start = i + 1; }
    else if (c === ";" && paren === 0) {
      if (depth > 0 && start >= 0) {
        const raw = code.slice(start, i);
        // a case label belongs to the switch, not the statement after it
        const lab = raw.match(/^\s*(?:(?:case\b[^:]*|default)\s*:(?!:)\s*)+/);
        const body = lab ? raw.slice(lab[0].length) : raw;
        const st = body.trim();
        const s0 = start + (lab ? lab[0].length : 0) + body.indexOf(st);
        // a call or an assignment, and not the whole body of an if/else/for/while
        const head = code.slice(Math.max(0, start - 40), start).trimEnd();
        const governed = /\)\s*$/.test(head) && !/;\s*$/.test(head) || /\belse\s*$/.test(head);
        if (st && !governed && !NO_EFFECT.test(st) && !DECL.test(st) && !/^(return|break|continue|case|default|goto)\b/.test(st) && /\(|=/.test(st)) {
          const shown = text.slice(s0, i + 1).replace(/\s+/g, " ");
          add(s0, i + 1 - s0, ";", "delete", `deleted: ${shown.length > 70 ? shown.slice(0, 67) + "..." : shown}`);
        }
      }
      start = i + 1;
    }
  }
  return out.sort((a, b) => a.pos - b.pos);
}

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Mutants for a sketch (folder or .ino). When there are more than `max`, a
// seeded random sample, spread across the operator kinds.
export function mutants(src, { max = 150, seed = 1 } = {}) {
  const files = statSync(src).isDirectory() ? readdirSync(src).filter((f) => f.endsWith(".ino")).sort() : [basename(src)];
  const dir = statSync(src).isDirectory() ? src : join(src, "..");
  let all = [];
  for (const f of files) all.push(...findMutations(readFileSync(join(dir, f), "utf8"), f));
  if (all.length > max) {
    const R = rng(seed);
    const byOp = {};
    for (const m of all) (byOp[m.op] ||= []).push(m);
    for (const k in byOp) byOp[k].sort(() => R() - 0.5);
    const keys = Object.keys(byOp).sort();
    const pick = [];
    while (pick.length < max) for (const k of keys) { if (byOp[k].length && pick.length < max) pick.push(byOp[k].shift()); }
    all = pick.sort((a, b) => (a.file === b.file ? a.pos - b.pos : a.file.localeCompare(b.file)));
  }
  return all.map((m, i) => ({ ...m, id: `M${String(i + 1).padStart(3, "0")}` }));
}

// Write a copy of the sketch with one mutant applied; returns the new folder.
// The folder is named after the original so the .ino still matches it.
export function applyMutant(src, m, outDir) {
  const isDir = statSync(src).isDirectory();
  const dir = isDir ? src : join(src, "..");
  const name = isDir ? basename(src) : basename(src, ".ino");
  const files = isDir ? readdirSync(src).filter((f) => statSync(join(src, f)).isFile()) : [basename(src)];
  const target = join(outDir, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  let applied = false;
  // curated bugs: { find, replace } or { edits: [{ find, replace }, ...] }
  const edits = m.edits ? m.edits.map((e) => ({ ...e })) : m.find !== undefined ? [{ find: m.find, replace: m.replace }] : null;
  for (const f of files) {
    let text = readFileSync(join(dir, f), "utf8");
    const destName = isDir ? f : `${name}.ino`;
    if (edits) {
      // a curated bug: each edit's text exactly once (in whichever file has it)
      for (const e of edits) {
        const n = text.split(e.find).length - 1;
        if (n > 1) throw new Error(`"${e.find.slice(0, 40)}" occurs ${n} times in ${f}`);
        if (n === 1) {
          if (e.done) throw new Error(`"${e.find.slice(0, 40)}" occurs in more than one file`);
          if (m.line === undefined) m.line = text.slice(0, text.indexOf(e.find)).split("\n").length;
          text = text.replace(e.find, () => e.replace);
          e.done = true;
        }
      }
    } else if (f === m.file) {
      if (text.slice(m.pos, m.pos + m.len) !== m.from) throw new Error(`the sketch changed since the mutants were listed (${f}:${m.line})`);
      text = text.slice(0, m.pos) + m.to + text.slice(m.pos + m.len);
      applied = true;
    }
    writeFileSync(join(target, destName), text);
  }
  if (edits) { const miss = edits.find((e) => !e.done); if (miss) throw new Error(`"${miss.find.slice(0, 40)}" not found`); applied = true; }
  if (!applied) throw new Error(`no file ${m.file}`);
  m.op ||= "curated";
  return target;
}
