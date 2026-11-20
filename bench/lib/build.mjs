// Compile an Arduino sketch to run on this PC against the virtual board.
//
// Like the Arduino IDE: the sketch's .ino files are joined (the one named after
// the folder first), Arduino.h is included at the top, and prototypes are
// added for functions that are used before they're defined. Other .cpp/.h
// files in the sketch folder are compiled too.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const CORE = resolve(HERE, "../core");
const CXX = process.env.CXX || "g++";
const FLAGS = ["-std=gnu++17", "-O1", "-Wall", "-Wextra", "-Wno-unused-parameter", "-fno-diagnostics-color", "-I", CORE];

// The sketch's source files: { main: text of the joined .ino, extra: [paths] }
export function sketchFiles(src) {
  const st = statSync(src);
  if (st.isFile()) return { name: basename(src, extname(src)), inos: [src], extra: [] };
  const all = readdirSync(src).sort();
  const name = basename(resolve(src));
  const inos = all.filter((f) => f.endsWith(".ino")).map((f) => join(src, f));
  if (!inos.length) throw new Error(`no .ino file in ${src}`);
  inos.sort((a, b) => (basename(a, ".ino") === name ? -1 : basename(b, ".ino") === name ? 1 : a.localeCompare(b)));
  return { name, inos, extra: all.filter((f) => /\.(cpp|c|h|hpp)$/.test(f)).map((f) => join(src, f)) };
}

// Blank out comments, strings and character literals (same length), so the
// scanner below sees only code.
function codeOnly(s) {
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") { while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) { out += s[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; out += " "; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") { out += " "; i++; } out += s[i] === "\n" ? "\n" : " "; i++; }
      out += " "; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// Prototypes for the top-level functions, and where to put them (just before
// the first function definition, as the Arduino IDE does).
export function prototypes(src) {
  const code = codeOnly(src);
  const protos = [];
  let depth = 0, stmtStart = 0, firstAt = -1, paren = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{") {
      if (depth === 0) {
        const head = code.slice(stmtStart, i);
        const m = head.match(/^\s*((?:template\s*<[^>]*>\s*)?(?:(?:static|inline|unsigned|signed|const|volatile|long|short|struct|enum|extern)\s+)*[A-Za-z_][\w:]*(?:\s*<[^;{}()]*>)?[\s\*&]+)([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*(const)?\s*$/s);
        if (m && !/^\s*(struct|class|enum|union|namespace|typedef)\b/.test(head) && !/^(if|for|while|switch|return|else|do)$/.test(m[2]) && !/=\s*$/.test(head.trim())) {
          if (firstAt < 0) firstAt = stmtStart + (head.length - head.trimStart().length);
          if (m[2] !== "setup" && m[2] !== "loop") {
            // no default arguments in the prototype
            const params = splitTop(m[3]).map((p) => p.replace(/=[^]*$/, "").trim()).join(", ");
            protos.push(`${m[1].replace(/\s+/g, " ").trim()} ${m[2]}(${params})${m[4] ? " const" : ""};`);
          }
        }
      }
      depth++;
    } else if (c === "}") { depth--; if (depth === 0) stmtStart = i + 1; }
    else if (depth === 0 && paren === 0 && c === ";") stmtStart = i + 1;
    else if (depth === 0 && c === "#" && (i === 0 || code[i - 1] === "\n")) { while (i < code.length && code[i] !== "\n") i++; stmtStart = i + 1; }
  }
  return { protos, at: firstAt };
}
function splitTop(s) {
  const out = []; let d = 0, cur = "";
  for (const c of s) { if (c === "<" || c === "(") d++; if (c === ">" || c === ")") d--; if (c === "," && d === 0) { out.push(cur); cur = ""; } else cur += c; }
  if (cur.trim()) out.push(cur);
  return out;
}

// The joined .ino, ready to compile as C++.
export function preprocess(inos) {
  const parts = inos.map((f) => ({ f, text: readFileSync(f, "utf8") }));
  let joined = "", lineMap = [];
  for (const p of parts) { joined += `#line 1 "${basename(p.f)}"\n${p.text}\n`; }
  const { protos, at } = prototypes(joined);
  if (at >= 0 && protos.length) {
    // keep line numbers right for the compiler's messages
    const before = joined.slice(0, at);
    const lineNo = before.split("\n").length;
    const file = [...before.matchAll(/#line 1 "([^"]+)"/g)].pop()?.[1] || "sketch.ino";
    const fileStart = before.lastIndexOf(`#line 1 "${file}"`);
    const lineInFile = before.slice(fileStart).split("\n").length - 1;
    joined = `${before}${protos.join(" ")}\n#line ${lineInFile} "${file}"\n${joined.slice(at)}`;
    void lineNo; void lineMap;
  }
  return `#include <Arduino.h>\n${joined}`;
}

let coreObj = null;
async function core(outDir) {
  if (coreObj) return coreObj;
  const files = readdirSync(CORE).filter((f) => /\.(h|cpp)$/.test(f)).sort();
  const hash = createHash("sha1").update(files.map((f) => readFileSync(join(CORE, f))).join("\0")).digest("hex").slice(0, 12);
  const dir = join(outDir, "core-" + hash);
  mkdirSync(dir, { recursive: true });
  const obj = join(dir, "main.o");
  if (!existsSync(obj)) await run(CXX, [...FLAGS, "-c", join(CORE, "main.cpp"), "-o", obj], { maxBuffer: 1 << 24 });
  coreObj = obj;
  return obj;
}

// Build a sketch. Returns { ok, bin, errors, warnings: [..], log, name, hash }.
export async function build(src, outDir) {
  const files = sketchFiles(src);
  const text = preprocess(files.inos);
  const hash = createHash("sha1").update(text).update(files.extra.map((f) => readFileSync(f)).join("\0")).digest("hex").slice(0, 12);
  const dir = join(outDir, `${files.name}-${hash}`);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "board");
  const cpp = join(dir, `${files.name}.ino.cpp`);
  writeFileSync(cpp, text);
  for (const f of files.extra) copyFileSync(f, join(dir, basename(f)));
  const sources = [cpp, ...files.extra.filter((f) => /\.(cpp|c)$/.test(f)).map((f) => join(dir, basename(f)))];
  const result = { name: files.name, hash, bin, ok: false, errors: [], warnings: [], log: "" };
  if (existsSync(bin) && existsSync(join(dir, "build.json"))) return { ...JSON.parse(readFileSync(join(dir, "build.json"), "utf8")), bin };
  try {
    const coreO = await core(outDir);
    const r = await run(CXX, [...FLAGS, "-I", dir, ...sources, coreO, "-o", bin, "-lm"], { maxBuffer: 1 << 24 });
    result.log = r.stderr;
    result.ok = true;
  } catch (e) {
    result.log = e.stderr || String(e);
  }
  const msgs = result.log.split("\n").filter((l) => /: (error|warning): /.test(l));
  result.errors = msgs.filter((l) => /: error: /.test(l)).map(clean);
  result.warnings = msgs.filter((l) => /: warning: /.test(l) && /\.ino:/.test(l)).map(clean);
  writeFileSync(join(dir, "build.json"), JSON.stringify({ ...result, bin: undefined }, null, 1));
  return result;
  function clean(l) { return l.replace(dir + "/", "").replace(/^.*?([\w.-]+\.ino:\d+)/, "$1"); }
}
