// Flight simulator used by Mockingbird (closed loop with a real flight
// computer), Heron (predictions) and Owl (demo telemetry).
//
// Model, up to apogee: a rigid body that can tilt (translation in 3D, pitch
// and yaw from aerodynamics), with multi-stage motors, clusters, drag from a
// stack Cd plus airbrakes and any deployed recovery devices, a normal force
// and a weathercocking moment set by the stability margin, pitch damping,
// a launch rail that can lean, wind, and the ISA atmosphere for the site.
// With no wind and a vertical rail it flies straight up, exactly as the old
// vertical model did. After apogee: vertical motion with drag, and the
// horizontal speed relaxing to the wind (drift).
//
// Frames: x east, y north, h up (metres from the pad). u is the unit vector
// the nose points along; om the body's angular velocity in the same frame.

import { siteAtmosphere, G } from "./atmosphere.js";
import { thrustAt, motorMass, motorFromJSON } from "./motors.js";

const area = (d) => Math.PI * (d / 2) ** 2;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const RAD = Math.PI / 180;

// Defaults for the parts of a profile older versions didn't have.
export const AERO_DEFAULTS = { stability: 1.5, cnAlpha: 10, dampingRatio: 0.08 };
export const stageLength = (s) => (s.length > 0 ? s.length : Math.max(0.25, 18 * (s.diameter || 0.05)));
export const AIRBRAKE_DEFAULTS = { enabled: false, name: "brake", area: 0.003, cd: 1.2, travel: 0.4 };

export function prepareRocket(r) {
  const stages = r.stages.map((s) => ({ ...s, motorObj: motorFromJSON(s.motor), motorCount: s.motorCount || 1, len: stageLength(s) }));
  return {
    ...r, stages, recovery: (r.recovery || []).map((d) => ({ ...d })), descentBodyCd: r.descentBodyCd ?? 0.8,
    stability: r.stability > 0 ? r.stability : AERO_DEFAULTS.stability, cnAlpha: r.cnAlpha > 0 ? r.cnAlpha : AERO_DEFAULTS.cnAlpha,
    dampingRatio: r.dampingRatio > 0 ? r.dampingRatio : AERO_DEFAULTS.dampingRatio,
    airbrakes: { ...AIRBRAKE_DEFAULTS, ...(r.airbrakes || {}) },
  };
}

