// Mockingbird's test engine: streams simulated sensor data to a flight
// computer, applies what the flight computer does back to the simulation
// (closed loop), injects faults, and grades the result.
//
// Wire protocol (text lines, 8N1, any baud):
//   PC -> FC   $MBC,START,<rate>,<timescale>*CS   session start
//              $MBH,<field>,<field>,...*CS         field names (resent every 2 s)
//              $MBD,<value>,<value>,...*CS         one sample
//              $MBC,STOP*CS                        session end
//              $MBC,PING*CS                        FC answers $MBE,PONG
//   FC -> PC   $MBE,<EVENT>[,<value>]              e.g. $MBE,PYRO,1  $MBE,APOGEE  $MBE,STATE,COAST
//              $MBT,<name>,<value>[,<name>,<value>...]   values to plot (e.g. alt, vel)
//              $MBA,<name>,<value>[,<name>,<value>...]   control outputs that move the
//                                                         simulated rocket (brake: 0 to 1)
//              $MBL,<text>                         log text
// CS is the NMEA-style XOR of the characters between '$' and '*', in hex.

import { FlightSim, simulate, rng } from "./sim.js";
import { G0 } from "./units.js";

export function checksum(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, "0");
}
export const withCS = (body) => `$${body}*${checksum(body)}`;

export const FIELDS = {
  t_ms: { label: "Time (ms since start)", fmt: (m) => String(Math.round(m.t * 1000)) },
  p_pa: { label: "Pressure (Pa)", fmt: (m) => f(m.p_pa, 1) },
  temp_c: { label: "Temperature (°C)", fmt: (m) => f(m.temp_c, 2) },
  alt_m: { label: "True altitude above pad (m)", fmt: (m) => f(m.alt_m, 2) },
  vz: { label: "True vertical speed (m/s)", fmt: (m) => f(m.vz, 2) },
  ax: { label: "Accel X (m/s²)", fmt: (m) => f(m.ax, 3) }, ay: { label: "Accel Y (m/s²)", fmt: (m) => f(m.ay, 3) }, az: { label: "Accel Z (m/s²)", fmt: (m) => f(m.az, 3) },
  ax_g: { label: "Accel X (g)", fmt: (m) => f(m.ax / G0, 4) }, ay_g: { label: "Accel Y (g)", fmt: (m) => f(m.ay / G0, 4) }, az_g: { label: "Accel Z (g)", fmt: (m) => f(m.az / G0, 4) },
  gx: { label: "Gyro X (°/s)", fmt: (m) => f(m.gx, 2) }, gy: { label: "Gyro Y (°/s)", fmt: (m) => f(m.gy, 2) }, gz: { label: "Gyro Z (°/s)", fmt: (m) => f(m.gz, 2) },
  lat: { label: "GPS latitude", fmt: (m) => f(m.lat, 7) }, lon: { label: "GPS longitude", fmt: (m) => f(m.lon, 7) },
  gps_alt: { label: "GPS altitude (m)", fmt: (m) => f(m.gps_alt, 1) }, sats: { label: "GPS satellites", fmt: (m) => String(m.sats) },
};
function f(v, d) { return Number.isFinite(v) ? v.toFixed(d) : ""; }

export const DEFAULT_FIELDS = ["t_ms", "p_pa", "temp_c", "ax_g", "ay_g", "az_g", "gx", "gy", "gz"];

// Faults Mockingbird can inject. params describe the editable values; a fault
// instance stores { type, ref, offset, duration, params: { key: value } }.
// ref is when the fault starts: "liftoff", "burnout" or "apogee" plus offset
// seconds. "whole" faults last the entire flight.
export const FAULT_TYPES = {
  baro_spike: { label: "Pressure jump", desc: "A sudden pressure change. Negative is a drop (the altitude reads higher), like a Mach dip. Positive is a rise (reads lower), like an ejection charge pressurising the bay.", params: [{ key: "delta", label: "Change", unit: "Pa", value: -600 }] },
  baro_drift: { label: "Pressure drift", desc: "Pressure creeps steadily, like weather or the sun warming the bay, and keeps the offset afterwards.", params: [{ key: "rate", label: "Drift", unit: "Pa/min", value: -40 }], holds: true },
  baro_noise: { label: "Noisy barometer", desc: "Multiplies barometer noise, like wind over the vent holes.", params: [{ key: "factor", label: "Noise", unit: "×", value: 10 }] },
  accel_noise: { label: "Noisy accelerometer", desc: "Multiplies accelerometer noise, like motor vibration.", params: [{ key: "factor", label: "Noise", unit: "×", value: 10 }] },
  accel_spike: { label: "Bump", desc: "A short acceleration spike along the rocket, like a knock on the pad or a deployment jolt.", params: [{ key: "g", label: "Size", unit: "g", value: 4 }] },
  stuck: { label: "Sensor freezes", desc: "A sensor keeps repeating its last value.", params: [{ key: "sensor", label: "Sensor", kind: "sensor", value: "baro" }] },
  dropout: { label: "Sensor drops out", desc: "A sensor sends blank values.", params: [{ key: "sensor", label: "Sensor", kind: "sensor", value: "accel" }] },
  gap: { label: "Data stops", desc: "No samples are sent at all, like a loose cable.", params: [] },
  accel_clip: { label: "Accelerometer range", desc: "Readings saturate at a limit for the whole flight.", params: [{ key: "limit", label: "Limit", unit: "g", value: 8 }], whole: true },
  thrust: { label: "Weak or strong motor", desc: "Scales motor thrust for the whole flight.", params: [{ key: "factor", label: "Thrust", unit: "×", value: 0.85 }], whole: true },
  cato: { label: "Motor quits early", desc: "A stage's motor stops pushing partway through its burn, like a CATO.", params: [{ key: "stage", label: "Stage", kind: "stage", value: 0 }, { key: "after", label: "After", unit: "s", value: 0.4 }], whole: true },
  no_light: { label: "Motor fails to light", desc: "An upper stage's igniter fires but its motor doesn't light.", params: [{ key: "stage", label: "Stage", kind: "stage", value: 1 }], whole: true },
  pyro_dud: { label: "Charge doesn't go off", desc: "The first pyro channel the board fires for this device does nothing, like an open e-match or a bad charge. Firing that channel again does nothing either. A backup on another channel should save the flight.", params: [{ key: "device", label: "Device", kind: "device", value: "apogee" }], whole: true },
  wind: { label: "Wind", desc: "A steady wind for the whole flight, in place of the launch site's. Off the rail the rocket turns into it and flies tilted.", params: [{ key: "speed", label: "Speed", unit: "m/s", value: 9 }, { key: "from", label: "From", unit: "°", value: 270 }], whole: true },
  gust: { label: "Gust", desc: "Extra wind for a while, on top of the steady wind.", params: [{ key: "speed", label: "Speed", unit: "m/s", value: 6 }, { key: "from", label: "From", unit: "°", value: 270 }] },
  rail_tilt: { label: "Rail angle", desc: "The launch rail leans away from vertical, so the rocket starts tilted.", params: [{ key: "angle", label: "Angle", unit: "°", value: 25 }, { key: "toward", label: "Leaning toward", unit: "°", value: 90 }], whole: true },
  spin: { label: "Spin", desc: "The rocket rolls steadily from liftoff to apogee, like canted fins. The gyro along the rocket sees it, and the other axes turn with it.", params: [{ key: "rate", label: "Roll rate", unit: "°/s", value: 360 }], whole: true },
  brake_stuck: { label: "Airbrakes jam", desc: "The airbrakes stop where they are, whatever the board commands. Apogee isn't graded against the target in a test with this fault.", params: [] },
  reboot: { label: "Flight computer restarts", desc: "Mockingbird tells the board to restart, like a brownout or a watchdog reset. The rocket keeps flying while it boots, and it has to work out where it is. Needs MockingbirdHIL 1.2 or newer.", params: [], instant: true },
};
export const SENSORS = [["baro", "Barometer"], ["accel", "Accelerometer"], ["gyro", "Gyro"], ["gps", "GPS"]];
export const FAULT_REFS = [["liftoff", "liftoff"], ["burnout", "burnout"], ["apogee", "apogee"]];

export function newFault(type) {
  const T = FAULT_TYPES[type];
  return { type, ref: T.whole ? "whole" : "apogee", offset: T.whole ? 0 : -1, duration: T.whole ? 0 : 1, params: Object.fromEntries(T.params.map((p) => [p.key, p.value])) };
}

export function describeFault(fl, stageName = (k) => `stage ${k + 1}`, deviceName = (id) => id) {
  const T = FAULT_TYPES[fl.type];
  if (!T) return fl.type;
  const P = fl.params || {};
  const vals = T.params.map((p) => p.kind === "sensor" ? (SENSORS.find((s) => s[0] === P[p.key])?.[1] || P[p.key]).toLowerCase() : p.kind === "stage" ? stageName(Number(P[p.key]))
    : p.kind === "device" ? (P[p.key] === "apogee" || !P[p.key] ? "apogee device" : deviceName(P[p.key])) : `${P[p.key]}${p.unit === "×" || p.unit === "°" ? p.unit : " " + p.unit}`);
  let when = "";
  if (!(T.whole || fl.ref === "whole")) {
    const o = Number(fl.offset) || 0;
    when = `${o === 0 ? "at" : `${Math.abs(o)} s ${o < 0 ? "before" : "after"}`} ${fl.ref || "liftoff"}${T.holds || T.instant ? "" : `, for ${Number(fl.duration) || 0} s`}`;
  }
  return [T.label + (vals.length ? ` (${vals.join(", ")})` : ""), when].filter(Boolean).join(", ");
}

