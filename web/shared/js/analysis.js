// Flight analysis for Heron: liftoff/landing detection, ground level, a
// Kalman filter + RTS smoother fusing barometer and accelerometer, burns,
// deployments, descent rates, key numbers, drag coefficient back-calculation
// and comparison with a prediction.

import { G0 } from "./units.js";
import { altitudeFromPressure, siteAtmosphere } from "./atmosphere.js";

// ---------- small numeric helpers ----------
export function median(a) {
  const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (a) => { let s = 0, n = 0; for (const v of a) if (Number.isFinite(v)) { s += v; n++; } return n ? s / n : NaN; };
const std = (a) => { const m = mean(a); let s = 0, n = 0; for (const v of a) if (Number.isFinite(v)) { s += (v - m) ** 2; n++; } return n > 1 ? Math.sqrt(s / (n - 1)) : NaN; };
const lb = (t, x) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };

export function interp(tx, ty, x) {
  const n = tx.length;
  if (!n) return NaN;
  if (x <= tx[0]) return ty[0];
  if (x >= tx[n - 1]) return ty[n - 1];
  const i = lb(tx, x);
  const a = tx[i - 1], b = tx[i];
  return ty[i - 1] + ((ty[i] - ty[i - 1]) * (x - a)) / (b - a || 1);
}

export function medianFilter(y, w = 5) {
  const n = y.length, h = w >> 1, out = new Float64Array(n), buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) if (Number.isFinite(y[j])) buf.push(y[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf.length ? buf[buf.length >> 1] : NaN;
  }
  return out;
}

export function movingMean(t, y, halfWin) {
  const n = t.length, out = new Float64Array(n);
  let j0 = 0, j1 = 0, s = 0, c = 0;
  for (let i = 0; i < n; i++) {
    while (j1 < n && t[j1] <= t[i] + halfWin) { if (Number.isFinite(y[j1])) { s += y[j1]; c++; } j1++; }
    while (t[j0] < t[i] - halfWin) { if (Number.isFinite(y[j0])) { s -= y[j0]; c--; } j0++; }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

// derivative by local linear regression over ±halfWin seconds
export function localSlope(t, y, halfWin) {
  const n = t.length, out = new Float64Array(n);
  let j0 = 0, j1 = 0, S = 0, St = 0, Sy = 0, Stt = 0, Sty = 0;
  const T0 = t[0] || 0;
  const add = (j, sgn) => { const v = y[j]; if (!Number.isFinite(v)) return; const x = t[j] - T0; S += sgn; St += sgn * x; Sy += sgn * v; Stt += sgn * x * x; Sty += sgn * x * v; };
  for (let i = 0; i < n; i++) {
    while (j1 < n && t[j1] <= t[i] + halfWin) add(j1++, 1);
    while (t[j0] < t[i] - halfWin) add(j0++, -1);
    const d = S * Stt - St * St;
    out[i] = S >= 3 && Math.abs(d) > 1e-12 ? (S * Sty - St * Sy) / d : NaN;
  }
  return out;
}

// ---------- Kalman filter + RTS smoother, state [h, v, a] ----------
export function kalmanSmooth(t, hMeas, aMeas, { rH = 0.25, rA = 1, q = () => 100, rHscale = null } = {}) {
  const n = t.length;
  const xf = new Float64Array(n * 3), xp = new Float64Array(n * 3);
  const Pf = new Float64Array(n * 9), Pp = new Float64Array(n * 9);
  let k0 = 0; while (k0 < n && !Number.isFinite(hMeas[k0])) k0++;
  let x = [Number.isFinite(hMeas[k0]) ? hMeas[k0] : 0, 0, 0];
  let P = [rH * 10 + 1, 0, 0, 0, 100, 0, 0, 0, 400];
  const mul = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
  const tr = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      const dt = Math.max(1e-6, t[k] - t[k - 1]);
      const F = [1, dt, dt * dt / 2, 0, 1, dt, 0, 0, 1];
      x = [x[0] + dt * x[1] + (dt * dt / 2) * x[2], x[1] + dt * x[2], x[2]];
      const qq = q(t[k]);
      const d2 = dt * dt, d3 = d2 * dt, d4 = d3 * dt, d5 = d4 * dt;
      const Q = [d5 / 20, d4 / 8, d3 / 6, d4 / 8, d3 / 3, d2 / 2, d3 / 6, d2 / 2, dt].map((v) => v * qq);
      P = mul(mul(F, P), tr(F)).map((v, i) => v + Q[i]);
    }
    xp.set(x, k * 3); Pp.set(P, k * 9);
    const upd = (idx, z, R) => {
      const y = z - x[idx];
      let S = P[idx * 4] + R;
      if (y * y > 36 * S) S = y * y / 36 + R; // de-weight outliers (ejection spikes, Mach dips)
      const K = [P[idx] / S, P[3 + idx] / S, P[6 + idx] / S];
      x = [x[0] + K[0] * y, x[1] + K[1] * y, x[2] + K[2] * y];
      const row = [P[idx * 3], P[idx * 3 + 1], P[idx * 3 + 2]];
      P = P.map((v, i) => v - K[Math.floor(i / 3)] * row[i % 3]);
    };
    if (Number.isFinite(hMeas[k])) upd(0, hMeas[k], rH * (rHscale ? rHscale(t[k]) : 1));
    if (aMeas && Number.isFinite(aMeas[k])) upd(2, aMeas[k], rA);
    xf.set(x, k * 3); Pf.set(P, k * 9);
  }
  // RTS backward pass
  const xs = new Float64Array(n * 3);
  xs.set(xf.subarray((n - 1) * 3, n * 3), (n - 1) * 3);
  const inv3 = (m) => {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-30) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  };
  for (let k = n - 2; k >= 0; k--) {
    const dt = Math.max(1e-6, t[k + 1] - t[k]);
    const F = [1, dt, dt * dt / 2, 0, 1, dt, 0, 0, 1];
    const Pfk = Array.from(Pf.subarray(k * 9, k * 9 + 9));
    const inv = inv3(Array.from(Pp.subarray((k + 1) * 9, (k + 1) * 9 + 9)));
    if (!inv) { xs.set(xf.subarray(k * 3, k * 3 + 3), k * 3); continue; }
    const C = mul(mul(Pfk, tr(F)), inv);
    const d = [0, 1, 2].map((i) => xs[(k + 1) * 3 + i] - xp[(k + 1) * 3 + i]);
    for (let i = 0; i < 3; i++) xs[k * 3 + i] = xf[k * 3 + i] + C[i * 3] * d[0] + C[i * 3 + 1] * d[1] + C[i * 3 + 2] * d[2];
  }
  const h = new Float64Array(n), v = new Float64Array(n), a = new Float64Array(n);
  for (let k = 0; k < n; k++) { h[k] = xs[k * 3]; v[k] = xs[k * 3 + 1]; a[k] = xs[k * 3 + 2]; }
  return { h, v, a };
}

