// Unit handling. Everything inside the apps is SI (m, s, m/s, m/s², Pa, °C,
// kg, N); conversion happens only at the edges (display and import).

export const G0 = 9.80665;
export const FT = 0.3048;

export const UNIT_SYSTEMS = { imperial: "Feet (imperial)", metric: "Metres (metric)" };

// Display helpers bound to a unit system.
export function display(system = "imperial") {
  const imp = system === "imperial";
  return {
    system,
    altUnit: imp ? "ft" : "m",
    velUnit: imp ? "ft/s" : "m/s",
    accUnit: "g",
    alt: (m) => (m == null || !Number.isFinite(m) ? null : imp ? m / FT : m),
    vel: (v) => (v == null || !Number.isFinite(v) ? null : imp ? v / FT : v),
    acc: (a) => (a == null || !Number.isFinite(a) ? null : a / G0),
    fromAlt: (x) => (imp ? x * FT : x),
    fromVel: (x) => (imp ? x * FT : x),
    fmtAlt: (m, d = 0) => fmt(m == null ? null : imp ? m / FT : m, d),
    fmtVel: (v, d = 0) => fmt(v == null ? null : imp ? v / FT : v, d),
    fmtAcc: (a, d = 1) => fmt(a == null ? null : a / G0, d),
    fmtDist: (m) => {
      if (m == null || !Number.isFinite(m)) return "–";
      if (imp) { const ft = m / FT; return ft < 5280 * 0.25 ? `${fmt(ft, 0)} ft` : `${fmt(ft / 5280, 2)} mi`; }
      return m < 1000 ? `${fmt(m, 0)} m` : `${fmt(m / 1000, 2)} km`;
    },
  };
}

export function fmt(x, d = 0) {
  if (x == null || !Number.isFinite(x)) return "–";
  const s = Math.abs(x) >= 1000 ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : x.toFixed(d);
  return s.replace(/^-/, "−");
}

// ---- recognising units written in column headers or field names ----
// Returns { kind, factor, offset } so that SI = raw * factor + offset.
const U = {
  length: { m: 1, meter: 1, meters: 1, metre: 1, metres: 1, ft: FT, feet: FT, foot: FT, cm: 0.01, mm: 0.001, km: 1000, mi: 1609.344 },
  time: { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, ms: 0.001, msec: 0.001, millis: 0.001, us: 1e-6, usec: 1e-6, micros: 1e-6, "µs": 1e-6, min: 60 },
  velocity: { "m/s": 1, mps: 1, "ft/s": FT, fps: FT, "km/h": 1 / 3.6, kph: 1 / 3.6, mph: 0.44704, "kn": 0.514444, knots: 0.514444 },
  accel: { "m/s2": 1, "m/s^2": 1, "m/s²": 1, mss: 1, ms2: 1, mps2: 1, g: G0, gs: G0, "g's": G0, "ft/s2": FT, "ft/s^2": FT, "ft/s²": FT, mg: G0 / 1000 },
  pressure: { pa: 1, hpa: 100, mbar: 100, mb: 100, kpa: 1000, bar: 1e5, psi: 6894.757, inhg: 3386.389, atm: 101325 },
  temperature: { c: 1, "°c": 1, degc: 1, celsius: 1, f: 1, "°f": 1, degf: 1, fahrenheit: 1, k: 1, kelvin: 1 },
  angrate: { "deg/s": 1, dps: 1, "°/s": 1, "rad/s": 57.29578, rps: 57.29578, rpm: 6 },
  voltage: { v: 1, volt: 1, volts: 1, mv: 0.001 },
  angle: { deg: 1, "°": 1, rad: 57.29578 },
};

export function unitFactor(kind, unit) {
  if (!unit) return null;
  const u = unit.toLowerCase().replace(/\s+/g, "");
  const table = U[kind];
  if (!table || !(u in table)) return null;
  if (kind === "temperature") {
    if (u.endsWith("f") || u === "fahrenheit") return { factor: 5 / 9, offset: -32 * 5 / 9 };
    if (u === "k" || u === "kelvin") return { factor: 1, offset: -273.15 };
    return { factor: 1, offset: 0 };
  }
  return { factor: table[u], offset: 0 };
}

// Find a unit mentioned in a header like "Altitude (ft)", "alt_ft", "Pressure [hPa]".
export function unitInText(kind, text) {
  const t = text.toLowerCase();
  const bracket = t.match(/[([{]\s*([^)\]}]+?)\s*[)\]}]/);
  if (bracket) {
    const f = unitFactor(kind, bracket[1]);
    if (f) return f;
  }
  const parts = t.split(/[\s_\-.:]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const f = unitFactor(kind, parts[i]);
    if (f) return f;
  }
  // "feet"/"meters" words anywhere
  for (const p of parts) {
    const f = unitFactor(kind, p);
    if (f && p.length > 2) return f;
  }
  return null;
}