// The starting set of tests. Each one is a list of faults; the normal flight
// has none.
export function defaultTests(rocket) {
  const T = [
    { id: "nominal", name: "Normal flight", note: "No faults. Everything should work.", faults: [] },
    { id: "noisy-baro", name: "Noisy barometer", note: "Ten times the usual barometer noise for the whole flight.", faults: [{ type: "baro_noise", ref: "liftoff", offset: -2, duration: 9999, params: { factor: 10 } }] },
    { id: "pressure-dip", name: "Pressure dip before apogee", note: "Pressure drops 6 hPa for half a second, 2.5 s before apogee. Simple apogee detection fires early.", faults: [{ type: "baro_spike", ref: "apogee", offset: -2.5, duration: 0.5, params: { delta: -600 } }] },
    { id: "ejection-spike", name: "Ejection charge pressure spike", note: "Bay pressure jumps 3 kPa for 0.3 s just after apogee, like an unvented ejection charge. It must not fire the main early.", faults: [{ type: "baro_spike", ref: "apogee", offset: 1.2, duration: 0.3, params: { delta: 3000 } }] },
    { id: "baro-freeze", name: "Barometer freezes at apogee", note: "The barometer repeats one value for 3 s around apogee.", faults: [{ type: "stuck", ref: "apogee", offset: -1, duration: 3, params: { sensor: "baro" } }] },
    { id: "data-gap", name: "Data stops near apogee", note: "No samples for 1 s around apogee.", faults: [{ type: "gap", ref: "apogee", offset: -0.5, duration: 1, params: {} }] },
    { id: "pad-knock", name: "Knock on the pad", note: "A 4 g bump 5 s before launch. The flight computer must not think it has launched.", faults: [{ type: "accel_spike", ref: "liftoff", offset: -5, duration: 0.08, params: { g: 4 } }] },
    { id: "long-pad", name: "Long wait on the pad", note: "Two minutes on the pad while the pressure drifts 40 Pa a minute.", padTime: 120, faults: [{ type: "baro_drift", ref: "liftoff", offset: -118, duration: 118, params: { rate: -40 } }] },
    { id: "weak-motor", name: "Weak motor", note: "15% less thrust for the whole burn.", faults: [{ type: "thrust", ref: "whole", offset: 0, duration: 0, params: { factor: 0.85 } }] },
    { id: "accel-clip", name: "Accelerometer maxes out at 8 g", note: "Readings above 8 g are clipped.", faults: [{ type: "accel_clip", ref: "whole", offset: 0, duration: 0, params: { limit: 8 } }] },
    { id: "cato", name: "Motor quits early (CATO)", note: "The first motor stops 0.4 s into its burn. Recovery still has to work from a low apogee.", faults: [{ type: "cato", ref: "whole", offset: 0, duration: 0, params: { stage: 0, after: 0.4 } }] },
    { id: "no-light", name: "Upper stage doesn't light", needsStages: 2, note: "The flight computer fires the igniter but the motor never lights. Recovery still has to work.", faults: [{ type: "no_light", ref: "whole", offset: 0, duration: 0, params: { stage: 1 } }] },
    { id: "drogue-dud", name: "Drogue charge doesn't go off", needsDevice: "apogee", note: "The first charge fired for the apogee device does nothing. It passes only if a backup charge on another pyro channel deploys it.", faults: [{ type: "pyro_dud", ref: "whole", offset: 0, duration: 0, params: { device: "apogee" } }] },
    { id: "crosswind", name: "Gusty crosswind", note: "A 9 m/s wind and a gust as it leaves the rail: the rocket turns into the wind and flies tilted, so the accelerometer no longer points straight up. Deployments still have to be right.", faults: [{ type: "wind", ref: "whole", offset: 0, duration: 0, params: { speed: 9, from: 270 } }, { type: "gust", ref: "liftoff", offset: 0, duration: 2, params: { speed: 6, from: 270 } }] },
    { id: "tilted-launch", name: "Tilted launch", needsStages: 2, note: "The rail leans 25°, so the rocket is past the tilt limit when the upper stage is due. The board must not light it (and must still recover the rocket).", faults: [{ type: "rail_tilt", ref: "whole", offset: 0, duration: 0, params: { angle: 25, toward: 90 } }] },
    { id: "strong-motor", name: "Strong motor", needsAirbrakes: true, note: "8% more thrust. The airbrakes have to shed the extra height to hit the target apogee.", faults: [{ type: "thrust", ref: "whole", offset: 0, duration: 0, params: { factor: 1.08 } }] },
    { id: "reboot-coast", name: "Restart while coasting", note: "The board restarts 1 s after burnout. It has to remember it's flying and still catch apogee. Needs MockingbirdHIL 1.2 or newer.", faults: [{ type: "reboot", ref: "burnout", offset: 1, duration: 0, params: {} }] },
  ];
  return T;
}

// Default tests from before 1.3, so that tests added later can be offered to
// people who already have a saved list (and deleted ones don't come back).
export const OLD_DEFAULT_IDS = ["nominal", "noisy-baro", "pressure-dip", "ejection-spike", "baro-freeze", "data-gap", "pad-knock", "long-pad", "weak-motor", "accel-clip", "cato", "no-light"];

// Why a test can't run on this rocket, or "" when it can.
export function testNeeds(t, rocket) {
  if (t.needsStages && (rocket?.stages?.length || 1) < t.needsStages) return `needs ${t.needsStages}+ stages`;
  if (t.needsDevice === "apogee" && !(rocket?.recovery || []).some((d) => d.deploy === "apogee")) return "needs an apogee deployment";
  if (t.needsAirbrakes && !rocket?.airbrakes?.enabled) return "needs airbrakes";
  return "";
}
export const testApplies = (t, rocket) => !testNeeds(t, rocket);

// The recovery device a "device" fault parameter means.
export function faultDevice(rocket, value) {
  const devs = rocket?.recovery || [];
  if (!value || value === "apogee") return devs.find((d) => d.deploy === "apogee") || devs.find((d) => d.deploy !== "motor") || null;
  return devs.find((d) => d.id === value) || null;
}

// What the flight computer is expected to do, from the rocket profile.
export function buildExpectations(rocket, pyro) {
  const exp = [];
  const chOf = (match) => pyro.find((p) => p.action && match(p.action))?.ch;
  for (const d of rocket.recovery || []) {
    if (d.deploy === "motor" || d.deploy === "never") continue;
    exp.push({ key: "deploy:" + d.id, type: "deploy", id: d.id, label: `${d.name} deployment`, rule: d.deploy, delay: d.delay || 0, altitude: d.altitude, time: d.time, ch: chOf((a) => a.type === "deploy" && a.id === d.id) });
  }
  rocket.stages.forEach((s, k) => {
    if (k === 0 || s.ignition === "direct") return;
    exp.push({ key: "ignite:" + k, type: "ignite", stage: k, label: `${s.name} ignition`, delay: s.ignitionDelay || 0, ch: chOf((a) => a.type === "ignite" && a.stage === k) });
  });
  rocket.stages.forEach((s, k) => {
    if (k === rocket.stages.length - 1 || s.separation !== "commanded") return;
    exp.push({ key: "separate:" + k, type: "separate", stage: k, label: `${s.name} separation`, ch: chOf((a) => a.type === "separate" && a.stage === k) });
  });
  return exp;
}

// Default pyro channel table: devices use their own channel numbers, stages follow.
export function defaultPyro(rocket) {
  const rows = [];
  let next = 1;
  for (const d of rocket.recovery || []) { if (d.deploy === "motor") continue; const ch = d.pyro > 0 ? d.pyro : next; rows.push({ ch, action: { type: "deploy", id: d.id } }); next = Math.max(next, ch + 1); }
  rocket.stages.forEach((s, k) => { if (k > 0 && s.ignition !== "direct") rows.push({ ch: next++, action: { type: "ignite", stage: k } }); });
  rocket.stages.forEach((s, k) => { if (k < rocket.stages.length - 1 && s.separation === "commanded") rows.push({ ch: next++, action: { type: "separate", stage: k } }); });
  return rows.sort((a, b) => a.ch - b.ch);
}

export const DEFAULT_TOL = { apogeeEarly: 1.0, apogeeLate: 2.0, altitudeFrac: 0.1, altitudeMin: 15, timer: 0.5, igniteEarly: 0.3, igniteLate: 0.7, safeLanding: 7.6,
  backupLate: 3.0, backupAltFrac: 0.5, gradeEstimates: true, estAlt: 10, estAltFrac: 0.05, estVel: 6, estVelFrac: 0.08, restartBack: 5,
  tiltMargin: 3, targetFrac: 0.02, targetMin: 3 };

// The tilt limit for lighting an upper stage, in degrees from vertical.
export const DEFAULT_TILT_LIMIT = 20;
const RAD = Math.PI / 180;
// Wind from a compass direction, as east/north components of where it blows.
const windVec = (speed, from) => { const to = ((Number(from) || 0) + 180) * RAD; return [(Number(speed) || 0) * Math.sin(to), (Number(speed) || 0) * Math.cos(to)]; };

// Names the board's own altitude and speed can go by in hil.telemetry().
export const FC_ALT = /^(alt|altitude|agl|h|height|baro_?alt|est_?alt)$/i;
export const FC_VEL = /^(vel|velocity|v|vz|speed|vspeed|est_?vel)$/i;
export const FC_TILT = /^(tilt|tilt_deg|angle|off_vertical)$/i;

// Faults that are a short event: estimates aren't scored while they act.
const EVENT_FAULTS = new Set(["baro_spike", "accel_spike", "stuck", "dropout", "gap"]);

// ---------------------------------------------------------------- replay
// Plays a real flight log back in place of the simulator, so a flight
// computer can be tested against a flight that actually happened. It keeps the
// simulator's interface: the sensor model, faults and grading work unchanged.
//
// replay: { t[] (s from liftoff), h[] (m above the pad, as measured), v[],
//   f[] (m/s² along the rocket, as an accelerometer reads it, or null),
//   east[]/north[] (m, optional), tBurn, tApogee, hApogee, tLand, landSpeed, name }
export class ReplaySim extends FlightSim {
  constructor(rocket, site, replay, padTime) {
    super(rocket, site, { mode: "external" });
    this.rp = replay; this.padTime = padTime; this.k = 0;
  }
  _interp(arr, tau) {
    const T = this.rp.t, n = T.length;
    if (!arr) return NaN;
    if (tau <= T[0]) return arr[0];
    if (tau >= T[n - 1]) return arr[n - 1];
    let k = this.k;
    if (T[k] > tau) k = 0;
    while (k < n - 2 && T[k + 1] <= tau) k++;
    this.k = k;
    const a = (tau - T[k]) / (T[k + 1] - T[k] || 1);
    return arr[k] + (arr[k + 1] - arr[k]) * a;
  }
  step(dt) { this._newEvents = []; this._advance(dt); return this._newEvents; }
  _substep(dt) { this._advance(dt); }
  _advance(dt) {
    const R = this.rp;
    this.t += dt;
    const tau = this.t - this.padTime;
    const before = tau < R.t[0];
    this.h = before ? 0 : this._interp(R.h, tau);
    this.v = before ? 0 : this._interp(R.v, tau);
    this.f = before ? G0 : (R.f ? this._interp(R.f, tau) : G0);
    this.a = this.f - G0;
    this.fv = [0, 0, this.f];   // logs give the axial reading; replay it straight up
    if (R.east) { this.x = before ? 0 : this._interp(R.east, tau); this.y = before ? 0 : this._interp(R.north, tau); }
    if (this.launched && this.liftoff === null && tau >= 0) { this.liftoff = this.t; this._ev("liftoff", { label: "Liftoff (from the log)" }); }
    this.thrust = tau >= 0 && tau < R.tBurn ? 1 : 0;
    if (this.liftoff !== null && this.burnout[0] === null && tau >= R.tBurn) { this.burnout[0] = this.t; this._ev("burnout", { stage: 0, label: "Burnout (from the log)" }); }
    if (!this.apogee && this.liftoff !== null && tau >= R.tApogee) { this.apogee = { t: this.t, h: R.hApogee }; this._ev("apogee", { label: "Apogee (from the log)" }); }
    const end = R.tLand != null ? R.tLand : R.t[R.t.length - 1];
    if (!this.landed && this.liftoff !== null && tau >= end) { this.landed = { t: this.t, v: this.v }; this._ev("landing", { label: "Landed (from the log)", impact: -(R.landSpeed ?? Math.abs(this.v)) }); }
    if (this.h > this.maxH) this.maxH = this.h;
    if (this.v > this.maxV) this.maxV = this.v;
    this._phase();
  }
}