// ---------- descent segmentation (piecewise constant descent rate) ----------
export function segmentConstant(t, y, maxSeg = 3) {
  // downsample to <= 300 points
  const n0 = t.length;
  const step = Math.max(1, Math.floor(n0 / 300));
  const T = [], Y = [];
  for (let i = 0; i < n0; i += step) if (Number.isFinite(y[i])) { T.push(t[i]); Y.push(y[i]); }
  const n = Y.length;
  if (n < 6) return [{ t0: t[0], t1: t[n0 - 1], mean: mean(y) }];
  const cs = [0], cs2 = [0];
  for (let i = 0; i < n; i++) { cs.push(cs[i] + Y[i]); cs2.push(cs2[i] + Y[i] * Y[i]); }
  const sse = (i, j) => { const m = j - i; const s = cs[j] - cs[i]; return cs2[j] - cs2[i] - (s * s) / m; };
  const minLen = 3;
  let best = null;
  const results = [];
  for (let k = 1; k <= maxSeg; k++) {
    // DP over segment ends
    const D = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
    const Bk = Array.from({ length: k + 1 }, () => new Int32Array(n + 1));
    D[0][0] = 0;
    for (let s = 1; s <= k; s++) for (let j = s * minLen; j <= n; j++) for (let i = (s - 1) * minLen; i <= j - minLen; i++) {
      const c = D[s - 1][i] + sse(i, j);
      if (c < D[s][j]) { D[s][j] = c; Bk[s][j] = i; }
    }
    if (!Number.isFinite(D[k][n])) break;
    const bounds = [n];
    for (let s = k, j = n; s > 0; s--) { j = Bk[s][j]; bounds.unshift(j); }
    const segs = [];
    for (let s = 0; s < k; s++) { const i = bounds[s], j = bounds[s + 1]; segs.push({ t0: T[i], t1: T[j - 1], mean: (cs[j] - cs[i]) / (j - i), n: j - i }); }
    const cost = n * Math.log(Math.max(1e-9, D[k][n] / n)) + 3 * k * Math.log(n);
    results.push({ k, cost, segs });
  }
  for (const r of results) if (!best || r.cost < best.cost) best = r;
  // merge segments whose rates are within 20%, and short transitions (< 2 s)
  const segs = [];
  for (const s of best.segs) {
    const p = segs[segs.length - 1];
    const similar = p && Math.abs(p.mean - s.mean) < 0.2 * Math.max(Math.abs(p.mean), Math.abs(s.mean), 1);
    if (p && (similar || p.t1 - p.t0 < 2)) {
      const keepNew = !similar; // a short transition takes the following segment's rate
      p.mean = keepNew ? s.mean : (p.mean * p.n + s.mean * s.n) / (p.n + s.n);
      p.n += s.n; p.t1 = s.t1;
    } else segs.push({ ...s });
  }
  // drop a final piece that is really standing on the ground
  if (segs.length > 1 && Math.abs(segs[segs.length - 1].mean) < 1) { const last = segs.pop(); segs[segs.length - 1].t1 = last.t1; }
  // a short final piece is the touchdown transition, not a descent phase
  if (segs.length > 1 && segs[segs.length - 1].t1 - segs[segs.length - 1].t0 < 2) { const last = segs.pop(); segs[segs.length - 1].t1 = last.t1; }
  return segs;
}

