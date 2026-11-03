// Recognising what a column or telemetry field means from its name, so logs
// and radio packets from any flight computer can be read without setup.

import { unitInText, unitFactor } from "./units.js";

// kind decides which unit table applies. aliases are compared after the name
// is lower-cased, units in brackets removed, and separators turned to spaces.
export const ROLES = [
  { role: "time", label: "Time", kind: "time", aliases: ["time", "t", "ts", "ms", "millis", "timestamp", "time ms", "time s", "flight time", "clock", "tick", "uptime", "elapsed", "secs", "seconds", "sim time", "timer"], avoid: ["step", "computation", "apogee", "burn", "gps time", "utc"] },
  { role: "alt", label: "Altitude", kind: "length", aliases: ["alt", "altitude", "height", "agl", "baro alt", "baro altitude", "barometric altitude", "alt agl", "altitude agl", "h", "hgt", "balt", "filtered altitude", "est alt", "altitude above ground", "baro height"], avoid: ["gps", "max", "apogee", "lateral", "deploy", "target", "main"] },
  { role: "gps_alt", label: "GPS altitude", kind: "length", aliases: ["gps alt", "gps altitude", "gpsalt", "galt", "msl", "alt msl", "gps height"] },
  { role: "vel", label: "Vertical speed", kind: "velocity", aliases: ["vel", "veloc", "velocity", "vertical velocity", "vertical speed", "vspeed", "vz", "v", "vert vel", "climb", "climb rate", "speed", "baro velocity", "velocity up", "vel up"], avoid: ["lateral", "total", "horizontal", "sound", "wind", "max", "gps speed", "ground speed"] },
  { role: "acc", label: "Acceleration (axial)", kind: "accel", aliases: ["acc", "accel", "acceleration", "axial accel", "axial acceleration", "acc axial", "accel axial", "acc z", "accel z", "az", "acc up", "accel up", "longitudinal acceleration", "high g accel", "accelerometer"], avoid: ["lateral", "total", "vertical acceleration", "gravitational", "x", "y", "max"] },
  { role: "acc_kin", label: "Vertical acceleration (no gravity)", kind: "accel", aliases: ["vertical acceleration"] },
  { role: "acc_x", label: "Accel X", kind: "accel", aliases: ["acc x", "accel x", "ax", "acceleration x", "accx", "a x", "lateral accel x"] },
  { role: "acc_y", label: "Accel Y", kind: "accel", aliases: ["acc y", "accel y", "ay", "acceleration y", "accy", "a y", "lateral accel y"] },
  { role: "pressure", label: "Pressure", kind: "pressure", aliases: ["pressure", "pres", "press", "p", "baro", "air pressure", "baro pressure", "pa", "hpa", "mbar", "static pressure"], avoid: ["drag", "chamber", "tank"] },
  { role: "temp", label: "Temperature", kind: "temperature", aliases: ["temp", "temperature", "air temperature", "baro temp", "tc", "degc", "temp c"], avoid: ["cpu", "chip"] },
  { role: "gyro_x", label: "Gyro X", kind: "angrate", aliases: ["gyro x", "gx", "gyrox", "rate x", "roll rate", "gyro roll"] },
  { role: "gyro_y", label: "Gyro Y", kind: "angrate", aliases: ["gyro y", "gy", "gyroy", "rate y", "pitch rate", "gyro pitch"] },
  { role: "gyro_z", label: "Gyro Z", kind: "angrate", aliases: ["gyro z", "gz", "gyroz", "rate z", "yaw rate", "gyro yaw"] },
  { role: "lat", label: "Latitude", kind: "angle", aliases: ["lat", "latitude", "gps lat", "gps latitude"] },
  { role: "lon", label: "Longitude", kind: "angle", aliases: ["lon", "lng", "long", "longitude", "gps lon", "gps lng", "gps longitude"] },
  { role: "sats", label: "Satellites", kind: "count", aliases: ["sats", "sat", "satellites", "nsat", "num sats", "numsats", "svs", "gps sats", "sat count", "satellites in use"] },
  { role: "fix", label: "GPS fix", kind: "count", aliases: ["fix", "gps fix", "fix type", "fixtype", "fix quality"] },
  { role: "state", label: "Flight state", kind: "state", aliases: ["state", "phase", "mode", "flight state", "flightstate", "fs", "st", "state name", "status"], avoid: ["gps", "pyro", "battery"] },
  { role: "batt", label: "Battery", kind: "voltage", aliases: ["batt", "bat", "battery", "vbat", "vbatt", "voltage", "volts", "batt v", "battery voltage", "vin", "supply"], avoid: ["pyro"] },
  { role: "rssi", label: "Signal (RSSI)", kind: "dbm", aliases: ["rssi", "signal", "dbm", "signal strength"] },
  { role: "snr", label: "SNR", kind: "db", aliases: ["snr", "signal to noise"] },
  { role: "event", label: "Event", kind: "text", aliases: ["event", "events", "message", "msg", "note"] },
];

