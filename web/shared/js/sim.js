// Vertical flight simulator used by Mockingbird (closed loop with a real flight
// computer), Heron (predictions) and Owl (demo telemetry).
//
// Model: point mass on a vertical line (1-DOF) with multi-stage motors,
// clusters, drag from a stack Cd and deployed recovery devices, ISA
// atmosphere for the launch site, launch rail, and horizontal wind drift
// after apogee for synthetic GPS.

import { siteAtmosphere, G } from "./atmosphere.js";
import { thrustAt, motorMass, motorFromJSON } from "./motors.js";

const area = (d) => Math.PI * (d / 2) ** 2;

export function prepareRocket(r) {
  const stages = r.stages.map((s) => ({ ...s, motorObj: motorFromJSON(s.motor), motorCount: s.motorCount || 1 }));
  return { ...r, stages, recovery: (r.recovery || []).map((d) => ({ ...d })), descentBodyCd: r.descentBodyCd ?? 0.8 };
}

// Seeded random numbers so test runs are repeatable.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let spare = null;
  next.gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, q;
    do { u = next() * 2 - 1; v = next() * 2 - 1; q = u * u + v * v; } while (q === 0 || q >= 1);
    const m = Math.sqrt((-2 * Math.log(q)) / q);
    spare = v * m; return u * m;
  };
  return next;
}

export const PHASES = ["pad", "boost", "coast", "descent", "drogue", "main", "landed"];
export const PHASE_LABEL = { pad: "Pad", boost: "Boost", coast: "Coast", apogee: "Apogee", descent: "Free fall", drogue: "Drogue", main: "Main", landed: "Landed" };

export class FlightSim {
  constructor(rocket, site = {}, opts = {}) {
    this.r = prepareRocket(rocket);
    this.site = { elevation: 0, tempC: 15, windSpeed: 0, windDir: 270, railLength: 1.5, lat: 0, lon: 0, ...site };
    this.atm = siteAtmosphere(this.site);
    this.opts = { dt: 0.001, mode: "ideal", ...opts };
    const to = ((this.site.windDir + 180) * Math.PI) / 180; // wind blows toward
    this.wind = [this.site.windSpeed * Math.sin(to), this.site.windSpeed * Math.cos(to)];
    this.reset();
  }

  reset() {
    const S = this.r.stages.length;
    Object.assign(this, {
      t: 0, h: 0, v: 0, a: 0, f: G, x: 0, y: 0, vx: 0, vy: 0, thrust: 0, drag: 0, mass: 0, mach: 0,
      bottom: 0, ign: new Array(S).fill(null), burnout: new Array(S).fill(null), sepAt: new Array(S).fill(null),
      deployed: {}, launched: false, liftoff: null, railExit: null, apogee: null, landed: null,
      maxH: 0, maxV: 0, maxA: 0, maxMach: 0, events: [], phase: "pad", _newEvents: [],
    });
    this.mass = this._mass(0);
  }

  _ev(type, extra = {}) {
    const e = { type, t: this.t, h: this.h, v: this.v, ...extra };
    this.events.push(e); this._newEvents.push(e);
    return e;
  }

  launch() {
    if (this.launched) return;
    this.launched = true;
    this.ign[0] = this.t;
    this._ev("ignition", { stage: 0, label: `${this.r.stages[0].name} motor lit` });
  }

  // Commands from a flight computer (or the user).
  command(c) {
    if (this.landed) return false;
    if (c.type === "deploy") {
      const d = this.r.recovery.find((x) => x.id === c.id);
      if (!d || this.deployed[d.id] !== undefined) return false;
      this.deployed[d.id] = this.t;
      this._ev("deploy", { id: d.id, label: `${d.name} deployed`, source: c.source || "command" });
      return true;
    }
    if (c.type === "ignite") {
      const k = c.stage;
      if (k == null || k < this.bottom || k >= this.r.stages.length || this.ign[k] !== null) return false;
      if (this.opts.noLight && this.opts.noLight.includes(k)) {
        if (!this._dud) this._dud = new Set();
        if (!this._dud.has(k)) { this._dud.add(k); this._ev("dud", { stage: k, label: `${this.r.stages[k].name} igniter fired but the motor did not light`, source: c.source || "command" }); }
        return true;
      }
      for (let j = this.bottom; j < k; j++) this._separate(j, "ignition");
      this.ign[k] = this.t;
      if (!this.launched) this.launched = true;
      this._ev("ignition", { stage: k, label: `${this.r.stages[k].name} motor lit`, source: c.source || "command" });
      return true;
    }
    if (c.type === "separate") {
      const k = c.stage;
      if (k == null || k < this.bottom || k >= this.r.stages.length - 1) return false;
      for (let j = this.bottom; j <= k; j++) this._separate(j, c.source || "command");
      return true;
    }
    return false;
  }