// ---------- main analysis ----------
// Some flight computers log 0 for altitude or pressure until their filter
// starts. Drop that stretch so it isn't taken for the ground.
function trimStartupZeros(flight) {
  const S = flight.series;
  const key = S.alt ? "alt" : S.pressure ? "pressure" : null;
  if (!key) return { flight, note: null };
  const v = S[key];
  let k = 0;
  while (k < v.length && (!Number.isFinite(v[k]) || Math.abs(v[k]) < 1e-9)) k++;
  if (k < 10 || k > v.length - 50) return { flight, note: null };
  const after = median(Array.from(v.slice(k, k + 50)));
  if (!(Math.abs(after) > 20)) return { flight, note: null };
  const cut = (a) => a.slice(k);
  const series = Object.fromEntries(Object.entries(S).map(([n, a]) => [n, cut(a)]));
  const text = Object.fromEntries(Object.entries(flight.text || {}).map(([n, a]) => [n, a.slice(k)]));
  const t0 = flight.t[k];
  const t = Float64Array.from(cut(flight.t), (x) => x - t0);
  const events = (flight.events || []).map((e) => ({ ...e, t: e.t - t0 }));
  return { flight: { ...flight, t, series, text, events, rows: t.length, timeOffset: (flight.timeOffset || 0) + t0 }, note: `The first ${(t0).toFixed(0)} s read exactly 0 (sensor not started yet) and were skipped.` };
}