// ---------------------------------------------------------------- the run
export class HILRun {
  constructor({ rocket, site, cfg, faults = [], send, onEvent, onSample, seed = 1 }) {
    this.rocket = rocket;
    // faults that change the launch itself: wind, and the rail's angle
    site = { ...(site || {}) };
    for (const fl of faults.filter((x) => x.enabled !== false)) {
      if (fl.type === "wind") { site.windSpeed = Number(fl.params?.speed) || 0; site.windDir = Number(fl.params?.from) || 0; }
      if (fl.type === "rail_tilt") { site.railAngle = Number(fl.params?.angle) || 0; site.railDir = Number(fl.params?.toward) || 0; }
    }
    this.site = site;
    this.cfg = {
      rate: 50, fields: DEFAULT_FIELDS, protocol: "mb", template: "{t_ms},{p_pa},{az_g}", templateCS: false,
      padTime: 10, timeScale: 1, endAfter: 5, maxTime: 400, noise: { baro: 2, accel: 0.1, gyro: 0.15 },
      axis: { up: "z", sign: 1 }, pyro: defaultPyro(rocket), rules: [], tol: { ...DEFAULT_TOL }, ...cfg,
    };
    this.cfg.tol = { ...DEFAULT_TOL, ...(cfg?.tol || {}) };
    this.faults = faults.filter((x) => x.enabled !== false);
    this.send = send;
    this.onEvent = onEvent || (() => {});
    this.onSample = onSample || null;
    const thrust = this.faults.find((x) => x.type === "thrust");
    const noLight = this.faults.filter((x) => x.type === "no_light").map((x) => Number(x.params?.stage ?? 1));
    const cut = {};
    for (const x of this.faults.filter((x) => x.type === "cato")) cut[Number(x.params?.stage ?? 0)] = Math.max(0.01, Number(x.params?.after) || 0.4);
    this.replay = this.cfg.replay || null;
    delete this.cfg.replay;
    this.sim = this.replay ? new ReplaySim(rocket, site, this.replay, this.cfg.padTime)
      : new FlightSim(rocket, site, { mode: "external", thrustScale: thrust ? Number(thrust.params.factor) || 1 : 1, noLight, cut });
    this.R = rng(seed);
    if (this.replay) {
      // a replay knows its own times
      this.refTimes = { liftoff: 0, apogee: this.replay.tApogee, burnout: this.replay.tBurn };
      this.cfg.maxTime = this.cfg.padTime + (this.replay.tLand ?? this.replay.t[this.replay.t.length - 1]) + 5;
    } else {
      // reference flight (ideal) gives times for faults placed relative to apogee
      this.ref = simulate(rocket, site, { rate: 20 });
      const ev = (t) => this.ref.events.find((e) => e.type === t);
      this.refTimes = { liftoff: ev("liftoff")?.t ?? 0, apogee: ev("apogee")?.t ?? 10, burnout: ev("burnout")?.t ?? 1 };
    }
    this.expectations = buildExpectations(rocket, this.cfg.pyro);
    // the device whose first charge fails; ch is filled in when it fires
    const dudF = this.faults.find((x) => x.type === "pyro_dud");
    const dudDev = dudF ? faultDevice(rocket, dudF.params?.device) : null;
    this.dud = dudDev ? { id: dudDev.id, ch: undefined } : null;
    this.reboots = [];      // {t, back, ack, cant, gaveUp, unsolicited}
    this.down = null;       // the restart in progress
    this.rebooted = new Set();
    this.heard = false;     // the board has said something this test (besides READY)
    this.actions = [];      // {t, kind, label, applied, source, ch}
    this.fcEvents = [];     // detections the FC reported (APOGEE etc.)
    this.fcTlm = {};        // name -> {t:[], v:[]}
    this.fcAct = {};        // control outputs the board sent: name -> {t:[], v:[]}
    this.actNotes = new Set();
    this.truth = { t: [], h: [], v: [], phase: [], x: [], y: [], tilt: [], brake: [] };   // x east, y north (metres from the pad), tilt in degrees
    this.sensed = { baro: [], acc: [] }; // what the FC was sent, one entry per truth row
    this.sent = 0; this.bytes = 0; this.lastHeader = -1e9; this.sampleIdx = 0;
    this.started = false; this.done = false; this.endReason = "";
    this.hold = {};
  }

  // sim time 0 is the start of the pad wait; liftoff happens at padTime.
  get launchAt() { return this.cfg.padTime; }

  start() {
    this.started = true;
    if (this.cfg.protocol === "mb") {
      this._tx(withCS("MBC,STOP"));
      this._tx(withCS(`MBC,START,${this.cfg.rate},${this.cfg.timeScale}`));
      this._header();
    }
  }
  _header() { this._tx(withCS("MBH," + this.cfg.fields.join(","))); this.lastHeader = this.sim.t; }
  _tx(line) { this.bytes += line.length + 1; this.send(line); }

  stop(reason = "Stopped") {
    if (this.done) return;
    this.done = true; this.endReason = reason;
    if (this.cfg.protocol === "mb") this._tx(withCS("MBC,STOP"));
  }

  // Start time of a fault in sim seconds. Apogee and burnout use the real
  // events once they have happened, the ideal reference flight before that.
  _faultStart(fl) {
    const s = this.sim;
    const refT = fl.ref === "apogee" ? (s.apogee ? s.apogee.t : this.launchAt + (this.refTimes.apogee - this.refTimes.liftoff))
      : fl.ref === "burnout" ? (s.burnout[0] !== null ? s.burnout[0] : this.launchAt + (this.refTimes.burnout - this.refTimes.liftoff))
      : this.launchAt;
    return refT + Number(fl.offset || 0);
  }

  _faultActive(fl, t) {
    const T = FAULT_TYPES[fl.type];
    if (fl.whole || fl.ref === "whole" || T?.whole) return true;
    const t0 = this._faultStart(fl);
    if (T?.holds) return t >= t0;
    return t >= t0 && t < t0 + Number(fl.duration || 0);
  }

  // Advance simulated time to `target` seconds, sending samples on the way.
  advanceTo(target) {
    if (this.done) return;
    const dt = 1 / this.cfg.rate;
    while (!this.done && (this.sampleIdx + 1) * dt <= target + 1e-9) {
      if (!this.sim.launched && this.sim.t >= this.launchAt - 1e-9) { this.sim.launch(); this.onEvent({ type: "launch", t: this.sim.t }); }
      this._simFaults(this.sim.t);
      const evs = this.sim.step(dt);
      this.sampleIdx++;
      for (const e of evs) this.onEvent({ ...e, sim: true });
      this._restartTick();
      this.truth.t.push(this.sim.t); this.truth.h.push(this.sim.h); this.truth.v.push(this.sim.v); this.truth.phase.push(this.sim.phase);
      this.truth.x.push(this.sim.x); this.truth.y.push(this.sim.y);
      this.truth.tilt.push((this.sim.tilt || 0) / RAD); this.truth.brake.push(this.sim.brake || 0);
      this._sample();
      this._checkEnd();
    }
  }

  // Faults that act on the simulated rocket rather than its sensors.
  _simFaults(t) {
    let gust = [0, 0], held = false;
    for (const fl of this.faults) {
      if (fl.type === "gust" && this._faultActive(fl, t)) { const w = windVec(fl.params?.speed, fl.params?.from); gust = [gust[0] + w[0], gust[1] + w[1]]; }
      if (fl.type === "brake_stuck" && this._faultActive(fl, t)) held = true;
    }
    this.sim.gust = gust;
    this.sim.brakeHeld = held;
  }

  _sample() {
    const t = this.sim.t;
    const act = this.faults.filter((fl) => this._faultActive(fl, t));
    if (act.some((fl) => fl.type === "gap")) { this._sense(null); if (this.onSample) this.onSample(null, act); return; }
    let noise = { baroNoise: this.cfg.noise.baro, accelNoise: this.cfg.noise.accel, gyroNoise: this.cfg.noise.gyro, upAxis: this.cfg.axis.up, upSign: this.cfg.axis.sign, accelRange: 400 * G0 };
    for (const fl of act) {
      if (fl.type === "baro_noise") noise.baroNoise *= Number(fl.params.factor) || 1;
      if (fl.type === "accel_noise") noise.accelNoise *= Number(fl.params.factor) || 1;
      if (fl.type === "accel_clip") noise.accelRange = (Number(fl.params.limit) || 16) * G0;
      if (fl.type === "spin") noise.rollRate = Number(fl.params.rate) || 0;
    }
    const m = this.sim.measure(noise, this.R);
    const clip = (v) => Math.max(-noise.accelRange, Math.min(noise.accelRange, v));
    for (const fl of act) {
      const P = fl.params || {};
      if (fl.type === "baro_spike") m.p_pa += Number(P.delta) || 0;
      if (fl.type === "baro_drift") m.p_pa += ((Number(P.rate) || 0) / 60) * Math.max(0, Math.min(t - this._faultStart(fl), Number(fl.duration) || 0));
      if (fl.type === "accel_spike") { const k = "a" + this.cfg.axis.up; m[k] = clip(m[k] + (Number(P.g) || 0) * G0 * this.cfg.axis.sign); }
      const group = P.sensor === "accel" ? ["ax", "ay", "az"] : P.sensor === "gyro" ? ["gx", "gy", "gz"] : P.sensor === "gps" ? ["lat", "lon", "gps_alt"] : ["p_pa", "temp_c"];
      if (fl.type === "dropout") for (const k of group) m[k] = NaN;
      if (fl.type === "stuck") for (const k of group) { if (this.hold[k] === undefined) this.hold[k] = this.lastM?.[k]; m[k] = this.hold[k]; }
    }
    if (!act.some((fl) => fl.type === "stuck")) this.hold = {};
    this.lastM = m;
    this._sense(m);
    if (this.onSample) this.onSample(m, act);
    if (this.cfg.protocol === "mb") {
      // no header while the board restarts: it would start a new test instead of resuming
      if (!this.down && this.sim.t - this.lastHeader >= 2) this._header();
      this._tx(withCS("MBD," + this.cfg.fields.map((k) => FIELDS[k] ? FIELDS[k].fmt(m) : "").join(",")));
    } else {
      let line = this.cfg.template.replace(/\{(\w+)\}/g, (_, k) => (FIELDS[k] ? FIELDS[k].fmt(m) : ""));
      if (this.cfg.templateCS) line = line.startsWith("$") ? withCS(line.slice(1)) : `${line}*${checksum(line)}`;
      this._tx(line);
    }
    this.sent++;
  }

  _sense(m) {
    const up = "a" + this.cfg.axis.up;
    this.sensed.baro.push(m && Number.isFinite(m.p_pa) ? this.sim.atm.heightFromPressure(m.p_pa) : NaN);
    this.sensed.acc.push(m && Number.isFinite(m[up]) ? (m[up] * this.cfg.axis.sign) / G0 : NaN);
  }

  // Restart faults: ask the board to restart when one is due, and give up
  // waiting if it doesn't come back.
  _restartTick() {
    const t = this.sim.t;
    for (const fl of this.faults) {
      if (fl.type !== "reboot" || this.rebooted.has(fl) || t < this._faultStart(fl)) continue;
      this.rebooted.add(fl);
      if (this.down) continue;
      const r = { t, back: null, ack: null, cant: false, gaveUp: false };
      this.reboots.push(r);
      if (this.cfg.protocol !== "mb") { r.unsupported = true; this.onEvent({ type: "reboot", t, label: "Restart skipped: it needs the MockingbirdHIL protocol", bad: true }); continue; }
      this.down = r;
      this._tx(withCS("MBC,REBOOT"));
      this.onEvent({ type: "reboot", t, label: "Told the flight computer to restart" });
    }
    const d = this.down;
    if (d && (t - d.t) / Math.max(1, this.cfg.timeScale || 1) > 12) {
      d.gaveUp = true; this.down = null; this._header();
      this.onEvent({ type: "reboot", t, label: d.cant ? "The board can't restart itself" : d.ack ? "The board didn't come back after restarting" : "The board didn't restart", bad: true });
    }
  }

  // The board said READY during a test: it has just booted.
  _booted(t) {
    const resume = () => { this._tx(withCS(`MBC,RESUME,${this.cfg.rate},${this.cfg.timeScale}`)); this._header(); };
    if (this.down) {
      const d = this.down;
      d.back = t; this.down = null; resume();
      this.onEvent({ type: "rebootBack", t, label: `Flight computer back after ${(t - d.t).toFixed(1)} s of flight` });
    } else if (this.sim.liftoff === null) {
      // still on the pad (often the reset from opening the port): start cleanly
      this._tx(withCS(`MBC,START,${this.cfg.rate},${this.cfg.timeScale}`)); this._header();
    } else if (!this.heard) {
      // its first word this test: it was slow to start, not restarting
    } else {
      this.reboots.push({ t, back: t, unsolicited: true });
      resume();
      this.onEvent({ type: "reboot", t, label: "The flight computer restarted by itself", bad: true });
    }
  }