  _separate(k, why) {
    if (this.sepAt[k] !== null || k < this.bottom) return;
    this.sepAt[k] = this.t;
    this.bottom = k + 1;
    this._ev("separation", { stage: k, label: `${this.r.stages[k].name} separated`, source: why });
  }

  // Seconds after ignition at which a stage's motor stops early (a CATO or a
  // failed burn). Infinity when it burns normally.
  _cutAt(k) { const c = this.opts.cut?.[k]; return c > 0 ? c : Infinity; }

  _mass(t) {
    let m = 0;
    for (let k = this.bottom; k < this.r.stages.length; k++) {
      const s = this.r.stages[k];
      m += s.dryMass + s.motorCount * (s.motorObj ? motorMass(s.motorObj, this.ign[k] === null ? -1 : Math.min(t - this.ign[k], this._cutAt(k))) : 0);
    }
    return m;
  }

  _forces(t, h, v) {
    let thrust = 0, maxD = 0;
    for (let k = this.bottom; k < this.r.stages.length; k++) {
      const s = this.r.stages[k];
      maxD = Math.max(maxD, s.diameter);
      if (this.ign[k] !== null && s.motorObj && t - this.ign[k] < this._cutAt(k)) thrust += s.motorCount * thrustAt(s.motorObj, t - this.ign[k]) * (this.opts.thrustScale ?? 1);
    }
    const mass = this._mass(t);
    const stackCd = this.r.stages[this.bottom]?.cd ?? 0.5;
    let cdA = (v >= 0 || !this.apogee ? stackCd : Math.max(stackCd, this.r.descentBodyCd)) * area(maxD);
    for (const d of this.r.recovery) {
      const td = this.deployed[d.id];
      if (td === undefined) continue;
      const fr = Math.min(1, Math.max(0, (t - td) / Math.max(0.05, d.inflation || 0.5)));
      cdA += d.cd * area(d.diameter) * fr * fr;
    }
    const rho = this.atm.density(Math.max(0, h));
    const drag = 0.5 * rho * v * Math.abs(v) * cdA;
    return { thrust, drag, mass, a: (thrust - drag) / mass - G };
  }

  // Advance by dt seconds; returns the events that happened during the step.
  step(dt) {
    this._newEvents = [];
    const n = Math.max(1, Math.round(dt / this.opts.dt));
    const h0 = dt / n;
    for (let i = 0; i < n; i++) this._substep(h0);
    return this._newEvents;
  }

  _substep(dt) {
    const t = this.t;
    if (this.landed) { this.t += dt; this.v = 0; this.a = 0; this.f = G; return; }
    const k1 = this._forces(t, this.h, this.v);
    let a1 = k1.a;
    const sitting = this.liftoff === null;
    if (sitting && a1 <= 0) {
      // on the pad: the rail holds it up
      this.t += dt; this.a = 0; this.f = G; this.thrust = k1.thrust; this.mass = k1.mass;
      this._auto();
      return;
    }
    if (sitting) { this.liftoff = t; this._ev("liftoff", { label: "Liftoff" }); }
    const hp = this.h + this.v * dt, vp = this.v + a1 * dt;
    const k2 = this._forces(t + dt, hp, vp);
    const vPrev = this.v;
    this.h += (dt * (this.v + vp)) / 2;
    this.v += (dt * (a1 + k2.a)) / 2;
    this.t += dt;
    this.a = (a1 + k2.a) / 2;
    this.f = this.a + G;
    this.thrust = k2.thrust; this.drag = k2.drag; this.mass = k2.mass;
    if (this.h < 0 && this.t - this.liftoff <= 0.5) { this.h = 0; this.v = Math.max(0, this.v); }

    // horizontal drift once the rocket stops climbing
    if (this.apogee) {
      const tau = 1.5;
      this.vx += ((this.wind[0] - this.vx) / tau) * dt;
      this.vy += ((this.wind[1] - this.vy) / tau) * dt;
      this.x += this.vx * dt; this.y += this.vy * dt;
    }

    this.mach = Math.abs(this.v) / this.atm.soundSpeed(Math.max(0, this.h));
    if (this.h > this.maxH) this.maxH = this.h;
    if (this.v > this.maxV) this.maxV = this.v;
    if (this.f > this.maxA) this.maxA = this.f;
    if (this.mach > this.maxMach) this.maxMach = this.mach;

    if (this.railExit === null && this.h >= this.site.railLength) { this.railExit = { t: this.t, v: this.v }; this._ev("railExit", { label: "Off the rail" }); }
    if (this.apogee === null && vPrev > 0 && this.v <= 0 && this.liftoff !== null && this.t - this.liftoff > 0.2) {
      this.apogee = { t: this.t, h: this.h };
      this._ev("apogee", { label: "Apogee" });
    }
    if (this.liftoff !== null && this.h <= 0 && this.v < 0 && this.t - this.liftoff > 0.5) {
      this.landed = { t: this.t, v: this.v };
      this.h = 0;
      this._ev("landing", { label: "Landed", impact: vPrev });
      this.v = 0;
    }
    this._auto();
    this._phase();
  }