export function analyzeFlight(flight, opts = {}) {
  const trimmed = trimStartupZeros(flight);
  flight = trimmed.flight;
  const o = { tempC: null, ...opts };
  const t = flight.t, n = t.length;
  const S = { ...flight.series }; // a copy: cleaning below must not change the measured data
  const warnings = trimmed.note ? [trimmed.note] : [];
  const dts = [];
  for (let i = 1; i < Math.min(n, 5000); i++) dts.push(t[i] - t[i - 1]);
  const dtMed = median(dts) || 0.01;
  const rate = 1 / dtMed;

  // ----- pick the altitude source -----
  let alt = null, altSource = "";
  let padTemp = o.tempC;
  if (padTemp == null && S.temp) { const m = median(S.temp.slice(0, Math.min(n, 200))); if (m > -40 && m < 60) padTemp = m; }
  if (padTemp == null) padTemp = 15;
  // Single wild readings (a corrupt row, a sensor glitch) would wreck the
  // ground level and apogee: replace each with the median of its neighbours.
  const despike = (arr, floor) => {
    const k = Math.min(25, Math.max(3, Math.round(rate * 0.15)));
    const out = Float64Array.from(arr);
    let fixed = 0;
    for (let i = 0; i < n; i++) {
      const w = [];
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) if (j !== i && Number.isFinite(arr[j])) w.push(arr[j]);
      if (w.length < 3) continue;
      const m = median(w);
      const mad = median(w.map((x) => Math.abs(x - m))) * 1.4826;
      if (!Number.isFinite(arr[i]) || Math.abs(arr[i] - m) > Math.max(floor, 8 * mad)) { out[i] = m; fixed++; }
    }
    return { out, fixed };
  };
  let spikes = 0;
  if (S.alt) { const d = despike(S.alt, 60); S.alt = d.out; spikes += d.fixed; }
  if (S.pressure) { const d = despike(S.pressure, 700); S.pressure = d.out; spikes += d.fixed; }
  if (spikes > 0) warnings.push(`${spikes} wild reading${spikes > 1 ? "s" : ""} (far from their neighbours) were replaced by nearby values.`);
  if (S.alt) { alt = Float64Array.from(S.alt); altSource = "altitude column"; }
  else if (S.pressure) {
    const pPad = median(S.pressure.slice(0, Math.min(n, Math.max(20, Math.round(rate * 2)))));
    alt = Float64Array.from(S.pressure, (p) => altitudeFromPressure(p, pPad, padTemp + 273.15));
    altSource = "pressure";
  } else if (S.gps_alt) { alt = Float64Array.from(S.gps_alt); altSource = "GPS altitude"; warnings.push("Using GPS altitude; GPS is slower and noisier than a barometer."); }
  else if (S.vel) {
    alt = new Float64Array(n);
    for (let i = 1; i < n; i++) alt[i] = alt[i - 1] + 0.5 * (S.vel[i] + S.vel[i - 1]) * (t[i] - t[i - 1]);
    altSource = "integrated velocity";
  }

  // ----- accelerometer: choose axial axis, orientation, bias -----
  let f = null, accAxis = null;
  if (S.acc_kin) { f = Float64Array.from(S.acc_kin, (a) => a + G0); accAxis = "acc_kin"; }
  else {
    const cands = ["acc", "acc_x", "acc_y"].filter((k) => S[k]);
    if (cands.length) {
      const N0 = Math.min(n, Math.max(10, Math.round(rate * 1.5)));
      let best = null;
      for (const k of cands) {
        const m = median(S[k].slice(0, N0));
        const score = Math.abs(Math.abs(m) - G0);
        if (!best || score < best.score) best = { k, m, score };
      }
      // If nothing reads ~1 g at rest (log starts in flight), take the axis with the biggest positive peak
      if (best.score > 0.35 * G0) {
        let bk = null, bp = -Infinity;
        for (const k of cands) { const mx = Math.max(...Array.from(S[k]).filter(Number.isFinite).map(Math.abs)); if (mx > bp) { bp = mx; bk = k; } }
        best = { k: bk, m: G0, score: 0 };
      }
      accAxis = best.k;
      const sign = best.m < 0 ? -1 : 1;
      f = Float64Array.from(S[accAxis], (v) => v * sign);
    }
  }
  if (!alt && !f) throw new Error("This log has no altitude, pressure, GPS, velocity or acceleration column to analyse. Set the columns under Columns.");
  // Loggers that write each sensor on its own row leave blanks in the others,
  // and some drop seconds of data. Bridge blanks with a straight line between
  // the real readings on either side (holding a value flat would look like
  // the rocket stopped).
  const fill = (arr) => {
    if (!arr) return arr;
    const first = arr.findIndex(Number.isFinite);
    if (first < 0) return arr;
    for (let i = 0; i < first; i++) arr[i] = arr[first];
    let prev = first;
    for (let i = first + 1; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) continue;
      if (i - prev > 1) for (let j = prev + 1; j < i; j++) arr[j] = arr[prev] + ((arr[i] - arr[prev]) * (t[j] - t[prev])) / (t[i] - t[prev] || 1);
      prev = i;
    }
    for (let j = prev + 1; j < arr.length; j++) arr[j] = arr[prev];
    return arr;
  };
  fill(alt); fill(f);
  if (!alt && f) {
    warnings.push("No altitude or pressure data: altitude comes from integrating the accelerometer, which drifts.");
    alt = new Float64Array(n); const v = new Float64Array(n);
    for (let i = 1; i < n; i++) { const dt = t[i] - t[i - 1]; v[i] = v[i - 1] + 0.5 * ((f[i] - G0) + (f[i - 1] - G0)) * dt; alt[i] = alt[i - 1] + 0.5 * (v[i] + v[i - 1]) * dt; }
    altSource = "accelerometer";
  }

  // ----- rough pass: liftoff, apogee, landing -----
  const win = Math.max(3, Math.min(31, Math.round(rate * 0.1) | 1));
  const hm = medianFilter(alt, win % 2 ? win : win + 1);
  let ia = 0;
  for (let i = 1; i < n; i++) if (hm[i] > hm[ia]) ia = i;
  const firstN = Math.max(5, Math.min(Math.round(ia * 0.15), Math.round(rate * 3)));
  const startMed = median(hm.slice(0, firstN));
  let preMin = Infinity; for (let i = 0; i <= ia; i++) if (hm[i] < preMin) preMin = hm[i];
  const padNoise = std(Array.from(alt.slice(0, firstN)).map((v, i) => v - hm[i])) || 0.3;
  // If the first readings sit near the lowest point, the log starts on the pad.
  const ground0 = startMed - preMin < Math.max(2, 6 * padNoise, 0.01 * (hm[ia] - preMin)) ? startMed : preMin;
  // Is the biggest rise physically a flight? Anything that really goes up H
  // metres spends at least about sqrt(H/g) seconds above half that height. A
  // pressure blast (a CATO or ejection charge near the barometer, a gust on the
  // vent holes) comes and goes far faster.
  let notFlight = null;
  {
    const H = hm[ia] - ground0;
    let a0 = ia, a1 = ia;
    while (a0 > 0 && hm[a0] > ground0 + H / 2) a0--;
    while (a1 < n - 1 && hm[a1] > ground0 + H / 2) a1++;
    const dur = t[a1] - t[a0];
    // report it against the usual pad level, in the log's own clock
    const Hp = Math.max(0, hm[ia] - startMed) || H;
    if (H > 3 && dur < 0.5 * Math.sqrt(H / G0)) notFlight = { t: t[ia] + (flight.timeOffset || 0), h: Hp, dur, ballistic: 2 * Math.sqrt((2 * Hp) / G0) };
  }
  const thr = Math.max(1.5, 4 * padNoise, 0.01 * (hm[ia] - ground0));
  let il = ia;
  while (il > 0 && hm[il] > ground0 + thr) il--;
  // walk back to where it really started rising
  const slope0 = localSlope(t, hm, 0.15);
  while (il > 0 && slope0[il] > 1) il--;
  let tLift = t[il];
  let liftSource = "barometer";
  if (f) {
    const fs = movingMean(t, f, 0.025);
    const lo = lb(t, tLift - 5), hi = lb(t, tLift + 3);
    // A bump on the pad (loading the rail, a knock, the igniter popping) also
    // spikes the accelerometer. Only take a spike as liftoff if a real climb
    // follows it: the push lasts, and the altitude keeps rising.
    const slopeF = localSlope(t, hm, 0.15);
    const realClimb = (i) => {
      const iEnd = lb(t, t[i] + 1.5);
      let held = 0;
      for (let k = i; k < iEnd && t[k] < t[i] + 0.3; k++) if (fs[k] > 1.2 * G0) held = t[k] - t[i];
      if (held < 0.15) return false;
      let rose = false, rising = 0, total = 0;
      for (let k = i; k < Math.min(n, iEnd); k++) {
        total++; if (slopeF[k] > 0) rising++;
        if (hm[k] - hm[i] > Math.max(2, thr * 0.5)) rose = true;
      }
      return rose && rising >= 0.7 * total;
    };
    for (let i = Math.max(1, lo); i < Math.min(n, hi); i++) {
      if (fs[i] > 2.5 * G0) {
        if (!realClimb(i)) { const skip = lb(t, t[i] + 0.3); i = Math.max(i, skip - 1); continue; }
        let j = i; while (j > 0 && fs[j] > 1.4 * G0) j--;
        tLift = t[j]; il = j; liftSource = "accelerometer"; break;
      }
    }
  }
  const padLo = lb(t, tLift - 6), padHi = lb(t, tLift - 0.3);
  let ground = padHi - padLo >= 5 ? median(alt.slice(padLo, padHi)) : ground0;
  if (!(padHi - padLo >= 5)) warnings.push("The log starts at or after liftoff, so ground level is estimated from the lowest reading.");
  const sigmaH = Math.max(0.05, padHi - padLo >= 5 ? std(alt.slice(padLo, padHi)) : padNoise);
  let biasNote = null;
  if (f && accAxis !== "acc_kin" && padHi - padLo >= 5) {
    const padF = median(f.slice(padLo, padHi));
    const bias = padF - G0;
    if (Math.abs(bias) < 0.25 * G0) { for (let i = 0; i < n; i++) f[i] -= bias; if (Math.abs(bias) > 0.02 * G0) biasNote = `Accelerometer read ${(padF / G0).toFixed(3)} g on the pad; corrected by ${(-bias / G0).toFixed(3)} g.`; }
  }
  const sigmaA = f && padHi - padLo >= 5 ? Math.max(0.05, std(f.slice(padLo, padHi))) : 0.3;

  const agl = Float64Array.from(alt, (v) => v - ground);
  const tApRough = t[ia];

  // landing: after apogee, near the ground and not moving for 2 s (or the log ends there)
  let iland = n - 1, landed = false;
  {
    const sl = localSlope(t, hm, 0.5);
    const near = Math.max(4, 3 * sigmaH, 0.03 * (hm[ia] - ground0));
    let still = 0, iStill = -1;
    for (let i = ia + 1; i < n; i++) {
      if (hm[i] - ground0 < near && Math.abs(sl[i]) < 1.0) {
        if (iStill < 0) iStill = i;
        still += t[i] - t[i - 1];
        if (still > 2) { iland = iStill; landed = true; break; }
      } else { still = 0; iStill = -1; }
    }
    if (!landed && iStill > 0 && still > 0.6) { iland = iStill; landed = true; }
  }

  // ----- fused estimate (Kalman + RTS) -----
  const burnEnd = tLift + 6;
  const aMeas = f ? Float64Array.from(f, (v, i) => (t[i] < tApRough - 1 && t[i] < tLift + 60 ? v - G0 : NaN)) : null;
  const qFn = (tt) => (tt > tLift - 0.3 && tt < burnEnd ? (f ? 2e3 : 5e4) : (Math.abs(tt - tApRough) < 3 ? 2e3 : 300));
  // Barometers misread near Mach 1; trust them less when the rough speed is high.
  const vRough = localSlope(t, hm, 0.2);
  const a0 = siteAtmosphere({ tempC: padTemp });
  const rHscale = (tt) => { const i = Math.min(n - 1, lb(t, tt)); const m = Math.abs(vRough[i]) / a0.soundSpeed(Math.max(0, hm[i] - ground)); return m > 0.7 ? 400 : 1; };
  const kf = kalmanSmooth(t, agl, aMeas, { rH: sigmaH * sigmaH, rA: Math.max(0.25, (sigmaA * 3) ** 2), q: qFn, rHscale: f ? rHscale : null });

  // ----- events -----
  let iap = il;
  for (let i = il; i < n; i++) if (kf.h[i] > kf.h[iap]) iap = i;
  const apogee = { t: t[iap], h: kf.h[iap], raw: Math.max(...Array.from(agl.slice(Math.max(0, iap - win), Math.min(n, iap + win))).filter(Number.isFinite)) };
  let iv = il;
  for (let i = il; i <= iap; i++) if (kf.v[i] > kf.v[iv]) iv = i;
  const maxV = { t: t[iv], v: kf.v[iv], mach: kf.v[iv] / a0.soundSpeed(Math.max(0, kf.h[iv])) };

  // burns. A burn must hold for a while (hysteresis on a smoothed signal), short
  // dips are merged, and a later ignition only counts if the rocket really
  // speeds up, so vibration and noisy or broken logs don't make dozens.
  const fEst = f ? movingMean(t, f, 0.025) : Float64Array.from(kf.a, (v) => v + G0);
  const fDet = movingMean(t, fEst, 0.06);
  const burns = [];
  {
    const iEnd = Math.min(iap, n - 1);
    const raw = [];
    let on = false, start = 0, below = null, above = null;
    for (let i = il; i <= iEnd; i++) {
      const v = fDet[i];
      const onThr = raw.length ? 2.0 * G0 : 0.4 * G0;
      if (!on) {
        if (v > onThr) { if (above === null) above = t[i]; if (t[i] - above >= (raw.length ? 0.15 : 0)) { on = true; start = above; below = null; } }
        else above = null;
      } else {
        if (v < 0.2 * G0) { if (below === null) below = t[i]; if (t[i] - below >= 0.1) { raw.push({ start, end: below }); on = false; above = null; } }
        else below = null;
      }
    }
    if (on) raw.push({ start, end: t[iEnd] });
    // merge burns separated by short dips
    const merged = [];
    for (const b of raw) {
      const last = merged[merged.length - 1];
      if (last && b.start - last.end < 0.5) last.end = b.end; else merged.push({ ...b });
    }
    const vAt = (tt) => kf.v[Math.min(n - 1, lb(t, tt))];
    for (const b of merged) {
      if (b.end - b.start < 0.08) continue;
      // a later ignition must last and add real speed, and needs an accelerometer:
      // from a barometer alone, twice-differentiated altitude is mostly noise
      if (burns.length && (!f || b.end - b.start < 0.3 || vAt(b.end) - vAt(b.start) < 5)) continue;
      let peak = -Infinity, pt = b.start;
      for (let i = lb(t, b.start); i <= Math.min(iEnd, lb(t, b.end)); i++) if (fEst[i] > peak) { peak = fEst[i]; pt = t[i]; }
      burns.push({ start: b.start, end: b.end, peak, peakT: pt });
    }
    if (!burns.length) burns.push({ start: tLift, end: tLift, peak: NaN, peakT: tLift });
    burns[0].start = Math.min(burns[0].start, tLift);
  }
  let maxAcc = -Infinity, maxAccT = tLift;
  if (f) {
    for (let i = il; i <= iap; i++) if (f[i] > maxAcc) { maxAcc = f[i]; maxAccT = t[i]; }
  } else {
    for (const b of burns) if (b.peak > maxAcc) { maxAcc = b.peak; maxAccT = b.peakT; }
  }
  // without an accelerometer, peak g comes from differentiating altitude twice:
  // near Mach 1 or above 40 g that is noise, not a measurement
  if (!f && (maxV.mach > 0.8 || maxAcc > 40 * G0)) maxAcc = NaN;

  // descent segments
  const iEndDesc = landed ? iland : n - 1;
  // start once the rocket has stopped speeding up after apogee (or 8 s later)
  let descStart = lb(t, apogee.t + 0.5);
  {
    const acc = localSlope(t, kf.v, 0.3);
    const cap = lb(t, apogee.t + 8);
    while (descStart < Math.min(cap, iEndDesc) && !(kf.v[descStart] < -2 && Math.abs(acc[descStart]) < 1.5)) descStart++;
  }
  let segments = [];
  if (iEndDesc - descStart > 10) segments = segmentConstant(Array.from(t.slice(descStart, iEndDesc)), Array.from(kf.v.slice(descStart, iEndDesc), (v) => -v), 3);
  const deployments = [];
  // logged state changes and file events take priority
  const logEvents = [...(flight.events || [])];
  const st = flight.text?.state;
  if (st) {
    let prev = st[0];
    for (let i = 1; i < n; i++) if (st[i] !== prev && st[i] !== "") { logEvents.push({ t: t[i], label: `State: ${st[i]}`, source: "state", state: st[i] }); prev = st[i]; }
  }
  for (let s = 1; s < segments.length; s++) {
    const tt = segments[s].t0;
    const i = lb(t, tt);
    deployments.push({ t: tt, h: kf.h[i], v: kf.v[i], before: segments[s - 1].mean, after: segments[s].mean, source: "descent rate change" });
  }
  // deployment shocks in accelerometer
  const shocks = [];
  if (f) {
    const lo = lb(t, apogee.t - 3);
    let lastT = -Infinity;
    for (let i = lo; i < iEndDesc; i++) if (Math.abs(f[i] - G0) > 3.5 * G0 && t[i] - lastT > 2) { shocks.push({ t: t[i], g: f[i] / G0 }); lastT = t[i]; }
  }

  // landing speed: mean descent over the last few seconds before landing
  const landLo = lb(t, t[iEndDesc] - 4), landHi = lb(t, t[iEndDesc] - 0.5);
  const landingSpeed = landHi > landLo ? -mean(kf.v.slice(landLo, landHi)) : null;

  // phases for bands
  const phases = [];
  const push = (phase, a, b) => { if (b > a) phases.push({ phase, t0: a, t1: b }); };
  push("pad", t[0], tLift);
  let tt = tLift;
  burns.forEach((b, k) => { push("coast", tt, b.start); push("boost", Math.max(tt, b.start), b.end); tt = b.end; });
  push("coast", tt, apogee.t);
  if (segments.length) {
    segments.forEach((s, k) => {
      const kind = segments.length === 1 ? (s.mean > 12 ? "descent" : "main") : k === segments.length - 1 ? "main" : s.mean > 25 ? "descent" : "drogue";
      push(kind, k === 0 ? apogee.t : s.t0, k === segments.length - 1 ? t[iEndDesc] : segments[k + 1].t0);
    });
  } else push("descent", apogee.t, t[iEndDesc]);
  if (landed) push("landed", t[iEndDesc], t[n - 1]);

  // GPS drift
  let drift = null;
  if (S.lat && S.lon) {
    const ok = (i) => Number.isFinite(S.lat[i]) && Number.isFinite(S.lon[i]) && Math.abs(S.lat[i]) > 1e-6;
    let i0 = -1; for (let i = il; i >= 0; i--) if (ok(i)) { i0 = i; break; }
    if (i0 < 0) for (let i = il; i < n; i++) if (ok(i)) { i0 = i; break; }
    let i1 = -1; for (let i = n - 1; i >= 0; i--) if (ok(i)) { i1 = i; break; }
    if (i0 >= 0 && i1 >= 0) {
      const dLat = (S.lat[i1] - S.lat[i0]) * 111320, dLon = (S.lon[i1] - S.lon[i0]) * 111320 * Math.cos((S.lat[i0] * Math.PI) / 180);
      drift = { distance: Math.hypot(dLat, dLon), bearing: (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360, from: [S.lat[i0], S.lon[i0]], to: [S.lat[i1], S.lon[i1]] };
    }
  }

  // data quality
  let gaps = 0;
  for (let i = 1; i < n; i++) if (t[i] - t[i - 1] > 5 * dtMed && t[i] - t[i - 1] > 0.05) gaps++;
  if (gaps) warnings.push(`${gaps} gap${gaps > 1 ? "s" : ""} in the data longer than 5 samples.`);
  if (f && accAxis !== "acc_kin") {
    const mx = Math.max(...Array.from(f.slice(il, iap)).filter(Number.isFinite));
    let flat = 0; for (let i = il; i < iap; i++) if (Math.abs(f[i] - mx) < 1e-6) flat++;
    if (flat > 3) warnings.push(`The accelerometer seems to max out at ${(mx / G0).toFixed(1)} g (flat-topped peak). Peak acceleration may be higher than shown.`);
  }
  if (biasNote) warnings.push(biasNote);
  if (!landed) warnings.push("No landing found; the log may end before touchdown.");
  if (maxV.mach > 0.7 && !f) warnings.push("Speed was high enough that barometer readings near peak speed may be off (Mach effects).");

  const rel = (x) => (x == null ? null : x - tLift);
  return {
    notFlight, t, rate, dtMed, altSource, accAxis, liftSource, ground, padTempC: padTemp, sigmaH, sigmaA,
    agl, f, h: kf.h, v: kf.v, a: kf.a, velBaro: localSlope(t, agl, 0.25),
    tLift, il, iap, iland: iEndDesc, landed,
    apogee, maxV, maxAcc: { g: maxAcc / G0, t: maxAccT },
    burns, segments, deployments, shocks, logEvents, phases, drift, landingSpeed,
    stats: {
      apogee: apogee.h, apogeeRaw: apogee.raw, timeToApogee: apogee.t - tLift, maxVelocity: maxV.v, maxMach: maxV.mach,
      maxAccelG: maxAcc / G0, burnTime: burns[0].end - burns[0].start, burnouts: burns.map((b) => rel(b.end)),
      coastTime: apogee.t - burns[burns.length - 1].end, landingSpeed, flightTime: landed ? t[iEndDesc] - tLift : null,
      descentRates: segments.map((s) => s.mean), drift: drift?.distance ?? null,
    },
    warnings,
  };
}