  _checkEnd() {
    const s = this.sim;
    if (s.landed && s.t - s.landed.t > 2) return this.stop("Landed");
    if (s.t > this.cfg.maxTime) return this.stop("Time limit reached");
    const allDone = this.expectations.every((e) => this.actions.some((a) => a.key === e.key && a.applied));
    const last = this.actions.length ? this.actions[this.actions.length - 1].t : 0;
    if (allDone && s.apogee && s.v < 0 && s.phase !== "descent" && s.t - Math.max(last, s.apogee.t) > this.cfg.endAfter) {
      // under a parachute with nothing left to do: remaining descent is predictable
      return this.stop("All expected actions happened");
    }
  }

  // A line from the flight computer.
  handleLine(line) {
    const t = this.sim.t;
    const s = line.trim();
    if (!s) return;
    if (!/^\$MBE,(READY|PONG)\b/i.test(s)) this.heard = true;
    let m;
    if ((m = s.match(/^\$MBA,(.*)$/))) {
      // control outputs: they move the simulated rocket
      const parts = m[1].split("*")[0].split(",");
      let last = null;
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const k = parts[i].trim(), v = Number(parts[i + 1]);
        if (!k || !Number.isFinite(v)) continue;
        (this.fcAct[k] ||= { t: [], v: [] });
        this.fcAct[k].t.push(t); this.fcAct[k].v.push(v);
        if (v < -0.01 || v > 1.01) this.actNotes.add(`${k} went to ${v}; send 0 (closed) to 1 (fully open), not servo degrees`);
        if (!this.sim.actuate(k, v)) this.actNotes.add(this.rocket.airbrakes?.enabled ? `"${k}" doesn't move anything; the airbrakes answer to "${this.rocket.airbrakes.name || "brake"}"` : `"${k}" doesn't move anything: this rocket has no airbrakes`);
        last = { name: k, value: v };
      }
      return { kind: "actuator", ...(last || {}) };
    }
    if ((m = s.match(/^\$MBT,(.*)$/))) {
      const parts = m[1].split("*")[0].split(",");
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const v = Number(parts[i + 1]);
        if (!Number.isFinite(v)) continue;
        const k = parts[i].trim();
        (this.fcTlm[k] ||= { t: [], v: [] });
        this.fcTlm[k].t.push(t); this.fcTlm[k].v.push(v);
      }
      return { kind: "tlm" };
    }
    if ((m = s.match(/^\$MBE,([^,*]+)(?:,([^*]*))?/))) {
      const name = m[1].trim().toUpperCase(), val = (m[2] ?? "").trim();
      if (name === "READY" || name === "PONG") {
        // READY: it just booted. PONG counts too after Mockingbird reopened a
        // port that dropped during a restart, since READY went out before that.
        if ((name === "READY" || (name === "PONG" && this.down?.reconnected)) && this.started && !this.done && this.cfg.protocol === "mb") this._booted(t);
        return { kind: "hello", text: val };
      }
      if (name === "RESTARTING" || name === "NORESTART") {
        if (this.down) { if (name === "RESTARTING") this.down.ack = t; else this.down.cant = true; }
        this.onEvent({ type: "fc", t, label: name === "RESTARTING" ? "Restarting" : "Can't restart itself", name, value: val });
        return { kind: "event" };
      }
      if (name === "STATS") { const [good, bad] = val.split(",").map(Number); this.fcStats = { good, bad }; return { kind: "stats", stats: this.fcStats }; }
      if (name === "PYRO") {
        // newer library versions add the sample time acted on (ms) and the processing time (µs)
        const [ch, ms, us] = val.split(",").map((x) => Number(x));
        return this._channel(ch, t, s, Number.isFinite(ms) ? { boardT: ms / 1000, procUs: Number.isFinite(us) ? us : null } : null);
      }
      const named = { DROGUE: () => this._actByKind(["drogue", "streamer"], t, name), MAIN: () => this._actByKind(["main", "chute"], t, name), CHUTE: () => this._actByKind(["chute", "main"], t, name),
        IGNITE: () => this._act({ type: "ignite", stage: this.sim.bottom + (this.sim.ign[this.sim.bottom] !== null ? 1 : 0) }, t, name), STAGE: () => this._act({ type: "ignite", stage: this.sim.bottom + (this.sim.ign[this.sim.bottom] !== null ? 1 : 0) }, t, name),
        SEPARATE: () => this._act({ type: "separate", stage: this.sim.bottom }, t, name) };
      if (named[name]) return named[name]();
      const ev = { t, name, value: val };
      this.fcEvents.push(ev);
      this.onEvent({ type: "fc", t, label: name === "STATE" ? `State: ${val}` : val ? `${name} ${val}` : name, name, value: val });
      return { kind: "event", ev };
    }
    if (s.startsWith("$MBL,")) return { kind: "log" };
    // custom rules for firmware that prints its own messages
    for (const r of this.cfg.rules || []) {
      let hit = false;
      try { hit = r.regex ? new RegExp(r.pattern, "i").test(s) : s.toLowerCase().includes(String(r.pattern).toLowerCase()); } catch { hit = false; }
      if (hit && r.action) return this._act(r.action, t, `rule "${r.pattern}"`);
    }
    return { kind: "other" };
  }

  _channel(ch, t, raw, timing = null) {
    const row = this.cfg.pyro.find((p) => Number(p.ch) === ch);
    if (!row || !row.action) {
      this.actions.push({ t, key: "ch:" + ch, label: `Pyro ${ch} (not assigned)`, applied: false, ch, source: raw });
      this.onEvent({ type: "action", t, label: `Pyro ${ch} fired (not assigned to anything)`, bad: true });
      return { kind: "action" };
    }
    return this._act(row.action, t, `pyro ${ch}`, ch, timing);
  }

  _actByKind(kinds, t, why) {
    const d = (this.rocket.recovery || []).find((x) => kinds.includes(x.kind) && this.sim.deployed[x.id] === undefined) || (this.rocket.recovery || []).find((x) => kinds.includes(x.kind));
    if (!d) { this.onEvent({ type: "action", t, label: `${why} reported but this rocket has no such device`, bad: true }); return { kind: "action" }; }
    return this._act({ type: "deploy", id: d.id }, t, why);
  }

  _act(action, t, why, ch, timing = null) {
    const key = action.type === "deploy" ? "deploy:" + action.id : action.type + ":" + action.stage;
    // a dud: the first channel fired for this device does nothing, every time
    let dud = false;
    if (this.dud && action.type === "deploy" && action.id === this.dud.id) {
      const c = ch ?? why;
      if (this.dud.ch === undefined) this.dud.ch = c;
      dud = this.dud.ch === c;
    }
    const applied = dud ? false : this.sim.command({ ...action, source: "flight computer" });
    const name = action.type === "deploy" ? (this.rocket.recovery.find((d) => d.id === action.id)?.name || action.id) + " deploy" : action.type === "ignite" ? `${this.rocket.stages[action.stage]?.name || "Stage " + action.stage} ignition` : `${this.rocket.stages[action.stage]?.name || "Stage"} separation`;
    const rec = { t, key, label: name, applied, ch, source: why, h: this.sim.h, v: this.sim.v, ...(dud ? { dud: true } : {}), ...(timing || {}) };
    this.actions.push(rec);
    this.onEvent({ type: "action", t, label: dud ? `${name} (${why}): the charge didn't go off` : `${name} (${why})`, applied, bad: dud || undefined, h: this.sim.h, v: this.sim.v });
    return { kind: "action", rec };
  }

  // ------------------------------------------------------------ grading
  report({ fmtAlt = (m) => `${m.toFixed(0)} m`, fmtVel = (v) => `${v.toFixed(0)} m/s` } = {}) {
    const s = this.sim, tol = this.cfg.tol;
    const L = s.liftoff ?? this.launchAt;
    const ap = s.apogee;
    const bo = s.burnout;
    const hAt = (tt) => { const i = this.truth.t.findIndex((x) => x >= tt); return i < 0 ? null : { h: this.truth.h[i], v: this.truth.v[i] }; };
    const tiltAt = (tt) => { const T = this.truth; if (!T.t.length) return 0; let i = T.t.findIndex((x) => x >= tt); if (i < 0) i = T.t.length - 1; return T.tilt[i] ?? 0; };
    const checks = [];
    const Tlab = (x) => `T${x - L >= 0 ? "+" : "−"}${Math.abs(x - L).toFixed(2)} s`;
    const signed = (x, f) => { const s = f(Math.abs(x)); return /^0(\D|$)/.test(s) ? s : (x >= 0 ? "+" : "−") + s; };
    const chName = (x) => (x.ch != null ? `pyro ${x.ch}` : x.source);
    for (const e of this.expectations) {
      const acts = this.actions.filter((a) => a.key === e.key);
      // the firing that counts is the first one whose charge worked; after a
      // dud that is a backup, which gets a wider window
      const duds = acts.filter((x) => x.dud), live = acts.filter((x) => !x.dud);
      const a = live.find((x) => x.applied) || live[0];
      const backup = !!(a && duds.length);
      const late = tol.apogeeLate + (backup ? tol.backupLate : 0);
      const c = { label: e.label, ok: false, expected: "", actual: "", detail: "", ch: a?.ch ?? e.ch };
      if (e.type === "deploy") {
        if (e.rule === "apogee") {
          c.expected = e.delay ? `${e.delay} s after apogee` : "at apogee";
          if (!ap) { c.detail = "The rocket never reached apogee in the test."; }
          else {
            const target = ap.t + e.delay;
            c.target = target;
            if (!a) c.actual = "never fired";
            else {
              const err = a.t - target;
              c.actual = `${err >= 0 ? "+" : "−"}${Math.abs(err).toFixed(2)} s`;
              c.ok = err >= -tol.apogeeEarly && err <= late && !(a.t < ap.t && a.v > 15);
              if (a.t < ap.t && a.v > 15) c.detail = `Fired while still climbing at ${fmtVel(a.v)}.`;
              else if (!c.ok) c.detail = err < 0 ? `Fired ${(-err).toFixed(2)} s early (allowed ${tol.apogeeEarly} s).` : `Fired ${err.toFixed(2)} s late (allowed ${late} s${backup ? " for a backup" : ""}).`;
            }
          }
        } else if (e.rule === "altitude") {
          const low = ap && ap.h < e.altitude; // never got that high: it should fire as soon as the rocket heads down
          if (ap) {
            if (low) c.target = ap.t;
            else { const i = this.truth.t.findIndex((x, k) => x > ap.t && this.truth.h[k] <= e.altitude); if (i >= 0) c.target = this.truth.t[i]; }
          }
          c.expected = low ? `right after apogee (apogee ${fmtAlt(ap.h)} was below ${fmtAlt(e.altitude)})` : `at ${fmtAlt(e.altitude)} on the way down`;
          if (!a) c.actual = "never fired";
          else if (low) {
            const err = a.t - ap.t;
            c.actual = `${err >= 0 ? "+" : "−"}${Math.abs(err).toFixed(2)} s after apogee`;
            c.ok = err >= -tol.apogeeEarly && err <= tol.apogeeLate + 1;
            if (!c.ok) c.detail = err < 0 ? "Fired before apogee." : `Fired ${err.toFixed(1)} s after apogee. With an apogee this low it should fire as soon as the rocket starts down.`;
          } else {
            const allowed = Math.max(tol.altitudeMin, tol.altitudeFrac * e.altitude);
            const allowedLow = backup ? Math.max(allowed, tol.backupAltFrac * e.altitude) : allowed;
            const off = a.h - e.altitude;
            c.actual = `at ${fmtAlt(a.h)}${a.v > 0 ? " going up" : ""}`;
            c.ok = !!ap && a.t > ap.t && off <= allowed && -off <= allowedLow;
            if (!c.ok) c.detail = !ap || a.t <= ap.t ? "Fired before apogee." : `${fmtAlt(Math.abs(off))} ${off < 0 ? "low" : "high"} (allowed ${fmtAlt(off < 0 ? allowedLow : allowed)}${backup && off < 0 ? " for a backup" : ""}).`;
          }
        } else if (e.rule === "timer") {
          c.expected = `${e.time} s after liftoff`;
          c.target = L + e.time;
          if (!a) c.actual = "never fired";
          else { const err = a.t - (L + e.time); c.actual = `${err >= 0 ? "+" : "−"}${Math.abs(err).toFixed(2)} s`; c.ok = err >= -tol.timer && err <= tol.timer + (backup ? tol.backupLate : 0); }
        }
      } else if (e.type === "ignite") {
        c.expected = `${e.delay} s after ${this.rocket.stages[e.stage - 1].name.toLowerCase()} burnout`;
        const prevBo = bo[e.stage - 1];
        if (prevBo !== null) c.target = prevBo + e.delay;
        // tilt lockout: past the limit when it's due, the stage must not be lit
        const limit = Number(this.rocket.stages[e.stage]?.maxTilt) > 0 ? Number(this.rocket.stages[e.stage].maxTilt) : DEFAULT_TILT_LIMIT;
        const tiltDue = prevBo !== null && !this.replay ? tiltAt(prevBo + e.delay) : null;
        const sName = (this.rocket.stages[e.stage]?.name || "upper stage").toLowerCase();
        if (tiltDue !== null && tiltDue > limit + tol.tiltMargin) {
          c.expected = `held off (${tiltDue.toFixed(0)}° from vertical, limit ${limit}°)`;
          if (!a) { c.ok = true; c.actual = "held off"; }
          else { c.actual = `lit at ${tiltAt(a.t).toFixed(0)}°`; c.detail = `It lit the ${sName} while the rocket was ${tiltAt(a.t).toFixed(0)}° from vertical; the limit is ${limit}°. Check the tilt (from the gyros) before lighting an upper stage.`; }
        } else if (!a) {
          c.actual = "never fired";
          // restarted around the time it was due: not lighting is the safe choice
          const due = prevBo !== null ? prevBo + e.delay : null;
          const rebootNear = due !== null && this.reboots.some((r) => r.t <= due + tol.igniteLate && (r.back == null || r.back >= prevBo));
          if (rebootNear) { c.ok = true; c.actual = "held off"; c.detail = "It restarted around the time this stage was due and didn't light it, which is the safe choice."; }
          else if (tiltDue !== null && tiltDue > limit - tol.tiltMargin) { c.ok = true; c.actual = "held off"; c.detail = `The rocket was ${tiltDue.toFixed(0)}° from vertical, right at the ${limit}° limit, so holding off is fine.`; }
          else if (tiltDue !== null && tiltDue > 3) c.detail = `The rocket was only ${tiltDue.toFixed(0)}° from vertical (limit ${limit}°).`;
        }
        else if (prevBo === null) { c.actual = "fired"; c.detail = "The stage below never burned out in the test."; }
        else {
          const err = a.t - (prevBo + e.delay);
          c.actual = `${err >= 0 ? "+" : "−"}${Math.abs(err).toFixed(2)} s`;
          c.ok = err >= -tol.igniteEarly && err <= tol.igniteLate && a.t >= prevBo && (!ap || a.t < ap.t);
          if (a.t < prevBo) c.detail = "Fired while the stage below was still burning.";
          else if (ap && a.t >= ap.t) c.detail = "Fired after apogee: an upper stage must never light on the way down.";
          else if (!c.ok) c.detail = `Outside the window (−${tol.igniteEarly} s to +${tol.igniteLate} s).`;
          if (a.v < 15 && c.ok) c.detail = `Lit at only ${fmtVel(a.v)}; check the delay.`;
          const tl = tiltAt(a.t);
          if (tl > 5 && !this.replay) c.detail = [c.detail, `Lit at ${tl.toFixed(0)}° from vertical (limit ${limit}°).`].filter(Boolean).join(" ");
        }
      } else if (e.type === "separate") {
        c.expected = "after burnout, before apogee";
        if (!a) c.actual = "never fired";
        else { c.actual = `T+${(a.t - L).toFixed(2)} s`; c.ok = bo[e.stage] !== null && a.t >= bo[e.stage] && (!ap || a.t < ap.t); }
      }
      // notes on duds, backups and repeats
      const notes = [];
      if (duds.length && !a) {
        c.ok = false; c.actual = "charge didn't go off";
        notes.push(`${chName(duds[0])} fired at ${Tlab(duds[0].t)} but its charge failed, and nothing else fired for it. Add a backup channel for this on the Flight computer tab and have the firmware fire it too.`);
      } else if (backup) notes.push(`${chName(duds[0])}'s charge didn't go off; the backup on ${chName(a)} fired at ${Tlab(a.t)}.`);
      else {
        const others = [...new Set(live.filter((x) => x !== a && chName(x) !== chName(a)).map(chName))];
        if (others.length) notes.push(`Backup on ${others.join(", ")} also fired.`);
      }
      const per = {};
      for (const x of acts) per[chName(x)] = (per[chName(x)] || 0) + 1;
      for (const [k, n] of Object.entries(per)) if (n > 1) notes.push(`${k[0].toUpperCase() + k.slice(1)} fired ${n} times.`);
      if (notes.length) c.detail = [c.detail, ...notes.map((x) => x[0].toUpperCase() + x.slice(1))].filter(Boolean).join(" ");
      if (a) { c.firedAt = a.t; c.firedH = a.h; c.boardT = a.boardT; c.procUs = a.procUs; if (Number.isFinite(c.target)) c.err = a.t - c.target; }
      if (e.type === "deploy" && e.rule === "altitude" && a) c.errAlt = a.h - e.altitude;
      checks.push(c);
    }
    const unexpected = this.actions.filter((a) => !this.expectations.some((e) => e.key === a.key));
    for (const u of unexpected) checks.push({ label: u.label, ok: false, expected: "not expected", actual: `T+${(u.t - L).toFixed(2)} s`, detail: "The flight computer did something the plan doesn't include." });

    // restarts
    const scale = Math.max(1, this.cfg.timeScale || 1);
    for (const r of this.reboots) {
      if (r.unsolicited) { checks.push({ label: "Unexpected restart", ok: false, expected: "no restarts", actual: Tlab(r.t), detail: "The flight computer restarted by itself in flight. Look for a brownout when a pyro fires, a watchdog timeout, or a crash." }); continue; }
      const c = { label: "Restart", expected: `back within ${tol.restartBack} s of flight`, ok: false, actual: "", detail: "" };
      if (r.unsupported) { c.actual = "not tested"; c.detail = "Restart tests need the MockingbirdHIL protocol, not a custom line format."; }
      else if (r.back == null) {
        c.actual = "never came back";
        c.detail = r.cant ? "The library doesn't know how to restart this board. Define mbRestart() in your sketch to restart it."
          : r.ack ? "It started restarting but never said READY again. Check that setup() calls hil.begin() and doesn't wait on anything that isn't there in a test."
          : "It didn't restart. MockingbirdHIL 1.2 or newer restarts the board when asked; older versions ignore the request.";
      } else {
        // flight time missed is what matters; at 2× speed a 1 s boot misses 2 s
        const gone = r.back - r.t;
        c.actual = `back after ${gone.toFixed(1)} s`;
        c.ok = gone <= tol.restartBack;
        if (!c.ok) c.detail = `It was gone for ${gone.toFixed(1)} s of flight${scale > 1 ? ` (a ${(gone / scale).toFixed(1)} s boot at ${scale}× speed; run at 1× for real timing)` : ""}. The rocket moved ${fmtAlt(Math.abs((hAt(r.t)?.h ?? 0) - (hAt(r.back)?.h ?? 0)))} meanwhile.`;
        // what it thought it was doing once it was back
        const st = this.fcEvents.find((ev) => ev.t >= r.back && ev.name === "STATE");
        if (st && /pad|idle|ground|init|boot|ready|arm|wait|standby/i.test(st.value)) {
          c.detail = [c.detail, `Once back it said ${st.value}: it forgot it was flying. Save the flight phase and ground pressure to EEPROM or flash when they change, and read them back in setup().`].filter(Boolean).join(" ");
          r.forgot = st.value;
        } else if (st) r.resumedAs = st.value;
        else if (this.expectations.some((e) => !this.actions.some((a) => a.key === e.key && a.t >= r.back) && !this.actions.some((a) => a.key === e.key && a.t < r.t))) {
          // silent since it came back, and something still due never fired
          c.detail = [c.detail, "Nothing it should have fired after the restart fired: it probably forgot it was flying. Save the flight phase and ground pressure to EEPROM or flash when they change, and read them back in setup()."].filter(Boolean).join(" ");
          r.forgot = "unknown";
        }
      }
      checks.push(c);
    }

    // airbrakes: shut while a motor burns, and apogee on the target
    const AB = this.rocket.airbrakes;
    const airbrake = AB?.enabled && !this.replay ? this._airbrakes(s, ap, L, tol, fmtAlt, Tlab, signed) : null;
    if (airbrake) checks.push(...airbrake.checks);

    // the board's own altitude and speed against the truth
    const est = this._scoreEstimates(L, ap, s);
    if (est && tol.gradeEstimates !== false) {
      if (est.alt) {
        const allowed = Math.max(tol.estAlt, tol.estAltFrac * (ap?.h || s.maxH || 0));
        const e = est.alt, peak = Number.isFinite(e.peakErr) ? e.peakErr : 0;
        const c = { label: "Altitude estimate", expected: `within ${fmtAlt(allowed)}`, actual: `typical ${fmtAlt(e.rms)} off, peak ${signed(peak, fmtAlt)}`, ok: e.rms <= allowed && Math.abs(peak) <= allowed, detail: "" };
        // the standard-atmosphere formula assumes 15 °C, so on a warm day every
        // barometric altimeter reads low by about the same fraction
        const tK = (this.site.tempC ?? 15) + 273.15, expect = 288.15 / tK;
        const tempLike = Math.abs(e.ratio - 1) > 0.01 && Math.abs(e.ratio - expect) < 0.012;
        if (e.units) c.detail = `Its numbers are about ${e.units.toFixed(2)}× the true altitude. Send metres in hil.telemetry(), not feet.`;
        else if (!c.ok) c.detail = e.rms > allowed ? `Its altitude was ${fmtAlt(e.rms)} off on average (worst ${fmtAlt(e.max)} at ${Tlab(e.maxAt)}).` : `It read the peak as ${fmtAlt(e.peak)}; the true apogee was ${fmtAlt(ap.h)}.`;
        if (!e.units && tempLike) c.detail = [c.detail, `It reads ${Math.abs((1 - e.ratio) * 100).toFixed(1)}% ${e.ratio < 1 ? "low" : "high"} all flight, which is what the standard atmosphere does at ${(this.site.tempC ?? 15).toFixed(0)} °C. Correcting with the pad temperature fixes it.`].filter(Boolean).join(" ");
        checks.push(c);
      }
      if (est.vel) {
        const allowed = Math.max(tol.estVel, tol.estVelFrac * (s.maxV || 0));
        const e = est.vel;
        const c = { label: "Speed estimate", expected: `within ${fmtVel(allowed)}`, actual: `typical ${fmtVel(e.rms)} off`, ok: e.rms <= allowed, detail: "" };
        if (e.units) c.detail = `Its numbers are about ${e.units.toFixed(2)}× the true speed. Send m/s in hil.telemetry(), not ft/s.`;
        else if (!c.ok) c.detail = `Its speed was ${fmtVel(e.rms)} off on average (worst ${fmtVel(e.max)} at ${Tlab(e.maxAt)}).`;
        checks.push(c);
      }
    }

    // what the FC said it detected
    const det = [];
    const fcAp = this.fcEvents.find((e) => e.name === "APOGEE");
    if (fcAp && ap) det.push({ label: "Apogee detection", value: `${fcAp.t - ap.t >= 0 ? "+" : "−"}${Math.abs(fcAp.t - ap.t).toFixed(2)} s after true apogee` });
    const fcLaunch = this.fcEvents.find((e) => e.name === "LAUNCH" || (e.name === "STATE" && /boost|launch|flight|ascent/i.test(e.value)));
    if (fcLaunch && s.liftoff !== null) {
      const d = fcLaunch.t - s.liftoff;
      det.push({ label: "Launch detection", value: d < 0 ? `${(-d).toFixed(2)} s before liftoff` : `${d.toFixed(2)} s after liftoff` });
      // Thinking it has launched while still on the pad is how charges fire on the pad.
      if (d < -0.05) checks.unshift({ label: "Launch detection", ok: false, expected: "at liftoff", actual: `${(-d).toFixed(2)} s before liftoff`, detail: "It decided it had launched while still sitting on the pad. With live charges, timers and deployments would start from the wrong moment." });
    }
    const fcBo = this.fcEvents.find((e) => e.name === "BURNOUT" || (e.name === "STATE" && /coast/i.test(e.value)));
    if (fcBo && bo[0] !== null) det.push({ label: "Burnout detection", value: `${(fcBo.t - bo[0]).toFixed(2)} s after burnout` });
    const fcLand = this.fcEvents.find((e) => e.name === "LANDED" || (e.name === "STATE" && /land/i.test(e.value)));
    if (fcLand && s.landed) det.push({ label: "Landing detection", value: `${(fcLand.t - s.landed.t).toFixed(2)} s after touchdown` });
    if (est?.alt) det.push({ label: "Its altitude", value: `typically ${fmtAlt(est.alt.rms)} off${Number.isFinite(est.alt.peakErr) ? `; peak read as ${fmtAlt(est.alt.peak)} (${signed(est.alt.peakErr, fmtAlt)})` : ""}` });
    if (est?.vel) det.push({ label: "Its speed", value: `typically ${fmtVel(est.vel.rms)} off, worst ${fmtVel(est.vel.max)}` });
    if (!est && this.cfg.protocol === "mb" && !this.replay) det.push({ label: "Its altitude and speed", value: "not sent, so not scored. Send them with hil.telemetry(\"alt\", …, \"vel\", …) in metres and m/s." });
    if (!this.replay && s.maxTilt > 2 * RAD) det.push({ label: "Tilt", value: `up to ${(s.maxTilt / RAD).toFixed(0)}° from vertical under power${ap && tiltAt(ap.t) > 30 ? `, ${tiltAt(ap.t).toFixed(0)}° at apogee` : ""}` });
    if (airbrake) det.push(...airbrake.det);
    for (const n of this.actNotes) det.push({ label: "Control output", value: n });
    for (const r of this.reboots) if (!r.unsupported && r.back != null) det.push({ label: r.unsolicited ? "Restarted by itself" : "Restart", value: `${Tlab(r.t)}${r.unsolicited ? "" : `, back after ${(r.back - r.t).toFixed(1)} s`}${r.resumedAs ? `, carried on in ${r.resumedAs}` : r.forgot && r.forgot !== "unknown" ? `, came back in ${r.forgot}` : ""}` });

    // outcome: if the run ended early under a parachute, finish the descent offline to report landing speed
    let landing = s.landed ? Math.abs(s.events.find((e) => e.type === "landing")?.impact ?? 0) : null;
    let projected = false;
    if (landing === null && s.apogee) {
      const g = Object.assign(Object.create(Object.getPrototypeOf(s)), s);
      g.deployed = { ...s.deployed }; g.events = [...s.events]; g._newEvents = [];
      while (!g.landed && g.t < s.t + 900) g._substep(0.01);
      if (g.landed) { landing = Math.abs(g.events.find((e) => e.type === "landing")?.impact ?? 0); projected = true; }
    }
    // a replay lands however the real flight landed, whatever the board did
    const outcome = { apogee: s.maxH, apogeeTime: ap ? ap.t - L : null, maxVelocity: s.maxV, landingSpeed: landing, landingProjected: projected, hardLanding: !this.replay && landing !== null && landing > tol.safeLanding, replay: this.replay ? this.replay.name || "log" : null,
      target: Number(this.rocket.targetApogee) > 0 && !this.replay ? Number(this.rocket.targetApogee) : null, maxTilt: s.maxTilt / RAD };

    // pyro timing: when each output should have fired, which sample the board
    // acted on, how long it took to fire after reading it, and the link delay
    const pyroTiming = checks.filter((c) => Number.isFinite(c.target) && Number.isFinite(c.firedAt)).map((c) => ({
      label: c.label, ch: c.ch, target: c.target - L, fired: c.firedAt - L,
      decisionMs: ((Number.isFinite(c.boardT) ? c.boardT : c.firedAt) - c.target) * 1000,
      processingUs: Number.isFinite(c.procUs) ? c.procUs : null,
      linkMs: Number.isFinite(c.boardT) ? Math.max(0, ((c.firedAt - c.boardT) * 1000) / (this.cfg.timeScale || 1)) : null,
      fromBoard: Number.isFinite(c.boardT),
    }));
    const pass = checks.length > 0 && checks.every((c) => c.ok) && !outcome.hardLanding;
    return {
      verdict: pass ? "pass" : "fail", checks, detections: det, outcome, endReason: this.endReason,
      actions: this.actions.map((a) => ({ ...a, t: a.t - L })), fcEvents: this.fcEvents.map((e) => ({ ...e, t: e.t - L })),
      samples: this.sent, faults: this.faults, liftoff: L, boardStats: this.fcStats || null, pyroTiming,
      estimates: est, reboots: this.reboots.map((r) => ({ ...r, t: r.t - L, back: r.back == null ? null : r.back - L, ack: r.ack == null ? null : r.ack - L })),
    };
  }

  // Airbrake checks: closed under power, and apogee on the target (when the
  // rocket has one), judged fairly when the target was out of reach.
  _airbrakes(s, ap, L, tol, fmtAlt, Tlab, signed) {
    const T = this.truth, checks = [], det = [];
    const burns = [];
    s.ign.forEach((ig, k) => { if (ig !== null) burns.push([ig, s.burnout[k] ?? Infinity]); });
    const lastBo = Math.max(...s.burnout.filter((x) => x !== null), -Infinity);
    let early = null, maxCoast = 0, sumCoast = 0, nCoast = 0, firstOpen = null, maxAll = 0;
    for (let i = 0; i < T.t.length; i++) {
      const x = T.t[i], b = T.brake[i] || 0;
      if (b > maxAll) maxAll = b;
      if (b > 0.05 && firstOpen === null) firstOpen = x;
      if (b > 0.05 && early === null && burns.some(([a0, a1]) => x >= a0 && x <= a1)) early = { t: x, b };
      if (Number.isFinite(lastBo) && x > lastBo && (!ap || x <= ap.t)) { maxCoast = Math.max(maxCoast, b); sumCoast += b; nCoast++; }
    }
    const avgCoast = nCoast ? sumCoast / nCoast : 0;
    const pct = (x) => `${Math.round(x * 100)}%`;
    checks.push(early
      ? { label: "Airbrakes under power", ok: false, expected: "closed while a motor burns", actual: `${pct(early.b)} open at ${Tlab(early.t)}`, detail: "Opening the brakes during boost wastes the motor and loads them hard. Wait for burnout." }
      : { label: "Airbrakes under power", ok: true, expected: "closed while a motor burns", actual: "closed", detail: "" });
    const sent = Object.keys(this.fcAct).length > 0;
    const target = Number(this.rocket.targetApogee) || 0;
    const jammed = this.faults.some((f) => f.type === "brake_stuck");
    if (target > 0 && ap) {
      const allowed = Math.max(tol.targetMin, tol.targetFrac * target);
      const err = ap.h - target;
      const c = { label: "Apogee target", expected: `${fmtAlt(target)} ± ${fmtAlt(allowed)}`, actual: `${fmtAlt(ap.h)} (${signed(err, fmtAlt)})`, ok: Math.abs(err) <= allowed, detail: "", errAlt: err };
      if (jammed) { c.ok = true; c.actual += ", not graded"; c.detail = "The airbrakes were jammed in this test."; }
      else if (err < -allowed) {
        if (maxCoast <= 0.05) { c.ok = true; c.detail = "Short of the target even with the brakes shut: the motor or the rocket can't reach it."; }
        else c.detail = `${fmtAlt(-err)} short with the brakes open up to ${pct(maxCoast)}: they opened too far or too early.`;
      } else if (err > allowed) {
        if (avgCoast >= 0.9) { c.ok = true; c.detail = "Over the target even with the brakes fully open all through the coast."; }
        else c.detail = `${fmtAlt(err)} over with the brakes open ${pct(avgCoast)} on average during the coast.${sent ? "" : " The board never sent a brake command ($MBA,brake,…)."}`;
      }
      checks.push(c);
    }
    det.push({ label: "Airbrakes", value: maxAll > 0.01 ? `open up to ${pct(maxAll)}, first at ${Tlab(firstOpen)}; ${pct(avgCoast)} on average in the coast` : sent ? "commanded but never opened" : "never commanded" });
    return { checks, det };
  }

  // Compare the board's altitude and speed (from hil.telemetry) with the
  // truth from liftoff to touchdown, leaving out short faults and restarts,
  // which are there to throw it off. Values are in metres and m/s.
  _scoreEstimates(L, ap, s) {
    const T = this.truth;
    if (!T.t.length || s.liftoff === null) return null;
    const end = s.landed ? s.landed.t : T.t[T.t.length - 1];
    const skip = [];
    for (const fl of this.faults) {
      if (!EVENT_FAULTS.has(fl.type) || FAULT_TYPES[fl.type]?.whole || fl.ref === "whole") continue;
      const t0 = this._faultStart(fl);
      skip.push([t0, t0 + Number(fl.duration || 0) + 1.5]);
    }
    for (const r of this.reboots) skip.push([r.t, r.back == null ? Infinity : r.back + 2]);
    const skipped = (x) => skip.some(([a, b]) => x >= a && x <= b);
    let k = 0;
    const truthAt = (x, arr) => {
      if (x <= T.t[0]) return arr[0];
      while (k > 0 && T.t[k] > x) k--;
      while (k < T.t.length - 2 && T.t[k + 1] <= x) k++;
      const f = (x - T.t[k]) / ((T.t[k + 1] - T.t[k]) || 1);
      return arr[k] + (arr[k + 1] - arr[k]) * Math.max(0, Math.min(1, f));
    };
    const lag = 1 / this.cfg.rate;   // it answers the sample before the one being sent
    const score = (re, arr) => {
      const name = Object.keys(this.fcTlm).find((n) => re.test(n));
      if (!name) return null;
      const ser = this.fcTlm[name];
      let n = 0, sq = 0, max = 0, maxAt = null, peak = -Infinity;
      const ratios = [];
      k = 0;
      for (let i = 0; i < ser.t.length; i++) {
        const x = ser.t[i];
        if (x < s.liftoff || x > end) continue;
        const v = ser.v[i], tv = truthAt(x - lag, arr);
        if (skipped(x)) continue;
        if (v > peak) peak = v;
        const err = v - tv;
        n++; sq += err * err;
        if (Math.abs(err) > max) { max = Math.abs(err); maxAt = x; }
        if (Math.abs(tv) > 20) ratios.push(v / tv);
      }
      if (n < 10) return null;
      ratios.sort((a, b) => a - b);
      const mid = ratios.length ? ratios[ratios.length >> 1] : 1;
      return { name, n, rms: Math.sqrt(sq / n), max, maxAt, peak, ratio: mid, units: Math.abs(mid - 3.2808) < 0.3 ? mid : null };
    };
    const alt = score(FC_ALT, T.h), vel = score(FC_VEL, T.v);
    if (alt && ap) alt.peakErr = alt.peak - ap.h;
    return alt || vel ? { alt, vel } : null;
  }

  // flight data for saving (Heron can open it)
  csv() {
    const L = this.sim.liftoff ?? this.launchAt;
    const names = Object.keys(this.fcTlm), acts = Object.keys(this.fcAct);
    const head = ["time_s", "alt_m", "vel_mps", "phase", "sensed_baro_alt_m", "sensed_accel_g", "east_m", "north_m", "tilt_deg", "airbrake", ...names.map((n) => `fc_${n}`), ...acts.map((n) => `act_${n}`)];
    const rows = [head.join(",")];
    const idx = Object.fromEntries([...names.map((n) => ["t:" + n, 0]), ...acts.map((n) => ["a:" + n, 0])]);
    const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : "");
    const latest = (key, s, t) => { while (idx[key] + 1 < s.t.length && s.t[idx[key] + 1] <= t) idx[key]++; return s.t.length && s.t[idx[key]] <= t ? s.v[idx[key]] : ""; };
    for (let i = 0; i < this.truth.t.length; i++) {
      const t = this.truth.t[i];
      const fc = names.map((n) => latest("t:" + n, this.fcTlm[n], t));
      const ac = acts.map((n) => latest("a:" + n, this.fcAct[n], t));
      rows.push([(t - L).toFixed(3), this.truth.h[i].toFixed(2), this.truth.v[i].toFixed(2), this.truth.phase[i], fx(this.sensed.baro[i], 2), fx(this.sensed.acc[i], 3), fx(this.truth.x[i], 2), fx(this.truth.y[i], 2), fx(this.truth.tilt[i], 2), fx(this.truth.brake[i], 3), ...fc, ...ac].join(","));
    }
    return rows.join("\n") + "\n";
  }
}