  // Things that happen by themselves: burnouts, drag separation, direct
  // staging, motor ejection charges, and (in ideal mode) the flight computer's
  // own jobs.
  _auto() {
    const S = this.r.stages;
    const ideal = this.opts.mode === "ideal";
    for (let k = 0; k < S.length; k++) {
      if (this.ign[k] === null || this.burnout[k] !== null || !S[k].motorObj) continue;
      const end = Math.min(S[k].motorObj.endTime, this._cutAt(k));
      if (this.t - this.ign[k] >= end) {
        this.burnout[k] = this.ign[k] + end;
        this._ev("burnout", { stage: k, label: end < S[k].motorObj.endTime ? `${S[k].name} motor quit early` : `${S[k].name} burnout` });
        if (k === this.bottom && k < S.length - 1 && S[k].separation === "burnout") this._separate(k, "drag");
      }
    }
    for (let k = 1; k < S.length; k++) {
      if (this.ign[k] !== null || this.burnout[k - 1] === null) continue;
      const due = this.burnout[k - 1] + (S[k].ignition === "direct" ? 0 : S[k].ignitionDelay || 0);
      const auto = S[k].ignition === "direct" || (ideal && S[k].ignition !== "never");
      if (auto && this.t >= due && k >= this.bottom - 0) this.command({ type: "ignite", stage: k, source: S[k].ignition === "direct" ? "direct" : "plan" });
    }
    const top = S.length - 1;
    for (const d of this.r.recovery) {
      if (this.deployed[d.id] !== undefined) continue;
      let fire = false;
      if (d.deploy === "motor") {
        const b = this.burnout[top];
        fire = b !== null && this.t >= b + (d.delay || 0);
      } else if (ideal) {
        if (d.deploy === "apogee") fire = this.apogee && this.t >= this.apogee.t + (d.delay || 0);
        else if (d.deploy === "altitude") fire = this.apogee && this.v < 0 && this.h <= d.altitude;
        else if (d.deploy === "timer") fire = this.liftoff !== null && this.t >= this.liftoff + (d.time || 0);
      }
      if (fire) this.command({ type: "deploy", id: d.id, source: d.deploy === "motor" ? "motor" : "plan" });
    }
  }

  _phase() {
    let p;
    if (this.landed) p = "landed";
    else if (this.liftoff === null) p = "pad";
    else if (!this.apogee) p = this.thrust > 0.5 ? "boost" : "coast";
    else {
      const dep = this.r.recovery.filter((d) => this.deployed[d.id] !== undefined);
      p = dep.some((d) => d.kind === "main" || d.kind === "chute") ? "main" : dep.length ? "drogue" : "descent";
    }
    if (p !== this.phase) this.phase = p;
  }

  get done() { return !!this.landed; }

