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
};
export const SENSORS = [["baro", "Barometer"], ["accel", "Accelerometer"], ["gyro", "Gyro"], ["gps", "GPS"]];
export const FAULT_REFS = [["liftoff", "liftoff"], ["burnout", "burnout"], ["apogee", "apogee"]];

export function newFault(type) {
  const T = FAULT_TYPES[type];
  return { type, ref: T.whole ? "whole" : "apogee", offset: T.whole ? 0 : -1, duration: T.whole ? 0 : 1, params: Object.fromEntries(T.params.map((p) => [p.key, p.value])) };
}

export function describeFault(fl, stageName = (k) => `stage ${k + 1}`) {
  const T = FAULT_TYPES[fl.type];
  if (!T) return fl.type;
  const P = fl.params || {};
  const vals = T.params.map((p) => p.kind === "sensor" ? (SENSORS.find((s) => s[0] === P[p.key])?.[1] || P[p.key]).toLowerCase() : p.kind === "stage" ? stageName(Number(P[p.key])) : `${P[p.key]}${p.unit === "×" ? "×" : " " + p.unit}`);
  let when = "";
  if (!(T.whole || fl.ref === "whole")) {
    const o = Number(fl.offset) || 0;
    when = `${o === 0 ? "at" : `${Math.abs(o)} s ${o < 0 ? "before" : "after"}`} ${fl.ref || "liftoff"}${T.holds ? "" : `, for ${Number(fl.duration) || 0} s`}`;
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
  ];
  return T;
}

// Tests that make sense for this rocket (staging tests need two stages).
export const testApplies = (t, rocket) => !t.needsStages || (rocket?.stages?.length || 1) >= t.needsStages;

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

