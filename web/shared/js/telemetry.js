// Telemetry line parsing for Owl. Understands CSV (with or without a header
// line), key=value pairs, JSON lines and NMEA GPS sentences, from any radio or
// flight computer. A mapping table (auto-filled, editable) says which field is
// altitude, speed, GPS and so on, and in which unit.

import { autoMap, ROLE_BY_ID, conversion, phaseFromState, scoreRole, ROLES } from "./fields.js";
import { G0 } from "./units.js";

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
export const isNum = (s) => NUM.test(String(s).trim());

export function nmeaChecksumOK(line) {
  const m = line.match(/^\$([^*]+)\*([0-9a-f]{2})\s*$/i);
  if (!m) return true; // no checksum present
  let c = 0;
  for (const ch of m[1]) c ^= ch.charCodeAt(0);
  return c === parseInt(m[2], 16);
}

function nmeaCoord(v, hemi) {
  if (!v) return NaN;
  const dot = v.indexOf(".");
  const degLen = dot - 2;
  const deg = Number(v.slice(0, degLen)), min = Number(v.slice(degLen));
  let d = deg + min / 60;
  if (hemi === "S" || hemi === "W") d = -d;
  return d;
}

export function parseNMEA(line) {
  if (!/^\$(GP|GN|GL|GA|BD)(GGA|RMC)/.test(line) || !nmeaChecksumOK(line)) return null;
  const p = line.split("*")[0].split(",");
  const type = p[0].slice(3);
  if (type === "GGA") {
    const fix = Number(p[6] || 0);
    const out = { fix, sats: Number(p[7] || 0) };
    if (fix > 0) { out.lat = nmeaCoord(p[2], p[3]); out.lon = nmeaCoord(p[4], p[5]); out.gps_alt = Number(p[9]); }
    return out;
  }
  if (type === "RMC") {
    if (p[2] !== "A") return { fix: 0 };
    return { lat: nmeaCoord(p[3], p[4]), lon: nmeaCoord(p[5], p[6]), fix: 1 };
  }
  return null;
}

// Splits a line into named raw fields. Keeps per-tag CSV headers.
export class LineParser {
  constructor(cfg = {}) {
    this.cfg = { format: "auto", delimiter: "auto", prefix: "", fieldNames: "", ...cfg };
    this.headers = {}; // tag -> [names]
    if (this.cfg.fieldNames.trim()) this.headers[""] = this.cfg.fieldNames.split(/[,;\s]+/).filter(Boolean);
  }

  // returns {kind, tag, fields:{name:value}} or null (comment/blank/unparsed)
  parse(line) {
    let s = line.trim();
    if (!s) return null;
    if (s.startsWith("//") || /^#\s/.test(s) || s === "#") return { kind: "text", text: s };
    const pre = this.cfg.prefix.trim();
    if (pre) { if (!s.startsWith(pre)) return null; s = s.slice(pre.length).replace(/^[,;:\s]+/, ""); }
    const fmt = this.cfg.format;

    if ((fmt === "auto" || fmt === "nmea") && s.startsWith("$")) {
      const n = parseNMEA(s);
      if (n) return { kind: "nmea", tag: "GPS", fields: n, gps: true };
      if (fmt === "nmea") return null;
    }
    if ((fmt === "auto" || fmt === "json") && s.startsWith("{")) {
      try {
        const o = JSON.parse(s);
        const fields = {};
        const walk = (obj, pfx) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === "object" && !Array.isArray(v)) walk(v, pfx + k + ".");
            else fields[pfx + k] = v;
          }
        };
        walk(o, "");
        return { kind: "json", tag: "", fields };
      } catch { if (fmt === "json") return null; }
    }
    if (fmt === "auto" || fmt === "kv") {
      const re = /([A-Za-z_][\w.\-]*)\s*[:=]\s*(-?[\d.]+(?:e[-+]?\d+)?|"[^"]*"|[A-Za-z_][\w\-]*)/gi;
      const fields = {};
      let m, count = 0;
      while ((m = re.exec(s))) { fields[m[1]] = m[2].replace(/^"|"$/g, ""); count++; }
      if (count >= 2 || (fmt === "kv" && count >= 1)) return { kind: "kv", tag: "", fields };
      if (fmt === "kv") return null;
    }
    // CSV / delimited
    let delim = this.cfg.delimiter;
    if (delim === "auto") delim = s.includes(",") ? "," : s.includes(";") ? ";" : s.includes("\t") ? "\t" : s.includes("|") ? "|" : " ";
    const tok = (delim === " " ? s.split(/\s+/) : s.split(delim)).map((x) => x.trim());
    if (tok.length < 2 && !isNum(tok[0])) return null;
    let tag = "";
    let body = tok;
    const nums = tok.filter(isNum).length;
    if (!isNum(tok[0]) && tok.length > 2 && tok.slice(1).filter(isNum).length >= (tok.length - 1) * 0.6) { tag = tok[0].replace(/^[$#]/, ""); body = tok.slice(1); }
    // Header line: mostly identifiers
    const idents = body.filter((x) => /^[A-Za-z_][\w .\-()[\]/%°²]*$/.test(x) && !isNum(x)).length;
    if (nums === 0 && idents >= Math.max(2, body.length * 0.8)) {
      this.headers[tag] = body;
      return { kind: "header", tag, names: body };
    }
    if (nums === 0) return { kind: "text", text: s }; // a message, not data
    const names = this.headers[tag] || this.headers[""] || null;
    const fields = {};
    body.forEach((v, i) => { fields[names && names[i] ? names[i] : (tag ? tag + "." : "") + "f" + (i + 1)] = v; });
    return { kind: "csv", tag, fields };
  }
}

// Converts raw fields into roles using a mapping table:
// mapping[name] = {role, unit, scale}
export function applyMapping(fields, mapping) {
  const out = {};
  for (const [name, raw] of Object.entries(fields)) {
    const m = mapping[name];
    if (!m || !m.role) continue;
    const def = ROLE_BY_ID[m.role];
    if (!def) continue;
    if (def.kind === "state" || def.kind === "text") { out[m.role] = String(raw); continue; }
    let v = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(v)) continue;
    v *= m.scale ?? 1;
    const c = conversion(def.kind, m.unit);
    v = v * c.factor + c.offset;
    out[m.role] = v;
  }
  return out;
}