// ---------------------------------------------------------------- virtual FC
// A reference dual-deploy / staging flight computer that speaks the protocol,
// built from the rocket profile. It mirrors the example Arduino sketch, and
// also shows what the sketch leaves out: backup charges (any extra pyro
// channel set for a device fires a little later), surviving a restart (it
// keeps its flight phase in "EEPROM" that a restart doesn't clear), a tilt
// estimate from the gyros that holds an upper stage past its tilt limit, and
// an airbrake controller that aims for the target apogee.
export class VirtualFC {
  constructor({ rocket, pyro, upAxis = "z", upSign = 1, send }) {
    this.send = send;
    this.upAxis = upAxis; this.upSign = upSign;
    const chs = (pred) => pyro.filter((p) => p.action && pred(p.action)).map((p) => p.ch);
    const ch = (pred) => chs(pred)[0];
    const devs = rocket.recovery || [];
    const drogue = devs.find((d) => d.deploy === "apogee");
    const main = devs.find((d) => d.deploy === "altitude");
    const dCh = drogue ? chs((a) => a.type === "deploy" && a.id === drogue.id) : [];
    const mCh = main ? chs((a) => a.type === "deploy" && a.id === main.id) : [];
    this.plan = {
      drogueCh: dCh[0] ?? null, drogueBackup: dCh.slice(1), drogueDelay: drogue?.delay || 0,
      mainCh: mCh[0] ?? null, mainBackup: mCh.slice(1), mainAlt: main?.altitude ?? 150,
      stages: rocket.stages.map((s, k) => (k > 0 && s.ignition !== "direct" ? { ch: ch((a) => a.type === "ignite" && a.stage === k), delay: s.ignitionDelay || 0, maxTilt: Number(s.maxTilt) > 0 ? Number(s.maxTilt) : DEFAULT_TILT_LIMIT, name: s.name } : null)).filter(Boolean),
    };
    // what the airbrake controller knows about the rocket after burnout
    const ab = rocket.airbrakes;
    if (ab?.enabled && Number(rocket.targetApogee) > 0) {
      const top = rocket.stages[rocket.stages.length - 1];
      const D = Math.max(...rocket.stages.map((s) => s.diameter || 0.05));
      const motorEmpty = (s) => ((s.motor?.totalMass || 0) - (s.motor?.propMass || 0)) * (s.motorCount || 1);
      this.plan.brake = {
        name: ab.name || "brake", target: Number(rocket.targetApogee),
        mass: top.dryMass + motorEmpty(top), cdA: (top.cd || 0.5) * Math.PI * (D / 2) ** 2, cdAb: (ab.cd ?? 1.2) * (ab.area ?? 0.003),
      };
    }
    this.upIdx = { x: 0, y: 1, z: 2 }[upAxis] ?? 2;
    this.map = []; this.active = false;
    this.nvm = null;        // survives a restart, like EEPROM
    this.booting = null;
    this.reset();
    // it "boots" before the test starts, like a board after the port opens
    this.send("$MBE,READY,Virtual flight computer");
  }
  // what a restart must not forget
  _save() { this.nvm = { phase: this.phase, p0: this.p0, tPad: this.tPad, launchT: this.launchT, burnT: this.burnT, apT: this.apT, stageIdx: this.stageIdx, maxAlt: this.maxAlt, fired: { ...this.fired } }; }
  reset() {
    Object.assign(this, { phase: "PAD", candT: null, candAlt: 0, pushT: 0, pushLast: 0, p0: null, padN: 0, alt: 0, vel: 0, est: 0, maxAlt: 0, lastT: null, launchT: null, burnT: null, apT: null,
      fired: {}, below: 0, stageIdx: 0, landT: null, n: 0, accUp: 9.81, boostN: 0,
      R: null, accPad: [0, 0, 9.81], tilt: 0, held: {}, brake: 0, brakeSentT: -1, rho: 1.2, vCtl: null, hCtl: null, tPad: null });
  }
  receive(line) {
    const m = line.match(/^\$(MB[CHD]),(.*?)(?:\*([0-9A-F]{2}))?$/i);
    if (!m) return;
    if (m[3] && checksum(`${m[1]},${m[2]}`) !== m[3].toUpperCase()) return;
    const parts = m[2].split(",");
    if (this.booting) {
      // restarting: deaf for a second of test time (the samples are only a clock here)
      const i = this.map.indexOf("t_ms");
      const t = m[1] === "MBD" && i >= 0 ? Number(parts[i]) / 1000 : NaN;
      if (Number.isFinite(t)) {
        this.booting.at ??= t;
        if (t - this.booting.at >= 1.0) this._boot();
      }
      return;
    }
    if (m[1] === "MBC") {
      if (parts[0] === "START") { this.active = true; this.nvm = null; this.reset(); }
      else if (parts[0] === "RESUME") this.active = true;
      else if (parts[0] === "STOP") this.active = false;
      else if (parts[0] === "PING") this.send("$MBE,PONG,Virtual flight computer");
      else if (parts[0] === "REBOOT") { this.send("$MBE,RESTARTING"); this.active = false; this.booting = { at: null }; }
    } else if (m[1] === "MBH") this.map = parts;
    else if (m[1] === "MBD" && this.active) {
      const s = {};
      this.map.forEach((k, i) => { s[k] = parts[i] === "" ? NaN : Number(parts[i]); });
      this.step(s);
    }
  }
  // Tilt from the gyros: on the pad, gravity gives the starting attitude;
  // from launch, the body rates turn it (R maps board axes to the world).
  _attitude(s, dt) {
    const acc = ["x", "y", "z"].map((k) => (Number.isFinite(s[`a${k}_g`]) ? s[`a${k}_g`] * 9.80665 : s[`a${k}`]));
    if (this.phase === "PAD") {
      // learn which way is down only while it's sitting still (about 1 g);
      // under thrust the accelerometer reads the motor, not gravity
      const mag = acc.every(Number.isFinite) ? Math.hypot(...acc) : NaN;
      if (mag > 0.85 * 9.81 && mag < 1.15 * 9.81) for (let i = 0; i < 3; i++) this.accPad[i] += (acc[i] - this.accPad[i]) * 0.05;
      this.R = null;
      const g = this.accPad, n = Math.hypot(...g) || 1;
      this.tilt = (Math.acos(Math.max(-1, Math.min(1, (g[this.upIdx] * this.upSign) / n))) * 180) / Math.PI;
      return;
    }
    if (!this.R) {
      // world z (up) in board axes is where gravity pushed on the pad
      const z = this.accPad.map((v) => v / (Math.hypot(...this.accPad) || 1));
      let x = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
      x = x.map((v, i) => v - d * z[i]); const nx = Math.hypot(...x); x = x.map((v) => v / nx);
      const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      this.R = [x, y, z];   // rows: world axes in board coordinates
    }
    const w = ["gx", "gy", "gz"].map((k) => ((Number(s[k]) || 0) * Math.PI) / 180);
    // R ← R (I + [w]× dt), then tidy it back to a rotation
    const R = this.R.map((r) => [r[0] + (r[1] * w[2] - r[2] * w[1]) * dt, r[1] + (r[2] * w[0] - r[0] * w[2]) * dt, r[2] + (r[0] * w[1] - r[1] * w[0]) * dt]);
    const nz = Math.hypot(...R[2]); R[2] = R[2].map((v) => v / nz);
    const dx = R[0][0] * R[2][0] + R[0][1] * R[2][1] + R[0][2] * R[2][2];
    R[0] = R[0].map((v, i) => v - dx * R[2][i]); const nx = Math.hypot(...R[0]); R[0] = R[0].map((v) => v / nx);
    R[1] = [R[2][1] * R[0][2] - R[2][2] * R[0][1], R[2][2] * R[0][0] - R[2][0] * R[0][2], R[2][0] * R[0][1] - R[2][1] * R[0][0]];
    this.R = R;
    this.tilt = (Math.acos(Math.max(-1, Math.min(1, R[2][this.upIdx] * this.upSign))) * 180) / Math.PI;
  }