export const DEFAULT_TOL = { apogeeEarly: 1.0, apogeeLate: 2.0, altitudeFrac: 0.1, altitudeMin: 15, timer: 0.5, igniteEarly: 0.3, igniteLate: 0.7, safeLanding: 7.6 };

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
    this.actions = [];      // {t, kind, label, applied, source, ch}
    this.fcEvents = [];     // detections the FC reported (APOGEE etc.)
    this.fcTlm = {};        // name -> {t:[], v:[]}
    this.truth = { t: [], h: [], v: [], phase: [], x: [], y: [] };   // x east, y north (metres from the pad)
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
      const evs = this.sim.step(dt);
      this.sampleIdx++;
      for (const e of evs) this.onEvent({ ...e, sim: true });
      this.truth.t.push(this.sim.t); this.truth.h.push(this.sim.h); this.truth.v.push(this.sim.v); this.truth.phase.push(this.sim.phase);
      this.truth.x.push(this.sim.x); this.truth.y.push(this.sim.y);
      this._sample();
      this._checkEnd();
    }
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
      if (this.sim.t - this.lastHeader >= 2) this._header();
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
    let m;
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
      if (name === "READY" || name === "PONG") return { kind: "hello", text: val };
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
    const applied = this.sim.command({ ...action, source: "flight computer" });
    const name = action.type === "deploy" ? (this.rocket.recovery.find((d) => d.id === action.id)?.name || action.id) + " deploy" : action.type === "ignite" ? `${this.rocket.stages[action.stage]?.name || "Stage " + action.stage} ignition` : `${this.rocket.stages[action.stage]?.name || "Stage"} separation`;
    const rec = { t, key, label: name, applied, ch, source: why, h: this.sim.h, v: this.sim.v, ...(timing || {}) };
    this.actions.push(rec);
    this.onEvent({ type: "action", t, label: `${name} (${why})`, applied, h: this.sim.h, v: this.sim.v });
    return { kind: "action", rec };
  }

  // ------------------------------------------------------------ grading
  report({ fmtAlt = (m) => `${m.toFixed(0)} m`, fmtVel = (v) => `${v.toFixed(0)} m/s` } = {}) {
    const s = this.sim, tol = this.cfg.tol;
    const L = s.liftoff ?? this.launchAt;
    const ap = s.apogee;
    const bo = s.burnout;
    const hAt = (tt) => { const i = this.truth.t.findIndex((x) => x >= tt); return i < 0 ? null : { h: this.truth.h[i], v: this.truth.v[i] }; };
    const checks = [];
    for (const e of this.expectations) {
      const acts = this.actions.filter((a) => a.key === e.key);
      const a = acts[0];
      const c = { label: e.label, ok: false, expected: "", actual: "", detail: "", ch: e.ch };
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
              c.ok = err >= -tol.apogeeEarly && err <= tol.apogeeLate && !(a.t < ap.t && a.v > 15);
              if (a.t < ap.t && a.v > 15) c.detail = `Fired while still climbing at ${fmtVel(a.v)}.`;
              else if (!c.ok) c.detail = err < 0 ? `Fired ${(-err).toFixed(2)} s early (allowed ${tol.apogeeEarly} s).` : `Fired ${err.toFixed(2)} s late (allowed ${tol.apogeeLate} s).`;
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
            c.actual = `at ${fmtAlt(a.h)}${a.v > 0 ? " going up" : ""}`;
            c.ok = !!ap && a.t > ap.t && Math.abs(a.h - e.altitude) <= allowed;
            if (!c.ok) c.detail = !ap || a.t <= ap.t ? "Fired before apogee." : `${fmtAlt(Math.abs(a.h - e.altitude))} off (allowed ${fmtAlt(allowed)}).`;
          }
        } else if (e.rule === "timer") {
          c.expected = `${e.time} s after liftoff`;
          c.target = L + e.time;
          if (!a) c.actual = "never fired";
          else { const err = a.t - (L + e.time); c.actual = `${err >= 0 ? "+" : "−"}${Math.abs(err).toFixed(2)} s`; c.ok = Math.abs(err) <= tol.timer; }
        }
      } else if (e.type === "ignite") {
        c.expected = `${e.delay} s after ${this.rocket.stages[e.stage - 1].name.toLowerCase()} burnout`;
        const prevBo = bo[e.stage - 1];
        if (prevBo !== null) c.target = prevBo + e.delay;
        if (!a) c.actual = "never fired";
        else if (prevBo === null) { c.actual = "fired"; c.detail = "The stage below never burned out in the test."; }
        else {
          const err = a.t - (prevBo + e.delay);
          c.actual = `${err >= 0 ? "+" : "−"}${Math.abs(err).toFixed(2)} s`;
          c.ok = err >= -tol.igniteEarly && err <= tol.igniteLate && a.t >= prevBo && (!ap || a.t < ap.t);
          if (a.t < prevBo) c.detail = "Fired while the stage below was still burning.";
          else if (ap && a.t >= ap.t) c.detail = "Fired after apogee: an upper stage must never light on the way down.";
          else if (!c.ok) c.detail = `Outside the window (−${tol.igniteEarly} s to +${tol.igniteLate} s).`;
          if (a.v < 15 && c.ok) c.detail = `Lit at only ${fmtVel(a.v)}; check the delay.`;
        }
      } else if (e.type === "separate") {
        c.expected = "after burnout, before apogee";
        if (!a) c.actual = "never fired";
        else { c.actual = `T+${(a.t - L).toFixed(2)} s`; c.ok = bo[e.stage] !== null && a.t >= bo[e.stage] && (!ap || a.t < ap.t); }
      }
      if (acts.length > 1) c.detail = (c.detail ? c.detail + " " : "") + `Fired ${acts.length} times.`;
      if (a) { c.firedAt = a.t; c.firedH = a.h; c.boardT = a.boardT; c.procUs = a.procUs; if (Number.isFinite(c.target)) c.err = a.t - c.target; }
      if (e.type === "deploy" && e.rule === "altitude" && a) c.errAlt = a.h - e.altitude;
      checks.push(c);
    }
    const unexpected = this.actions.filter((a) => !this.expectations.some((e) => e.key === a.key));
    for (const u of unexpected) checks.push({ label: u.label, ok: false, expected: "not expected", actual: `T+${(u.t - L).toFixed(2)} s`, detail: "The flight computer did something the plan doesn't include." });

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
    const outcome = { apogee: s.maxH, apogeeTime: ap ? ap.t - L : null, maxVelocity: s.maxV, landingSpeed: landing, landingProjected: projected, hardLanding: !this.replay && landing !== null && landing > tol.safeLanding, replay: this.replay ? this.replay.name || "log" : null };

    // pyro timing: when each output should have fired, which sample the board
    // acted on, how long it took to fire after reading it, and the link delay
    const scale = this.cfg.timeScale || 1;
    const pyroTiming = checks.filter((c) => Number.isFinite(c.target) && Number.isFinite(c.firedAt)).map((c) => ({
      label: c.label, ch: c.ch, target: c.target - L, fired: c.firedAt - L,
      decisionMs: ((Number.isFinite(c.boardT) ? c.boardT : c.firedAt) - c.target) * 1000,
      processingUs: Number.isFinite(c.procUs) ? c.procUs : null,
      linkMs: Number.isFinite(c.boardT) ? Math.max(0, ((c.firedAt - c.boardT) * 1000) / scale) : null,
      fromBoard: Number.isFinite(c.boardT),
    }));
    const pass = checks.length > 0 && checks.every((c) => c.ok) && !outcome.hardLanding;
    return {
      verdict: pass ? "pass" : "fail", checks, detections: det, outcome, endReason: this.endReason,
      actions: this.actions.map((a) => ({ ...a, t: a.t - L })), fcEvents: this.fcEvents.map((e) => ({ ...e, t: e.t - L })),
      samples: this.sent, faults: this.faults, liftoff: L, boardStats: this.fcStats || null, pyroTiming,
    };
  }

  // flight data for saving (Heron can open it)
  csv() {
    const L = this.sim.liftoff ?? this.launchAt;
    const names = Object.keys(this.fcTlm);
    const head = ["time_s", "alt_m", "vel_mps", "phase", "sensed_baro_alt_m", "sensed_accel_g", "east_m", "north_m", ...names.map((n) => `fc_${n}`)];
    const rows = [head.join(",")];
    const idx = Object.fromEntries(names.map((n) => [n, 0]));
    const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : "");
    for (let i = 0; i < this.truth.t.length; i++) {
      const t = this.truth.t[i];
      const fc = names.map((n) => { const s = this.fcTlm[n]; while (idx[n] + 1 < s.t.length && s.t[idx[n] + 1] <= t) idx[n]++; return s.t[idx[n]] <= t ? s.v[idx[n]] : ""; });
      rows.push([(t - L).toFixed(3), this.truth.h[i].toFixed(2), this.truth.v[i].toFixed(2), this.truth.phase[i], fx(this.sensed.baro[i], 2), fx(this.sensed.acc[i], 3), fx(this.truth.x[i], 2), fx(this.truth.y[i], 2), ...fc].join(","));
    }
    return rows.join("\n") + "\n";
  }
}