export const ROLE_BY_ID = Object.fromEntries(ROLES.map((r) => [r.role, r]));

const UNIT_WORDS = new Set(["m", "ft", "s", "ms", "us", "g", "gs", "pa", "hpa", "mbar", "kpa", "psi", "inhg", "c", "f", "k", "v", "mv", "deg", "dps", "rad", "mps", "fps", "feet", "meters", "metres", "sec", "secs", "volts", "dbm"]);

export function normalizeName(name) {
  return String(name).toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")      // drop "(ft)"
    .replace(/[^a-z0-9]+/g, " ")               // separators to spaces
    .trim();
}

// Name without trailing unit words: "alt agl ft" -> "alt agl"
function stripUnits(n) {
  const parts = n.split(" ");
  while (parts.length > 1 && UNIT_WORDS.has(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

export function scoreRole(def, name) {
  const n = normalizeName(name);
  if (!n) return 0;
  const base = stripUnits(n);
  const compact = base.replace(/ /g, "");
  let best = 0;
  for (const a of def.aliases) {
    const ac = a.replace(/ /g, "");
    if (base === a || compact === ac) best = Math.max(best, 100 - (a.length < 2 ? 15 : 0));
    else if (base.startsWith(a + " ")) best = Math.max(best, 70 + Math.min(10, a.length));
    else if (a.length >= 3 && (" " + base + " ").includes(" " + a + " ")) best = Math.max(best, 55 + Math.min(10, a.length));
  }
  if (best && def.avoid) for (const w of def.avoid) if ((" " + n + " ").includes(" " + w + " ")) best -= 60;
  return Math.max(0, best);
}

// Assign roles to a list of names. Each role is used once, best score first.
export function autoMap(names) {
  const cands = [];
  names.forEach((name, i) => {
    for (const def of ROLES) {
      let s = scoreRole(def, name);
      // a barometric altitude beats a plain "alt" that is often GPS
      if (s >= 50 && def.role === "alt" && /baro/i.test(name)) s += 5;
      if (s >= 50) cands.push({ i, role: def.role, s });
    }
  });
  cands.sort((a, b) => b.s - a.s);
  const byIndex = {}, used = new Set();
  for (const c of cands) {
    if (byIndex[c.i] !== undefined || used.has(c.role)) continue;
    byIndex[c.i] = c.role; used.add(c.role);
  }
  return names.map((name, i) => {
    const role = byIndex[i] || "";
    const def = ROLE_BY_ID[role];
    const u = def ? unitInText(def.kind, String(name)) : null;
    return { name, role, unit: u ? unitLabel(def.kind, String(name)) : "", factor: u ? u.factor : null, offset: u ? u.offset : 0 };
  });
}

// The unit text found in a name, for display ("ft", "hPa").
export function unitLabel(kind, name) {
  const t = String(name);
  const b = t.match(/[([{]\s*([^)\]}]+?)\s*[)\]}]/);
  if (b && unitFactor(kind, b[1])) return b[1];
  const parts = t.split(/[\s_\-.:]+/);
  for (let i = parts.length - 1; i >= 1; i--) if (unitFactor(kind, parts[i])) return parts[i];
  return "";
}

// Unit choices offered in mapping tables, per kind. First entry is SI.
export const UNIT_CHOICES = {
  time: ["s", "ms", "us", "min"],
  length: ["m", "ft", "cm", "km"],
  velocity: ["m/s", "ft/s", "km/h", "mph"],
  accel: ["m/s2", "g", "ft/s2", "mg"],
  pressure: ["Pa", "hPa", "kPa", "psi", "inHg", "bar"],
  temperature: ["C", "F", "K"],
  angrate: ["deg/s", "rad/s", "rpm"],
  voltage: ["V", "mV"],
  angle: ["deg"],
};

export function conversion(kind, unit) {
  if (!unit) return { factor: 1, offset: 0 };
  return unitFactor(kind, unit) || { factor: 1, offset: 0 };
}

// Flight-state words used by common flight computers, mapped to Aviary phases.
const STATE_WORDS = [
  [/^(pad|idle|ready|wait|waiting|ground|startup|init|boot|preflight|calib|calibrat)/, "pad"],
  [/^(arm|armed)/, "pad"],
  [/^(boost|burn|powered|launch|liftoff|ascent|thrust|motor)/, "boost"],
  [/^(coast|fast|ascending|unpowered)/, "coast"],
  [/^(apogee|peak|deploy1|drogue_deploy)/, "descent"],
  [/^(drogue|descent|descending|falling|freefall|ballistic|slow)/, "drogue"],
  [/^(main|chute|parachute|deploy2|deploy)/, "main"],
  [/^(land|landed|touchdown|recovery|recover|done|post|safe|finished|stop)/, "landed"],
];
export function phaseFromState(s) {
  const w = String(s).toLowerCase().trim().replace(/^state[\s_:]*/, "");
  for (const [re, p] of STATE_WORDS) if (re.test(w)) return p;
  return null;
}