  // Height and vertical speed from the accelerometer, for the airbrakes. The
  // barometer's speed lags while the rocket slows (it would brake too hard), so
  // this integrates acceleration from liftoff, where the speed is known to be
  // zero, and leans on the barometer only a little.
  _inertial(t, dt) {
    if (!this.plan.brake) return;
    // on the pad: start integrating with the first push above 1 g, and forget
    // it again if it was only a knock
    if (this.phase === "PAD" && this.candT == null && this.accUp < 1.15 * 9.81) { this.vCtl = 0; this.hCtl = 0; return; }
    if (this.apT != null || this.vCtl == null) return;
    const c = Math.cos((this.tilt * Math.PI) / 180);
    this.vCtl += (this.accUp * c - 9.80665) * dt;
    this.hCtl += this.vCtl * dt;
    this.vCtl += 0.002 * (this.vel - this.vCtl);
    this.hCtl += 0.02 * (this.est - this.hCtl);
  }

  // Airbrakes: after the last burnout, pick how far to open them so the
  // predicted apogee (vertical coast with drag) lands on the target.
  _airbrake(t, dt) {
    const B = this.plan.brake;
    if (!B || this.stageIdx < this.plan.stages.length || t - this.burnT < 0.3) return;
    // tilted, the drag is bigger than the vertical speed suggests: v_air = v / cos(tilt)
    const g = 9.80665, c = Math.max(0.5, Math.cos((this.tilt * Math.PI) / 180));
    const v = this.vCtl;
    // nearly at apogee the brakes can't do much: hold them where they are
    if (v == null || v < 8) return;
    const apo = (e) => { const k = (this.rho * (B.cdA + e * B.cdAb)) / (2 * B.mass * c); return this.hCtl + Math.log(1 + (k * v * v) / g) / (2 * k); };
    let e;
    if (apo(0) <= B.target) e = 0;
    else if (apo(1) >= B.target) e = 1;
    else { let lo = 0, hi = 1; for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (apo(mid) > B.target) lo = mid; else hi = mid; } e = (lo + hi) / 2; }
    if (Math.abs(e - this.brake) > 0.02 || t - this.brakeSentT > 0.2) { this.brake = e; this.brakeSentT = t; this.send(`$MBA,${B.name},${e.toFixed(3)}`); }
  }

  // power comes back: RAM is gone, the saved flight state isn't
  _boot() {
    this.booting = null; this.map = []; this.active = false;
    this.reset();
    const s = this.nvm;
    if (s && s.phase !== "PAD" && s.phase !== "LANDED") {
      Object.assign(this, { phase: s.phase, p0: s.p0, tPad: s.tPad, launchT: s.launchT, burnT: s.burnT, apT: s.apT, stageIdx: s.stageIdx, maxAlt: s.maxAlt, fired: { ...s.fired }, seed: true });
    }
    this.send("$MBE,READY,Virtual flight computer");
    if (this.seed) { this.send(`$MBL,Restarted mid-flight: carrying on in ${this.phase} from the saved state`); this.send(`$MBE,STATE,${this.phase}`); }
  }
  _state(p) { if (p !== this.phase) { this.phase = p; this.send(`$MBE,STATE,${p}`); this._save(); } }
  _fire(ch, why) { if (ch == null || this.fired[ch]) return; this.fired[ch] = true; this._save(); this.send(`$MBE,PYRO,${ch},${Math.round((this.lastT ?? 0) * 1000)},0`); if (why) this.send(`$MBL,${why}`); }
  step(s) {
    const t = s.t_ms / 1000;
    const dt = this.lastT === null ? 0.02 : Math.max(1e-3, t - this.lastT);
    this.lastT = t;
    const a = "a" + this.upAxis; // ax / ay / az
    const accRaw = Number.isFinite(s[a + "_g"]) ? s[a + "_g"] * 9.80665 : s[a];
    if (Number.isFinite(accRaw)) this.accUp = accRaw * this.upSign;
    this._attitude(s, dt);
    this._inertial(t, dt);
    if (Number.isFinite(s.p_pa) && Number.isFinite(s.temp_c)) this.rho = s.p_pa / (287.05 * (s.temp_c + 273.15));
    const p = s.p_pa;
    if (Number.isFinite(p)) {
      if (this.phase === "PAD") {
        this.padN++; this.p0 = this.p0 === null ? p : this.p0 + (p - this.p0) / Math.min(this.padN, 100);
        if (Number.isFinite(s.temp_c)) this.tPad = this.tPad == null ? s.temp_c : this.tPad + (s.temp_c - this.tPad) / Math.min(this.padN, 100);
      }
      // the standard atmosphere assumes 15 °C at the ground; scale by the pad's
      // own temperature or a warm day reads low
      const alt = 44330.77 * ((273.15 + (this.tPad ?? 15)) / 288.15) * (1 - Math.pow(p / this.p0, 0.190263));
      // after a restart, start the filter where the rocket is, not at zero
      if (this.seed) { this.seed = false; this.est = alt; this.vel = 0; }
      // alpha-beta filter
      const pred = this.est + this.vel * dt;
      const r = alt - pred;
      this.est = pred + 0.2 * r;
      this.vel += (0.02 * r) / dt;
      this.alt = alt;
    }
    if (this.est > this.maxAlt) this.maxAlt = this.est;
    if (++this.n % 5 === 0) this.send(`$MBT,alt,${this.est.toFixed(2)},vel,${this.vel.toFixed(2)},tilt,${this.tilt.toFixed(1)}`);

    switch (this.phase) {
      case "PAD":
        // A spike only makes a launch candidate. It counts once the push lasts
        // and the altitude keeps climbing, so a knock on the pad is ignored.
        if (this.accUp > 2.5 * 9.81) this.boostN++; else this.boostN = 0;
        if (this.candT == null && (this.boostN >= 3 || (this.est > 10 && this.vel > 8))) { this.candT = t; this.candAlt = this.est; this.pushT = 0; this.pushLast = t; }
        if (this.candT != null) {
          const noAcc = !Number.isFinite(accRaw);
          if (noAcc || this.accUp > 1.2 * 9.81) this.pushT += t - this.pushLast;
          this.pushLast = t;
          if (this.pushT >= 0.15 && this.est - this.candAlt > 3 && this.vel > 5) {
            this.launchT = this.candT; this.send("$MBE,LAUNCH"); this._state("BOOST");
          } else if (t - this.candT > 1.5) this.candT = null;   // no climb followed: it was a bump
        }
        break;
      case "BOOST":
        if (this.accUp < 0.5 * 9.81 || (t - this.launchT > 1 && !Number.isFinite(accRaw) && this.vel > 0)) { this.burnT = t; this.send("$MBE,BURNOUT"); this._state("COAST"); }
        break;
      case "COAST": {
        const st = this.plan.stages[this.stageIdx];
        if (st && !this.fired[st.ch] && t - this.burnT >= st.delay) {
          if (this.tilt > st.maxTilt) { this.send(`$MBL,Holding the ${st.name}: ${this.tilt.toFixed(0)}° from vertical (limit ${st.maxTilt}°)`); this.stageIdx++; }
          else if (this.vel > 15) { this._fire(st.ch, "Lighting the next stage"); this.stageIdx++; this._state("BOOST"); this.boostN = 0; break; }
          else { this.send("$MBL,Staging inhibited: too slow"); this.stageIdx++; }
        }
        this._airbrake(t, dt);
        if (t - this.launchT > 2 && (this.vel < 0 ? ++this.below : (this.below = 0)) >= 3 || this.maxAlt - this.est > 3) {
          this.apT = t; this.send("$MBE,APOGEE"); this._state("DESCENT");
          if (this.plan.brake && this.brake > 0) { this.brake = 0; this.send(`$MBA,${this.plan.brake.name},0`); }
        }
        break;
      }
      case "DESCENT":
        if (this.plan.mainCh != null && this.est < this.plan.mainAlt && this.vel < 0) { this._fire(this.plan.mainCh, "Main"); this._state("MAIN"); }
        break;
      case "MAIN":
        if (this.est < 10 && Math.abs(this.vel) < 1.5) { this.landT ??= t; if (t - this.landT > 2) { this.send("$MBE,LANDED"); this._state("LANDED"); this.nvm = null; } } else this.landT = null;
        break;
    }
    const down = this.phase === "DESCENT" || this.phase === "MAIN";
    // The drogue fires after its delay even if a low apogee already brought the main out.
    if (down && this.plan.drogueCh != null && !this.fired[this.plan.drogueCh] && t - this.apT >= this.plan.drogueDelay) this._fire(this.plan.drogueCh, "Drogue");
    // backups: a second later for the drogue, 20% lower for the main
    if (down) for (const b of this.plan.drogueBackup) if (!this.fired[b] && t - this.apT >= this.plan.drogueDelay + 1) this._fire(b, "Drogue backup");
    if (this.phase === "MAIN" || (down && this.plan.mainCh == null)) for (const b of this.plan.mainBackup) if (!this.fired[b] && this.est < this.plan.mainAlt * 0.8 && this.vel < 0) this._fire(b, "Main backup");
  }
}