// Which way the rail points: angle from vertical, leaning toward an azimuth
// (degrees, 0 = north, 90 = east).
export function railVector(site) {
  const a = (site.railAngle || 0) * RAD, d = (site.railDir || 0) * RAD;
  return [Math.sin(a) * Math.sin(d), Math.sin(a) * Math.cos(d), Math.cos(a)];
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
    this.site = { elevation: 0, tempC: 15, windSpeed: 0, windDir: 270, railLength: 1.5, railAngle: 0, railDir: 0, lat: 0, lon: 0, ...site };
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
      maxH: 0, maxV: 0, maxA: 0, maxMach: 0, maxTilt: 0, events: [], phase: "pad", _newEvents: [],
      s: 0, rail: railVector(this.site), om: [0, 0, 0], fv: [0, 0, G], tilt: 0, aoa: 0,
      brake: 0, brakeCmd: 0, brakeHeld: false, gust: [0, 0],
    });
    this.u = [...this.rail];
    // a body axis across the rocket, carried along as it turns (for the gyro and accelerometer axes)
    this.e1 = unit(cross(this.u, Math.abs(this.u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    this.tilt = Math.acos(Math.min(1, this.u[2]));
    this.fv = [0, 0, G];
    this.f = G * this.u[2];
    this.mass = this._mass(0);
  }

  // Wind the rocket feels (toward which it blows, m/s east and north), with any gust.
  windAt() { return [this.wind[0] + this.gust[0], this.wind[1] + this.gust[1], 0]; }

  // A control output from the flight computer. Returns true if it moved something.
  actuate(name, value) {
    const ab = this.r.airbrakes;
    if (ab.enabled && (name === ab.name || /^(brake|brakes|airbrake|airbrakes|ab)$/i.test(name))) {
      this.brakeCmd = Math.max(0, Math.min(1, Number(value) || 0));
      return true;
    }
    return false;
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

  // Thrust, mass, drag area, reference area and length of what's still attached.
  _loads(t, v) {
    let thrust = 0, maxD = 0, len = 0;
    for (let k = this.bottom; k < this.r.stages.length; k++) {
      const s = this.r.stages[k];
      maxD = Math.max(maxD, s.diameter);
      len += s.len;
      if (this.ign[k] !== null && s.motorObj && t - this.ign[k] < this._cutAt(k)) thrust += s.motorCount * thrustAt(s.motorObj, t - this.ign[k]) * (this.opts.thrustScale ?? 1);
    }
    const mass = this._mass(t);
    const stackCd = this.r.stages[this.bottom]?.cd ?? 0.5;
    const S = area(maxD);
    let cdA = (v >= 0 || !this.apogee ? stackCd : Math.max(stackCd, this.r.descentBodyCd)) * S;
    for (const d of this.r.recovery) {
      const td = this.deployed[d.id];
      if (td === undefined) continue;
      const fr = Math.min(1, Math.max(0, (t - td) / Math.max(0.05, d.inflation || 0.5)));
      cdA += d.cd * area(d.diameter) * fr * fr;
    }
    const ab = this.r.airbrakes;
    if (ab.enabled && this.brake > 0) cdA += ab.cd * ab.area * this.brake;
    return { thrust, mass, cdA, S, D: maxD, len };
  }

  // Vertical model (after apogee).
  _forces(t, h, v) {
    const L = this._loads(t, v);
    const rho = this.atm.density(Math.max(0, h));
    const drag = 0.5 * rho * v * Math.abs(v) * L.cdA;
    return { thrust: L.thrust, drag, mass: L.mass, a: (L.thrust - drag) / L.mass - G };
  }

  // Rigid-body model (up to apogee). Returns the acceleration, the angular
  // acceleration and the loads. On the rail, only motion along it counts.
  _forces3(t, pos, vel, u, om, onRail) {
    const L = this._loads(t, 1);
    const rho = this.atm.density(Math.max(0, pos[2]));
    const w = this.windAt();
    const va = [vel[0] - w[0], vel[1] - w[1], vel[2]];
    const V = Math.hypot(va[0], va[1], va[2]);
    const q = 0.5 * rho * V * V;
    let acc = add([0, 0, -G], u, L.thrust / L.mass);
    let dom = [0, 0, 0], drag = 0, aoa = 0;
    if (V > 1e-6) {
      const vh = scale(va, 1 / V);
      drag = q * L.cdA;
      acc = add(acc, vh, -drag / L.mass);
      if (!onRail) {
        // cross-flow: |cf| = sin(angle of attack). The normal force pushes
        // against it; acting behind the centre of gravity, it turns the nose
        // into the airflow.
        const cf = add(vh, u, -dot(u, vh));
        const sinA = Math.hypot(cf[0], cf[1], cf[2]);
        aoa = Math.asin(Math.min(1, sinA));
        const N = q * L.S * this.r.cnAlpha;
        acc = add(acc, cf, -N / L.mass);
        const sm = this.r.stability * L.D;
        const I = (L.mass * L.len * L.len) / 12;
        const K = N * sm;                          // restoring moment per radian
        const c = 2 * this.r.dampingRatio * Math.sqrt(Math.max(0, K * I));
        const tq = add(scale(cross(u, cf), K), om, -c);
        dom = scale(tq, 1 / I);
        dom = add(dom, u, -dot(dom, u));           // no roll from this
      }
    }
    if (onRail) {
      const along = dot(acc, this.rail);
      acc = scale(this.rail, along);
    }
    return { acc, dom, thrust: L.thrust, drag, mass: L.mass, aoa };
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
    // airbrake servo: moves toward the command at its own speed, unless jammed
    const ab = this.r.airbrakes;
    if (ab.enabled && !this.brakeHeld && this.brake !== this.brakeCmd) {
      const step = dt / Math.max(0.02, ab.travel);
      this.brake = this.brakeCmd > this.brake ? Math.min(this.brakeCmd, this.brake + step) : Math.max(this.brakeCmd, this.brake - step);
    }
    if (this.landed) { this.t += dt; this.v = 0; this.a = 0; this.f = G; this.fv = [0, 0, G]; this.om = [0, 0, 0]; return; }
    if (!this.apogee) { this._ascent(dt); return; }
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
      const tau = 1.5, w = this.windAt();
      this.vx += ((w[0] - this.vx) / tau) * dt;
      this.vy += ((w[1] - this.vy) / tau) * dt;
      this.x += this.vx * dt; this.y += this.vy * dt;
      // under a parachute it ends up hanging nose up; the gyros see it swing
      this.om = [0, 0, 0];
      if (Object.keys(this.deployed).length) {
        const u0 = this.u;
        this.u = unit(add(this.u, add([0, 0, 1], this.u, -1), dt / 1.0));
        this.om = scale(cross(u0, this.u), 1 / dt);
        this.e1 = unit(add(this.e1, cross(this.om, this.e1), dt));
        this.e1 = unit(add(this.e1, this.u, -dot(this.e1, this.u)));
      }
      this.tilt = Math.acos(Math.max(-1, Math.min(1, this.u[2])));
      this.fv = [0, 0, this.f];
      this.f = dot(this.fv, this.u);
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

  // Up to apogee: integrate position, velocity, nose direction and turn rate
  // (Heun's method), keeping the rocket on the rail until it's clear.
  _ascent(dt) {
    const t = this.t;
    const pos = [this.x, this.y, this.h], vel = [this.vx, this.vy, this.v];
    const onRail = this.railExit === null;
    const k1 = this._forces3(t, pos, vel, this.u, this.om, onRail);
    if (this.liftoff === null) {
      if (dot(k1.acc, this.rail) <= 0) {
        // on the pad: the rail holds it up
        this.t += dt; this.a = 0; this.thrust = k1.thrust; this.mass = k1.mass;
        this.fv = [0, 0, G]; this.f = G * this.u[2];
        this._auto();
        return;
      }
      this.liftoff = t; this._ev("liftoff", { label: "Liftoff" });
    }
    const vPrev = this.v;
    const p2 = add(pos, vel, dt), v2 = add(vel, k1.acc, dt);
    let u2 = this.u, om2 = this.om;
    if (!onRail) { u2 = unit(add(this.u, cross(this.om, this.u), dt)); om2 = add(this.om, k1.dom, dt); }
    const k2 = this._forces3(t + dt, p2, v2, u2, om2, onRail);
    const acc = scale(add(k1.acc, k2.acc), 0.5);
    const P = add(pos, scale(add(vel, v2), 0.5), dt);
    const Vn = add(vel, acc, dt);
    if (!onRail) {
      const omAvg = scale(add(this.om, om2), 0.5);
      this.u = unit(add(this.u, cross(omAvg, this.u), dt));
      this.om = add(this.om, scale(add(k1.dom, k2.dom), 0.5), dt);
      this.om = add(this.om, this.u, -dot(this.om, this.u));
      this.e1 = add(this.e1, cross(omAvg, this.e1), dt);
    }
    this.e1 = unit(add(this.e1, this.u, -dot(this.e1, this.u)));
    [this.x, this.y, this.h] = P;
    [this.vx, this.vy, this.v] = Vn;
    this.t += dt;
    this.a = acc[2];
    this.fv = add(acc, [0, 0, G]);
    this.f = dot(this.fv, this.u);
    this.aoa = k2.aoa;
    this.thrust = k2.thrust; this.drag = k2.drag; this.mass = k2.mass;
    if (onRail) this.s = Math.max(0, dot(P, this.rail));
    if (this.h < 0 && this.t - this.liftoff <= 0.5) { this.h = 0; this.v = Math.max(0, this.v); this.x = 0; this.y = 0; this.s = 0; this.vx = 0; this.vy = 0; }
    this.tilt = Math.acos(Math.max(-1, Math.min(1, this.u[2])));
    const w = this.windAt();
    const speed = Math.hypot(this.vx - w[0], this.vy - w[1], this.v);
    this.mach = speed / this.atm.soundSpeed(Math.max(0, this.h));
    if (this.h > this.maxH) this.maxH = this.h;
    if (this.v > this.maxV) this.maxV = this.v;
    if (this.f > this.maxA) this.maxA = this.f;
    if (this.mach > this.maxMach) this.maxMach = this.mach;
    if (this.tilt > this.maxTilt && this.thrust > 0.5) this.maxTilt = this.tilt;
    if (this.railExit === null && this.s >= this.site.railLength) { this.railExit = { t: this.t, v: Math.hypot(...Vn) }; this._ev("railExit", { label: "Off the rail" }); }
    if (this.apogee === null && vPrev > 0 && this.v <= 0 && this.t - this.liftoff > 0.2) {
      this.apogee = { t: this.t, h: this.h };
      this._ev("apogee", { label: "Apogee" });
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

  // Sensor readings with noise, in the board's own axes. cfg: noise levels,
  // ranges, which board axis points up the rocket (and its sign), and a
  // steady roll rate in °/s while it flies.
  measure(cfg = {}, R = Math.random) {
    const g = R.gauss || (() => 0);
    const c = { baroNoise: 2, accelNoise: 0.1, gyroNoise: 0.15, accelRange: 16 * G, upAxis: "z", upSign: 1, rollRate: 0, tempNoise: 0.05, gpsNoise: 2.0, ...cfg };
    const p = this.atm.pressure(Math.max(-50, this.h)) + g() * c.baroNoise;
    const clip = (v) => Math.max(-c.accelRange, Math.min(c.accelRange, v));
    // roll angle from the steady spin
    const spinning = this.liftoff !== null && !this.apogee;
    if (this._mt == null) this._mt = this.t;
    this._phi = (this._phi || 0) + (spinning ? c.rollRate * RAD : 0) * (this.t - this._mt);
    this._mt = this.t;
    // board axes in the world: up the rocket, and two across it turned by the roll
    const u = this.u, e1 = this.e1, e2 = cross(u, e1);
    const cp = Math.cos(this._phi), sp = Math.sin(this._phi);
    const b1 = add(scale(e1, cp), e2, sp), b2 = add(scale(e2, cp), e1, -sp);
    const s = c.upSign < 0 ? -1 : 1;
    const axes = { [c.upAxis]: scale(u, s) };
    const order = { z: ["x", "y"], x: ["y", "z"], y: ["z", "x"] }[c.upAxis] || ["x", "y"];
    axes[order[0]] = b1; axes[order[1]] = scale(b2, s);
    const omega = add(this.om, u, spinning ? c.rollRate * RAD : 0);
    const acc = {}, gyro = {};
    for (const k of ["x", "y", "z"]) {
      acc[k] = clip(dot(this.fv, axes[k]) + g() * c.accelNoise);
      gyro[k] = dot(omega, axes[k]) / RAD + g() * c.gyroNoise;
    }
    const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos(((this.site.lat || 0) * Math.PI) / 180);
    return {
      t: this.t, p_pa: p, temp_c: this.atm.temp(this.h) - 273.15 + g() * c.tempNoise, alt_m: this.h, vz: this.v,
      ax: acc.x, ay: acc.y, az: acc.z, gx: gyro.x, gy: gyro.y, gz: gyro.z,
      lat: (this.site.lat || 0) + (this.y + g() * c.gpsNoise) / mPerDegLat,
      lon: (this.site.lon || 0) + (this.x + g() * c.gpsNoise) / (mPerDegLon || 1),
      gps_alt: this.site.elevation + this.h + g() * c.gpsNoise * 2, sats: 9,
      tilt_deg: this.tilt / RAD, brake: this.brake,
    };
  }
}

// Run a complete flight in ideal mode and return sampled series + summary.
export function simulate(rocket, site = {}, opts = {}) {
  const o = { rate: 50, maxTime: 1500, padTime: 0, ...opts };
  const sim = new FlightSim(rocket, site, { mode: "ideal", dt: o.dt || 0.001 });
  const out = { t: [], h: [], v: [], a: [], f: [], mach: [], phase: [], x: [], y: [], p: [], tilt: [] };
  const dt = 1 / o.rate;
  const push = () => {
    out.t.push(+(sim.t - o.padTime).toFixed(4)); out.h.push(sim.h); out.v.push(sim.v); out.a.push(sim.a); out.f.push(sim.f);
    out.mach.push(sim.mach); out.phase.push(sim.phase); out.x.push(sim.x); out.y.push(sim.y); out.p.push(sim.atm.pressure(sim.h)); out.tilt.push(sim.tilt / RAD);
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
    maxTilt: sim.maxTilt / RAD,
    liftoffMass: st.reduce((m, s) => m + s.dryMass + s.motorCount * (s.motorObj?.totalMass || 0), 0),
    deployments: dep.map((e) => ({ id: e.id, t: e.t - (sim.liftoff ?? t0), h: e.h, v: e.v })),
  };
}