// Suggests a mapping entry for a field name never seen before.
export function suggestMapping(name, taken = new Set()) {
  if (/^([\w]+\.)?f\d+$/.test(name)) return { role: "", unit: "", scale: 1 };
  const last = name.includes(".") ? name.split(".").pop() : name;
  const [m] = autoMap([last]);
  if (m.role && !taken.has(m.role)) return { role: m.role, unit: m.unit, scale: 1 };
  // second choice: best-scoring free role
  let best = null, bs = 0;
  for (const def of ROLES) { if (taken.has(def.role)) continue; const s = scoreRole(def, last); if (s > bs) { bs = s; best = def; } }
  if (best && bs >= 50) return { role: best.role, unit: "", scale: 1 };
  return { role: "", unit: "", scale: 1 };
}

// ---------------- live flight phase tracking ----------------
// Uses the flight computer's own state when it sends one, otherwise infers
// the phase from altitude (and acceleration, when available).
export class PhaseTracker {
  constructor(opts = {}) {
    this.o = { launchRise: 15, landedSpeed: 1.5, landedTime: 5, mainChange: 0.6, ...opts };
    this.reset();
  }
  reset() {
    this.phase = "pad"; this.hist = []; this.ground = null; this.padSamples = [];
    this.launchT = null; this.apogee = null; this.maxAlt = 0; this.maxVel = 0; this.maxAcc = 0;
    this.events = []; this.vel = 0; this.lastT = null; this.still = 0; this.descentRates = []; this.mainSeen = false;
    this.agl = null;
  }
  _ev(type, t, label, detail) { const e = { type, t, label, detail }; this.events.push(e); return e; }

  // t: seconds (receive or packet time), alt: m (raw), vel: m/s or undefined, acc: m/s² specific force or undefined, state: string
  update({ t, alt, vel, acc, state, altIsAgl = false }) {
    const out = [];
    if (!Number.isFinite(t)) return out;
    if (Number.isFinite(alt)) {
      if (this.launchT === null && !altIsAgl) {
        this.padSamples.push(alt);
        if (this.padSamples.length > 60) this.padSamples.shift();
        const s = [...this.padSamples].sort((a, b) => a - b);
        this.ground = s[Math.floor(s.length / 2)];
      }
      if (altIsAgl) this.ground = 0;
      const h = alt - (this.ground ?? alt);
      this.agl = h;
      this.hist.push([t, h]);
      while (this.hist.length > 2 && t - this.hist[0][0] > 1.2) this.hist.shift();
      if (this.hist.length >= 3) {
        // least-squares slope over the last ~1 s
        let n = this.hist.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const [x, y] of this.hist) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
        const d = n * sxx - sx * sx;
        if (d > 1e-9) this.vel = (n * sxy - sx * sy) / d;
      }
      if (Number.isFinite(vel)) this.vel = vel;
      if (h > this.maxAlt) this.maxAlt = h;
    } else if (Number.isFinite(vel)) this.vel = vel;
    if (this.launchT !== null && this.vel > this.maxVel) this.maxVel = this.vel;
    if (Number.isFinite(acc) && this.launchT !== null && acc / G0 > this.maxAcc) this.maxAcc = acc / G0;