// ---------- drag coefficient from the coast phase ----------
export function estimateCd(res, { mass, diameter, site = {} }) {
  if (!(mass > 0) || !(diameter > 0)) return null;
  const A = Math.PI * (diameter / 2) ** 2;
  const atm = siteAtmosphere({ tempC: res.padTempC, ...site });
  const tb = res.burns[res.burns.length - 1].end;
  const out = { t: [], cd: [], mach: [], v: [] };
  for (let i = res.il; i < res.iap; i++) {
    const tt = res.t[i];
    if (tt < tb + 0.25 || tt > res.apogee.t - 0.8) continue;
    const v = res.v[i];
    if (v < 15) continue;
    const fv = res.f ? res.f[i] : res.a[i] + G0; // specific force; = -D/m in coast
    const D = -mass * fv;
    const rho = atm.density(Math.max(0, res.h[i]));
    const cd = (2 * D) / (rho * v * v * A);
    if (!Number.isFinite(cd) || cd < -0.5 || cd > 3) continue;
    out.t.push(tt - res.tLift); out.cd.push(cd); out.mach.push(v / atm.soundSpeed(res.h[i])); out.v.push(v);
  }
  if (out.cd.length < 5) return { ...out, median: null, n: out.cd.length, note: "Not enough coast data above 15 m/s to estimate drag." };
  const sorted = [...out.cd].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { ...out, median: median(out.cd), p25: q(0.25), p75: q(0.75), n: out.cd.length, source: res.f ? "accelerometer" : "barometer (noisier)" };
}

// ---------- comparison with a predicted flight ----------
// pred: {t (s from liftoff), h, v}
export function compare(res, pred) {
  const t = [], dh = [], dv = [], ph = [], pv = [];
  const tEnd = Math.min(pred.t[pred.t.length - 1], res.t[res.iland] - res.tLift);
  for (let i = res.il; i <= res.iland; i++) {
    const tt = res.t[i] - res.tLift;
    if (tt > tEnd) break;
    const h = interp(pred.t, pred.h, tt), v = interp(pred.t, pred.v, tt);
    t.push(tt); ph.push(h); pv.push(v); dh.push(res.h[i] - h); dv.push(res.v[i] - v);
  }
  let pi = 0; for (let i = 1; i < pred.h.length; i++) if (pred.h[i] > pred.h[pi]) pi = i;
  let pvMax = -Infinity; for (const v of pred.v) if (v > pvMax) pvMax = v;
  return {
    t, dh, dv, ph, pv,
    apogee: { actual: res.apogee.h, predicted: pred.h[pi] },
    timeToApogee: { actual: res.apogee.t - res.tLift, predicted: pred.t[pi] },
    maxVelocity: { actual: res.maxV.v, predicted: pvMax },
  };
}