// ---------------------------------------------------------------- Monte Carlo
// Random variations of a flight: wind, motor thrust, mass, drag, sensor noise
// and how long it waits on the pad. mc holds the spreads (1 sigma as
// fractions, wind as a maximum in m/s).
export const MC_DEFAULTS = { runs: 200, windMax: 8, thrustSd: 0.05, massSd: 0.03, cdSd: 0.08, noiseMax: 2, padMin: 5, padMax: 20, keepFaults: true };

export function disperseRun(rocket, site, mc, seed) {
  const R = rng(seed);
  const g = () => R.gauss();
  const clampv = (x, a, b) => Math.max(a, Math.min(b, x));
  const mass = clampv(1 + g() * mc.massSd, 0.7, 1.3), cd = clampv(1 + g() * mc.cdSd, 0.6, 1.4), thrust = clampv(1 + g() * mc.thrustSd, 0.6, 1.4);
  const rk = structuredClone(rocket);
  for (const s of rk.stages) { s.dryMass *= mass; s.cd *= cd; }
  const wind = R() * mc.windMax, windDir = R() * 360;
  const padTime = mc.padMin + R() * Math.max(0, mc.padMax - mc.padMin);
  const noise = 1 + R() * Math.max(0, mc.noiseMax - 1);
  return { seed, rocket: rk, site: { ...site, windSpeed: wind, windDir }, padTime, noise, thrust, params: { wind, windDir, thrust, mass, cd, padTime, noise } };
}

