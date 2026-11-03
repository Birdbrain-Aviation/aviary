// Reads flight logs from any flight computer or simulator export (CSV, TSV,
// semicolon or space separated, OpenRocket exports with "#" headers) and
// turns them into a standard flight in SI units.

import { autoMap, ROLE_BY_ID, conversion, unitLabel } from "./fields.js";
import { G0 } from "./units.js";

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const isNum = (s) => NUM.test(s);
// "no data" placeholders some loggers write (e.g. Altus Metrum's GPS before a fix)
const SENTINELS = new Set([2147483647, -2147483648, 4294967295, 2147482245]);
// 2021-10-15 16:12:50.123 or 2021-10-15T16:12:50Z
const DATETIME = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/;

function median(a) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function parseLogText(text, name = "") {
  text = text.replace(/^﻿/, "");
  const lines = text.split(/\r\n|\n|\r/);
  const warnings = [];
  const events = [];
  const comments = [];
  const body = [];
  let format = "csv";

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const s = L.trim();
    if (!s) continue;
    if (s.startsWith("#") || s.startsWith("//")) {
      const c = s.replace(/^(#|\/\/)\s*/, "");
      const ev = c.match(/^Event\s+(\w+)\s+occurred at t=([-\d.e]+)\s*seconds/i);
      if (ev) { events.push({ t: Number(ev[2]), label: ev[1].replace(/_/g, " ").toLowerCase().replace(/^\w/, (x) => x.toUpperCase()), source: "file", raw: ev[1] }); format = "openrocket"; continue; }
      comments.push({ i, text: c });
      continue;
    }
    body.push({ i, text: s });
  }
  if (!body.length) throw new Error("The file has no data rows.");

  // delimiter: most consistent separator over the first rows
  const sample = body.slice(0, 60).map((b) => b.text);
  let delim = null, bestScore = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = sample.map((l) => l.split(d).length - 1);
    const mode = counts.sort((a, b) => counts.filter((v) => v === b).length - counts.filter((v) => v === a).length)[0];
    if (mode < 1) continue;
    const consistent = sample.filter((l) => l.split(d).length - 1 === mode).length / sample.length;
    const score = consistent * 10 + Math.min(mode, 40) / 40;
    if (score > bestScore) { bestScore = score; delim = d; }
  }
  const split = delim ? (l) => l.split(delim).map((x) => x.trim().replace(/^"(.*)"$/, "$1")) : (l) => l.split(/\s+/);

  // decimal commas (European exports)
  const decimalComma = delim === ";" || delim === "\t" ? sample.slice(1).some((l) => /(^|[;\t])\s*-?\d+,\d+\s*($|[;\t])/.test(l)) : false;
  const toNum = (x) => {
    if (x === "" || x == null) return NaN;
    const y = decimalComma ? x.replace(",", ".") : x;
    if (!isNum(y)) return NaN;
    const v = Number(y);
    return SENTINELS.has(v) ? NaN : v;
  };

  const rows = body.map((b) => ({ i: b.i, tok: split(b.text) }));
  // share of the filled-in fields that are numbers (timestamps count); mostly
  // empty rows from loggers that write each sensor on its own row still count
  const numericShare = (tok) => {
    const filled = tok.filter((x) => x !== "");
    return filled.filter((x) => Number.isFinite(toNum(x)) || DATETIME.test(x) || SENTINELS.has(Number(x))).length / Math.max(1, filled.length);
  };

  // header row
  let headerIdx = -1;
  for (let k = 0; k < Math.min(rows.length - 1, 40); k++) {
    if (numericShare(rows[k].tok) <= 0.34 && rows[k].tok.length >= 2 && numericShare(rows[k + 1].tok) >= 0.5) { headerIdx = k; break; }
  }
  let names;
  let dataStart = 0;
  if (headerIdx >= 0) { names = rows[headerIdx].tok; dataStart = headerIdx + 1; }
  else {
    // OpenRocket, Altus Metrum and others put the header in a comment line.
    // Use the usual row width: a logger's first row is sometimes cut short.
    const widths = rows.filter((r) => numericShare(r.tok) >= 0.5).slice(0, 80).map((r) => r.tok.length);
    const width = widths.length ? +Object.entries(widths.reduce((m, w) => ((m[w] = (m[w] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0][0] : 0;
    const looksLikeNames = (c) => numericShare(split(c.text)) <= 0.34;
    const ch = [...comments].reverse().find((c) => split(c.text).length === width && width >= 2)
      || comments.find((c) => looksLikeNames(c) && split(c.text).length >= Math.max(3, 0.6 * width) && width >= 2);
    if (ch) { names = split(ch.text); if (/Time \(s\)/.test(ch.text)) format = "openrocket"; }
    else { names = Array.from({ length: width }, (_, j) => `Column ${j + 1}`); warnings.push("No header row was found, so columns are numbered. Set what each column is under Columns."); }
    dataStart = rows.findIndex((r) => numericShare(r.tok) >= 0.5);
  }
  names = names.map((n, j) => n || `Column ${j + 1}`);
  // repeated names (Altus Metrum has two "altitude" columns): number the repeats
  const seen = {};
  names = names.map((n) => { const k = n.toLowerCase(); seen[k] = (seen[k] || 0) + 1; return seen[k] > 1 ? `${n} (${seen[k]})` : n; });
  // widen to the longest data row so no values are lost
  const maxW = Math.max(names.length, ...rows.slice(dataStart, dataStart + 200).map((r) => r.tok.length));
  for (let j = names.length; j < maxW && names.length < 400; j++) names.push(`Column ${j + 1}`);

  // tagged multi-record logs, e.g. "$TLM,..." and "$GPS,..." lines
  const dataRows = rows.slice(dataStart);
  const firstTok = dataRows.map((r) => r.tok[0]);
  const tags = {};
  for (const f of firstTok) if (f && !Number.isFinite(toNum(f))) tags[f] = (tags[f] || 0) + 1;
  const tagList = Object.entries(tags).sort((a, b) => b[1] - a[1]);
  let useTag = null;
  if (tagList.length && tagList[0][1] > dataRows.length * 0.3 && tagList.length <= 6) {
    useTag = tagList[0][0];
    if (tagList.length > 1) warnings.push(`This log mixes record types (${tagList.map((t) => t[0]).join(", ")}). Reading the "${useTag}" records.`);
  }

  const W = names.length;
  const cols = names.map((n) => ({ name: n, values: [], text: [] }));
  const textEvents = [];
  let lastTimeRow = -1;
  for (const r of dataRows) {
    if (useTag && r.tok[0] !== useTag) continue;
    if (numericShare(r.tok) < 0.3) {
      // a message line in the middle of data (e.g. "Apogee detected")
      textEvents.push({ row: lastTimeRow, label: r.tok.join(" ").slice(0, 80) });
      continue;
    }
    for (let j = 0; j < W; j++) {
      const raw = r.tok[j] ?? "";
      cols[j].values.push(toNum(raw));
      cols[j].text.push(raw);
    }
    lastTimeRow++;
  }
  const nRows = cols[0]?.values.length || 0;
  if (nRows < 3) throw new Error("Fewer than 3 data rows were found. Check that this is a flight log (one row per sample).");
  for (const c of cols) {
    // date-and-time stamps become seconds
    const texts = c.text.filter((x) => x !== "");
    if (texts.length && texts.slice(0, 50).every((x) => DATETIME.test(x))) {
      c.values = c.text.map((x) => { if (!DATETIME.test(x)) return NaN; const iso = x.replace(" ", "T"); return Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z") / 1000; });
      c.unitHint = "s";
    }
    const nonEmpty = c.text.filter((x) => x !== "").length;
    const numeric = c.values.filter(Number.isFinite).length;
    c.isText = nonEmpty > 0 && numeric / nonEmpty < 0.9;
    if (!c.isText) delete c.text;
    c.values = Float64Array.from(c.values);
  }
  return { name, format, delimiter: delim || "space", columns: cols, rows: nRows, events, textEvents, warnings, decimalComma };
}

// Initial column mapping with unit guesses based on the values.
export function guessMapping(parsed) {
  const names = parsed.columns.map((c) => c.name);
  const auto = autoMap(names);
  const map = auto.map((a, j) => {
    const col = parsed.columns[j];
    let role = a.role;
    if (col.isText && role && !["state", "event"].includes(role)) role = "";
    if (!col.isText && (role === "state" || role === "event")) {
      // numeric state codes are fine for state
      if (role === "event") role = "";
    }
    return { index: j, name: a.name, role, unit: a.unit, scale: 1, guessed: false };
  });
  const by = (r) => map.find((m) => m.role === r);
  const vals = (m) => parsed.columns[m.index].values;
  // the first n readings that exist (sparse logs leave many rows blank)
  const firstVals = (m, n) => { const v = vals(m), out = []; for (let i = 0; i < v.length && out.length < n; i++) if (Number.isFinite(v[i])) out.push(v[i]); return out; };
  for (const m of map) if (m.role === "time" && !m.unit && parsed.columns[m.index].unitHint) m.unit = parsed.columns[m.index].unitHint;

  // Known loggers whose headers don't say their units.
  const lower = names.map((n) => n.toLowerCase());
  const has = (...k) => k.every((x) => lower.includes(x));
  if (has("t", "alt", "veloc", "filt_alt", "fveloc")) {          // Eggtimer: ms, feet, ft/s
    for (const m of map) {
      if (m.role === "time") m.unit = "ms";
      if (m.role === "alt") m.unit = "ft";
      if (m.role === "vel") m.unit = "ft/s";
    }
    parsed.knownFormat = "Eggtimer";
  } else if (has("version", "serial", "flight", "call", "time", "state")) { // Altus Metrum AltosUI export
    for (const m of map) {
      if (m.role === "time") m.unit = "s";
      if (m.role === "alt" || m.role === "gps_alt") m.unit = "m";
      if (m.role === "vel") m.unit = "m/s";
      if (m.role === "acc") { m.unit = "m/s2"; m.role = "acc_kin"; m.note = "Altus Metrum logs acceleration with gravity removed"; }
      if (m.role === "pressure") m.unit = "Pa";
    }
    parsed.knownFormat = "Altus Metrum";
  }

  const t = by("time");
  if (t && !t.unit) {
    const v = vals(t);
    const d = [];
    for (let i = 1; i < Math.min(v.length, 2000); i++) if (v[i] > v[i - 1]) d.push(v[i] - v[i - 1]);
    const md = median(d);
    const max = Math.max(...v.slice(0, 5000).filter(Number.isFinite));
    t.unit = md >= 500 ? "us" : (md >= 1 && max > 2000) || md >= 4 ? "ms" : "s";
    t.guessed = true;
  }
  const p = by("pressure");
  if (p && !p.unit) {
    const m = median(firstVals(p, 2000));
    p.unit = m > 20000 ? "Pa" : m > 200 ? "hPa" : m > 60 ? "kPa" : m > 18 ? "inHg" : m > 7 ? "psi" : "Pa";
    p.guessed = true;
  }
  const alt = by("alt");
  if (alt && !alt.unit) { alt.unit = "m"; alt.guessed = true; }
  const gal = by("gps_alt");
  if (gal && !gal.unit) { gal.unit = "m"; gal.guessed = true; }
  const vel = by("vel");
  if (vel && /down|(^|[^a-z])vd([^a-z]|$)/i.test(vel.name)) { vel.scale = -1; vel.note = "measured downwards, so flipped"; }
  if (vel && !vel.unit) { vel.unit = alt && /ft|feet/i.test(alt.unit) ? "ft/s" : "m/s"; vel.guessed = true; }
  // An "acceleration" column that reads about 0 on the pad has gravity removed
  // already (Altus Metrum, CATS and most filtered outputs). Real accelerometers
  // read +1 g at rest.
  const acc0 = by("acc");
  if (acc0 && !by("acc_kin") && !/(^|[^a-z])[xyz]([^a-z]|$)/i.test(acc0.name)) {
    const all = vals(acc0);
    let peak = 0;
    for (let i = 0; i < all.length; i++) if (Math.abs(all[i]) > peak) peak = Math.abs(all[i]);
    const gUnit = /^g/i.test(acc0.unit || "") ? 1 : /m\/s|mps|ms2/i.test(acc0.unit || "") || peak > 40 ? 9.80665 : 1;
    // the first samples, before the motor kicks in, are the pad
    let k = 0;
    while (k < all.length && !(Math.abs(all[k]) > 2 * gUnit)) k++;
    const v = Array.from(all.slice(0, Math.min(k, 20)));
    const m = v.length >= 5 ? Math.abs(median(v)) : NaN;
    if (Number.isFinite(m) && m < 0.5 * gUnit) { acc0.role = "acc_kin"; acc0.note = "reads 0 g at rest, so gravity is already removed"; }
  }
  for (const r of ["acc", "acc_x", "acc_y", "acc_kin"]) {
    const a = by(r);
    if (a && !a.unit) {
      const m = Math.abs(median(firstVals(a, 400)));
      a.unit = r === "acc_kin" ? "m/s2" : m > 4 ? "m/s2" : "g";
      a.guessed = true;
    }
  }
  const tp = by("temp");
  if (tp && !tp.unit) { tp.unit = "C"; tp.guessed = true; }
  for (const r of ["gyro_x", "gyro_y", "gyro_z"]) { const g = by(r); if (g && !g.unit) { g.unit = "deg/s"; g.guessed = true; } }
  const b = by("batt");
  if (b && !b.unit) { const m = median(firstVals(b, 500)); b.unit = m > 100 ? "mV" : "V"; b.guessed = true; }
  return map;
}

// Apply the mapping: returns a standard flight with SI series.
export function buildFlight(parsed, mapping, opts = {}) {
  const n = parsed.rows;
  const series = {};
  const text = {};
  let time = null;
  for (const m of mapping) {
    if (!m.role) continue;
    const col = parsed.columns[m.index];
    const def = ROLE_BY_ID[m.role];
    if (!def) continue;
    if (def.kind === "state" || def.kind === "text") {
      text[m.role] = col.isText ? col.text : Array.from(col.values, (v) => (Number.isFinite(v) ? String(v) : ""));
      continue;
    }
    const c = conversion(def.kind, m.unit);
    const k = (m.scale ?? 1) * c.factor;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = col.values[i] * k + c.offset;
    if (m.role === "time") time = out; else series[m.role] = out;
  }
  const warnings = [...parsed.warnings];
  if (!time) {
    const rate = opts.sampleRate || 100;
    time = Float64Array.from({ length: n }, (_, i) => i / rate);
    warnings.push(`No time column was chosen; assuming ${rate} samples per second.`);
  }
  // keep rows with valid, increasing time. Some loggers write sections out of
  // order (an RRC3 export, for example), so sort when that happens a lot.
  // Rows far closer together than the log's usual spacing (merged files can
  // have rows a microsecond apart) would imply impossible speeds: keep one.
  const gaps = [];
  for (let i = 1; i < Math.min(n, 5000); i++) { const d = time[i] - time[i - 1]; if (d > 0) gaps.push(d); }
  const minGap = 0.25 * (median(gaps) || 0);
  let keep = [];
  let last = -Infinity, backwards = 0, tooClose = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(time[i])) continue;
    if (time[i] > last + minGap) { keep.push(i); last = time[i]; } else if (time[i] > last) tooClose++; else backwards++;
  }
  if (backwards > Math.max(5, n * 0.01)) {
    const idx = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(time[i])) idx.push(i);
    idx.sort((a, b) => time[a] - time[b] || a - b);
    keep = [];
    let lt = -Infinity;
    for (const i of idx) if (time[i] > lt + minGap) { keep.push(i); lt = time[i]; }
    warnings.push("Rows weren't in time order, so Heron sorted them.");
  } else if (keep.length < n * 0.9) warnings.push(`${n - keep.length} rows had missing, out-of-order or duplicate times and were skipped.`);
  const pick = (arr) => Float64Array.from(keep, (i) => arr[i]);
  const t = pick(time);
  const t0 = t[0];
  for (let i = 0; i < t.length; i++) t[i] -= t0;
  const outSeries = {};
  for (const [k, v] of Object.entries(series)) outSeries[k] = pick(v);
  const outText = {};
  for (const [k, v] of Object.entries(text)) outText[k] = keep.map((i) => v[i]);
  // file events (OpenRocket) are in the file's own time base
  const events = parsed.events.map((e) => ({ ...e, t: e.t - t0 }));
  for (const e of parsed.textEvents) {
    const found = keep.findIndex((r) => r >= e.row);
    const idx = found < 0 ? keep.length - 1 : found;
    events.push({ t: t[idx], label: e.label, source: "log" });
  }
  return { name: parsed.name, format: parsed.format, t, series: outSeries, text: outText, events, warnings, mapping, rows: t.length, timeOffset: t0 };
}

export function describeMapping(mapping) {
  return mapping.filter((m) => m.role).map((m) => `${ROLE_BY_ID[m.role].label}: "${m.name}"${m.unit ? ` (${m.unit}${m.guessed ? ", guessed" : ""})` : ""}`);
}

// Simple CSV writer
export function toCSV(headers, cols, digits = 4) {
  const n = cols[0]?.length || 0;
  const out = [headers.join(",")];
  for (let i = 0; i < n; i++) out.push(cols.map((c) => { const v = c[i]; return typeof v === "number" ? (Number.isFinite(v) ? +v.toFixed(digits) : "") : (v ?? ""); }).join(","));
  return out.join("\n") + "\n";
}

export { unitLabel, G0 };