// ---------------------------------------------------------------- virtual FC
// A reference dual-deploy / staging flight computer that speaks the protocol,
// built from the rocket profile. It mirrors the example Arduino sketch.
export class VirtualFC {
  constructor({ rocket, pyro, upAxis = "z", upSign = 1, send }) {
    this.send = send;
    this.upAxis = upAxis; this.upSign = upSign;
    const ch = (pred) => pyro.find((p) => p.action && pred(p.action))?.ch;
    const devs = rocket.recovery || [];
    const drogue = devs.find((d) => d.deploy === "apogee");
    const main = devs.find((d) => d.deploy === "altitude");
    this.plan = {
      drogueCh: drogue ? ch((a) => a.type === "deploy" && a.id === drogue.id) : null, drogueDelay: drogue?.delay || 0,
      mainCh: main ? ch((a) => a.type === "deploy" && a.id === main.id) : null, mainAlt: main?.altitude ?? 150,
      stages: rocket.stages.map((s, k) => (k > 0 && s.ignition !== "direct" ? { ch: ch((a) => a.type === "ignite" && a.stage === k), delay: s.ignitionDelay || 0 } : null)).filter(Boolean),
    };
    this.map = []; this.active = false;
    this.reset();
    setTimeout(() => this.send("$MBE,READY,Virtual flight computer"), 0);
  }
  reset() {
    Object.assign(this, { phase: "PAD", candT: null, candAlt: 0, pushT: 0, pushLast: 0, p0: null, padN: 0, alt: 0, vel: 0, est: 0, maxAlt: 0, lastT: null, launchT: null, burnT: null, apT: null,
      fired: {}, below: 0, stageIdx: 0, landT: null, n: 0, accUp: 9.81, boostN: 0 });
  }
  receive(line) {
    const m = line.match(/^\$(MB[CHD]),(.*?)(?:\*([0-9A-F]{2}))?$/i);
    if (!m) return;
    if (m[3] && checksum(`${m[1]},${m[2]}`) !== m[3].toUpperCase()) return;
    const parts = m[2].split(",");
    if (m[1] === "MBC") {
      if (parts[0] === "START") { this.active = true; this.reset(); }
      else if (parts[0] === "STOP") this.active = false;
      else if (parts[0] === "PING") this.send("$MBE,PONG,Virtual flight computer");
    } else if (m[1] === "MBH") this.map = parts;
    else if (m[1] === "MBD" && this.active) {
      const s = {};
      this.map.forEach((k, i) => { s[k] = parts[i] === "" ? NaN : Number(parts[i]); });
      this.step(s);
    }
  }
  _state(p) { if (p !== this.phase) { this.phase = p; this.send(`$MBE,STATE,${p}`); } }
  _fire(ch, why) { if (ch == null || this.fired[ch]) return; this.fired[ch] = true; this.send(`$MBE,PYRO,${ch},${Math.round((this.lastT ?? 0) * 1000)},0`); if (why) this.send(`$MBL,${why}`); }
  step(s) {
    const t = s.t_ms / 1000;
    const dt = this.lastT === null ? 0.02 : Math.max(1e-3, t - this.lastT);
    this.lastT = t;
    const a = "a" + this.upAxis; // ax / ay / az
    const accRaw = Number.isFinite(s[a + "_g"]) ? s[a + "_g"] * 9.80665 : s[a];
    if (Number.isFinite(accRaw)) this.accUp = accRaw * this.upSign;
    const p = s.p_pa;
    if (Number.isFinite(p)) {
      if (this.phase === "PAD") { this.padN++; this.p0 = this.p0 === null ? p : this.p0 + (p - this.p0) / Math.min(this.padN, 100); }
      const alt = 44330.77 * (1 - Math.pow(p / this.p0, 0.190263));
      // alpha-beta filter
      const pred = this.est + this.vel * dt;
      const r = alt - pred;
      this.est = pred + 0.2 * r;
      this.vel += (0.02 * r) / dt;
      this.alt = alt;
    }
    if (this.est > this.maxAlt) this.maxAlt = this.est;
    if (++this.n % 5 === 0) this.send(`$MBT,alt,${this.est.toFixed(2)},vel,${this.vel.toFixed(2)}`);

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
          if (this.vel > 15) { this._fire(st.ch, "Lighting the next stage"); this.stageIdx++; this._state("BOOST"); this.boostN = 0; break; }
          this.send("$MBL,Staging inhibited: too slow"); this.stageIdx++;
        }
        if (t - this.launchT > 2 && (this.vel < 0 ? ++this.below : (this.below = 0)) >= 3 || this.maxAlt - this.est > 3) {
          this.apT = t; this.send("$MBE,APOGEE"); this._state("DESCENT");
        }
        break;
      }
      case "DESCENT":
        if (this.plan.mainCh != null && this.est < this.plan.mainAlt && this.vel < 0) { this._fire(this.plan.mainCh, "Main"); this._state("MAIN"); }
        break;
      case "MAIN":
        if (this.est < 10 && Math.abs(this.vel) < 1.5) { this.landT ??= t; if (t - this.landT > 2) { this.send("$MBE,LANDED"); this._state("LANDED"); } } else this.landT = null;
        break;
    }
    // The drogue fires after its delay even if a low apogee already brought the main out.
    if ((this.phase === "DESCENT" || this.phase === "MAIN") && this.plan.drogueCh != null && !this.fired[this.plan.drogueCh] && t - this.apT >= this.plan.drogueDelay) this._fire(this.plan.drogueCh, "Drogue");
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