    const fromFC = state != null && state !== "" ? phaseFromState(state) : null;
    const prev = this.phase;
    let next = prev;
    const h = this.agl ?? 0;

    if (this.launchT === null) {
      const accLaunch = Number.isFinite(acc) && acc > 2.5 * G0;
      if (h > this.o.launchRise && this.vel > 8 || accLaunch || (fromFC && fromFC !== "pad")) {
        this.launchT = accLaunch ? t : Math.max(t - Math.max(0, h) / Math.max(10, this.vel) , this.hist[0]?.[0] ?? t);
        out.push(this._ev("launch", this.launchT, "Launch detected"));
        next = "boost";
      }
    }
    if (fromFC) next = fromFC === "pad" && this.launchT !== null ? next : fromFC;
    else if (this.launchT !== null) {
      if (prev === "boost") {
        const burnout = Number.isFinite(acc) ? acc < 0.3 * G0 : t - this.launchT > 0.3 && this._decel();
        if (burnout) next = "coast";
      }
      if ((prev === "boost" || prev === "coast") && this.vel < -1 && this.maxAlt > this.o.launchRise) next = "drogue";
      if ((prev === "drogue" || prev === "descent") && !this.mainSeen) {
        this.descentRates.push([t, -this.vel]);
        while (this.descentRates.length && t - this.descentRates[0][0] > 6) this.descentRates.shift();
        const early = this.descentRates.filter(([tt]) => t - tt > 3).map(([, r]) => r);
        const recent = this.descentRates.filter(([tt]) => t - tt < 1).map(([, r]) => r);
        if (early.length > 2 && recent.length > 1) {
          const a = early.reduce((x, y) => x + y, 0) / early.length, b = recent.reduce((x, y) => x + y, 0) / recent.length;
          if (a > 8 && b < a * this.o.mainChange) { next = "main"; this.mainSeen = true; }
        }
      }
    }
    // apogee
    if (this.launchT !== null && !this.apogee && this.maxAlt > this.o.launchRise && (this.vel < -0.5 && this.maxAlt - h > 1 || next === "drogue" || next === "main" || next === "descent")) {
      this.apogee = { t: this._apogeeTime(t), h: this.maxAlt };
      out.push(this._ev("apogee", this.apogee.t, "Apogee", this.maxAlt));
    }
    // landing
    if (this.launchT !== null && this.apogee && next !== "landed") {
      if (Math.abs(this.vel) < this.o.landedSpeed && h < Math.max(40, this.maxAlt * 0.05)) {
        if (this.lastT !== null) this.still += t - this.lastT;
        if (this.still > this.o.landedTime) next = "landed";
      } else this.still = 0;
    }
    if (next !== prev) {
      this.phase = next;
      const labels = { boost: "Boost", coast: "Burnout, coasting", drogue: "Descending", descent: "Descending", main: "Main parachute", landed: "Landed" };
      out.push(this._ev("phase", t, labels[next] || next, next));
    }
    this.lastT = t;
    return out;
  }
  _decel() {
    const n = this.hist.length;
    if (n < 6) return false;
    const mid = this.hist[Math.floor(n / 2)], a = this.hist[0], b = this.hist[n - 1];
    const v1 = (mid[1] - a[1]) / (mid[0] - a[0] || 1), v2 = (b[1] - mid[1]) / (b[0] - mid[0] || 1);
    return v2 < v1 - 2;
  }
  _apogeeTime(t) {
    let best = null;
    for (const [tt, hh] of this.hist) if (!best || hh > best[1]) best = [tt, hh];
    return best ? best[0] : t;
  }
}

// ---------------- demo telemetry formatter ----------------
export const DEMO_HEADER = "time_s,alt_m,vel_mps,accel_g,pressure_pa,temp_c,lat,lon,sats,batt_v,state,rssi";
export function demoLine(m, phase, battery, rssi) {
  const st = { pad: "PAD", boost: "BOOST", coast: "COAST", descent: "DESCENT", drogue: "DROGUE", main: "MAIN", landed: "LANDED" }[phase] || "PAD";
  return [m.t.toFixed(2), m.alt_m.toFixed(1), m.vz.toFixed(1), (m.az / G0).toFixed(2), m.p_pa.toFixed(0), m.temp_c.toFixed(1), m.lat.toFixed(6), m.lon.toFixed(6), m.sats, battery.toFixed(2), st, rssi.toFixed(0)].join(",");
}