// One run against the virtual flight computer, start to finish, no screen.
export function runVirtual({ rocket, site, cfg, faults = [], seed = 1 }) {
  let vfc = null;
  const run = new HILRun({ rocket, site, cfg, faults, seed, send: (l) => vfc && vfc.receive(l) });
  vfc = new VirtualFC({ rocket, pyro: cfg.pyro, upAxis: cfg.axis?.up, upSign: cfg.axis?.sign, send: (l) => run.handleLine(l) });
  run.start();
  let t = 0;
  const dt = 1 / (cfg.rate || 50);
  while (!run.done && t < (cfg.maxTime || 400) + 30) { t += dt * 5; run.advanceTo(t); }
  return run.report();
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))] : NaN);
// Pass rates and timing spreads over many runs: results = [{ rep, params }]
export function summarizeMC(results) {
  const by = new Map();
  for (const r of results) for (const c of r.rep.checks) {
    const k = c.label;
    if (!by.has(k)) by.set(k, { label: k, n: 0, ok: 0, err: [], errAlt: [], never: 0 });
    const b = by.get(k); b.n++; if (c.ok) b.ok++;
    if (Number.isFinite(c.err)) b.err.push(c.err);
    if (Number.isFinite(c.errAlt)) b.errAlt.push(c.errAlt);
    if (c.actual === "never fired") b.never++;
  }
  const stat = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? { n: s.length, p5: pct(s, 0.05), p50: pct(s, 0.5), p95: pct(s, 0.95), min: s[0], max: s[s.length - 1] } : null; };
  const checks = [...by.values()].map((b) => ({ label: b.label, n: b.n, passRate: b.ok / b.n, never: b.never, err: stat(b.err), errAlt: stat(b.errAlt) }));
  const ap = stat(results.map((r) => r.rep.outcome.apogee).filter(Number.isFinite));
  const land = stat(results.map((r) => r.rep.outcome.landingSpeed).filter(Number.isFinite));
  const passed = results.filter((r) => r.rep.verdict === "pass").length;
  return { runs: results.length, passed, passRate: passed / Math.max(1, results.length), checks, apogee: ap, landing: land };
}