  // Sensor readings with noise. cfg: noise levels, ranges, axis mapping.
  measure(cfg = {}, R = Math.random) {
    const g = R.gauss || (() => 0);
    const c = { baroNoise: 2, accelNoise: 0.1, gyroNoise: 0.15, accelRange: 16 * G, upAxis: "z", upSign: 1, rollRate: 0, tempNoise: 0.05, gpsNoise: 2.0, ...cfg };
    const p = this.atm.pressure(Math.max(-50, this.h)) + g() * c.baroNoise;
    const clip = (v) => Math.max(-c.accelRange, Math.min(c.accelRange, v));
    const up = clip(this.f + g() * c.accelNoise) * c.upSign;
    const acc = { x: clip(g() * c.accelNoise), y: clip(g() * c.accelNoise), z: clip(g() * c.accelNoise) };
    acc[c.upAxis] = up;
    const spinning = this.liftoff !== null && !this.apogee;
    const gyro = { x: g() * c.gyroNoise, y: g() * c.gyroNoise, z: g() * c.gyroNoise };
    gyro[c.upAxis] += (spinning ? c.rollRate : 0) * c.upSign;
    const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(((this.site.lat || 0) * Math.PI) / 180);
    return {
      t: this.t, p_pa: p, temp_c: this.atm.temp(this.h) - 273.15 + g() * c.tempNoise, alt_m: this.h, vz: this.v,
      ax: acc.x, ay: acc.y, az: acc.z, gx: gyro.x, gy: gyro.y, gz: gyro.z,
      lat: (this.site.lat || 0) + (this.y + g() * c.gpsNoise) / mPerDegLat,
      lon: (this.site.lon || 0) + (this.x + g() * c.gpsNoise) / (mPerDegLon || 1),
      gps_alt: this.site.elevation + this.h + g() * c.gpsNoise * 2, sats: 9,
    };
  }
}

// Run a complete flight in ideal mode and return sampled series + summary.
export function simulate(rocket, site = {}, opts = {}) {
  const o = { rate: 50, maxTime: 1500, padTime: 0, ...opts };
  const sim = new FlightSim(rocket, site, { mode: "ideal", dt: o.dt || 0.001 });
  const out = { t: [], h: [], v: [], a: [], f: [], mach: [], phase: [], x: [], y: [], p: [] };
  const dt = 1 / o.rate;
  const push = () => {
    out.t.push(+(sim.t - o.padTime).toFixed(4)); out.h.push(sim.h); out.v.push(sim.v); out.a.push(sim.a); out.f.push(sim.f);
    out.mach.push(sim.mach); out.phase.push(sim.phase); out.x.push(sim.x); out.y.push(sim.y); out.p.push(sim.atm.pressure(sim.h));
  };
  if (o.padTime > 0) { while (sim.t < o.padTime - 1e-9) { push(); sim.step(dt); } }
  sim.launch();
  push();
  while (!sim.done && sim.t < o.maxTime) {
    sim.step(dt); push();
    if (sim.liftoff === null && sim.burnout[0] !== null) break; // too heavy to leave the pad
  }
  return { series: out, events: sim.events.map((e) => ({ ...e, t: e.t - o.padTime })), summary: summarize(sim, o.padTime), sim };
}

export function summarize(sim, t0 = 0) {
  const st = sim.r.stages;
  const bo = sim.burnout.filter((x) => x !== null);
  const dep = sim.events.filter((e) => e.type === "deploy");
  const descent = {};
  for (const e of dep) descent[e.id] = e;
  return {
    apogee: sim.maxH,
    apogeeTime: sim.apogee ? sim.apogee.t - (sim.liftoff ?? t0) : null,
    maxVelocity: sim.maxV,
    maxMach: sim.maxMach,
    maxAccel: sim.maxA,
    railExitVelocity: sim.railExit ? sim.railExit.v : null,
    burnoutTimes: bo.map((b) => b - (sim.liftoff ?? t0)),
    coastToApogee: sim.apogee && bo.length ? sim.apogee.t - bo[bo.length - 1] : null,
    landingVelocity: sim.landed ? Math.abs(sim.events.find((e) => e.type === "landing")?.impact ?? 0) : null,
    flightTime: sim.landed ? sim.landed.t - (sim.liftoff ?? t0) : null,
    drift: Math.hypot(sim.x, sim.y),
    liftoffMass: st.reduce((m, s) => m + s.dryMass + s.motorCount * (s.motorObj?.totalMass || 0), 0),
    deployments: dep.map((e) => ({ id: e.id, t: e.t - (sim.liftoff ?? t0), h: e.h, v: e.v })),
  };
}
