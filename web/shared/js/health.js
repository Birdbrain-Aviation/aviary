// Sensor health: problems with the flight computer's own data, as opposed to
// the flight. Each check says what was found, when, and what it means.
//
//   sensorHealth(flight, res, D) -> [{ level: "ok"|"warn"|"bad", title, detail }]
//
// flight: Heron's flight object (raw series by role), res: analyzeFlight(),
// D: units display (fmtAlt, altUnit...).

import { G0 } from "./units.js";

const PHASE_WORD = { pad: "on the pad", boost: "during the burn", coast: "while coasting", descent: "in free fall", drogue: "under the drogue", main: "under the main", landed: "after landing" };

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const lb = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

export function sensorHealth(flight, res, D) {
  const out = [];
  const t = res.t, n = t.length, L = res.tLift;
  const S = flight.series || {};
  const at = (tt) => `T${tt - L < 0 ? "−" : "+"}${Math.abs(tt - L).toFixed(1)} s`;
  const phaseAt = (tt) => { const p = res.phases.find((q) => tt >= q.t0 && tt < q.t1); return p ? PHASE_WORD[p.phase] || "" : ""; };
  const alt = (m) => `${D.fmtAlt(m)} ${D.altUnit}`;
  const flightEnd = t[res.iland] ?? t[n - 1];

  // ---- sample rate and gaps
  {
    const dts = []; for (let i = 1; i < n; i++) dts.push(t[i] - t[i - 1]);
    const dt = median(dts);
    let worst = null, count = 0;
    for (let i = 1; i < n; i++) {
      const g = t[i] - t[i - 1];
      if (g > Math.max(5 * dt, 0.05) && t[i] > L - 2 && t[i - 1] < flightEnd) { count++; if (!worst || g > worst.g) worst = { g, t: t[i - 1] }; }
    }
    const rate = 1 / dt;
    if (!count) out.push({ level: "ok", title: "Steady logging", detail: `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} samples per second with no gaps during the flight.` });
    else out.push({ level: worst.g > 0.5 ? "bad" : "warn", title: `${count} gap${count > 1 ? "s" : ""} in the logging`,
      detail: `Normally ${Math.round(rate)} samples per second. The longest gap is ${worst.g.toFixed(2)} s at ${at(worst.t)}, ${phaseAt(worst.t)}. Slow SD card writes or a busy processor usually cause this; events in a gap are found late.` });
  }

  // ---- barometer and accelerometer agreement over the boost
  if (res.f && res.agl && res.altSource !== "accelerometer" && res.burns.length) {
    const i0 = res.il, i1 = lb(t, res.burns[0].end + 0.5);
    if (i1 - i0 > 5) {
      let v = 0, h = 0;
      for (let i = i0 + 1; i <= i1 && i < n; i++) { const dt = t[i] - t[i - 1]; const a = 0.5 * (res.f[i] + res.f[i - 1]) - G0; h += v * dt + 0.5 * a * dt * dt; v += a * dt; }
      const hb = res.agl[Math.min(i1, n - 1)] - res.agl[i0];
      const diff = Math.abs(h - hb) / Math.max(15, Math.abs(hb));
      if (diff > 0.3) out.push({ level: "warn", title: "Barometer and accelerometer disagree",
        detail: `By ${at(t[Math.min(i1, n - 1)])} the accelerometer puts the rocket at ${alt(h)} and the barometer at ${alt(hb)}. ${res.stats?.maxMach > 0.7 ? " At this speed the barometer usually lags; that is the likely cause." : " Check the accelerometer's axis and units, or for a barometer that lags (small or blocked vent holes)."}` });
      else out.push({ level: "ok", title: "Barometer and accelerometer agree", detail: `Within ${Math.round(diff * 100)}% over the burn (${alt(hb)} by ${at(t[Math.min(i1, n - 1)])}).` });
    }
  }

  // ---- accelerometer saturation
  if (res.f && res.accAxis !== "acc_kin") {
    let mx = -Infinity, iMx = res.il;
    for (let i = res.il; i < res.iap; i++) if (res.f[i] > mx) { mx = res.f[i]; iMx = i; }
    let run = 0, best = 0;
    for (let i = res.il; i < res.iap; i++) { if (Math.abs(res.f[i] - mx) < 1e-6) best = Math.max(best, ++run); else run = 0; }
    if (best >= 3) out.push({ level: "bad", title: `Accelerometer maxed out at ${(mx / G0).toFixed(1)} g`,
      detail: `The reading sat flat at its limit for ${best} samples around ${at(t[iMx])}. The real peak was higher; use a higher-range setting or a high-g accelerometer.` });
  }

  // ---- barometer stuck while moving
  if (res.agl && res.altSource !== "accelerometer") {
    let i = res.il, worst = null;
    while (i < res.iland) {
      let j = i;
      while (j + 1 < res.iland && res.agl[j + 1] === res.agl[i]) j++;
      const dur = t[j] - t[i];
      if (dur > 0.5 && Math.abs(res.v[i]) > 15 && (!worst || dur > worst.dur)) worst = { dur, t: t[i] };
      i = j + 1;
    }
    if (worst) out.push({ level: "warn", title: "Barometer reading froze", detail: `It held one value for ${worst.dur.toFixed(1)} s from ${at(worst.t)} while the rocket was moving fast, ${phaseAt(worst.t)}. A sensor that stops updating can hide apogee.` });
  }

  // ---- wild readings that were replaced
  const wild = res.warnings.find((w) => /wild reading/.test(w));
  if (wild) out.push({ level: "warn", title: "Wild readings replaced", detail: wild + " Ejection charges and loose wiring are common causes." });

  // ---- barometer noise on the pad
  if (res.agl && res.il > 10) {
    const pad = Array.from(res.agl.slice(Math.max(0, res.il - 200), Math.max(1, res.il - 5)));
    const m = median(pad), sd = Math.sqrt(pad.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, pad.length));
    if (Number.isFinite(sd)) out.push({ level: sd > 1 ? "warn" : "ok", title: sd > 1 ? "Noisy barometer on the pad" : "Quiet barometer on the pad",
      detail: `About ±${D.fmtAlt(sd, D.altUnit === "ft" ? 1 : 2)} ${D.altUnit} of noise before launch.${sd > 1 ? " Shield it from light and airflow, and check its oversampling setting." : ""}` });
  }

  // ---- GPS
  if (S.lat && S.lon) {
    const ok = []; for (let i = 0; i < n; i++) if (Number.isFinite(S.lat[i]) && Number.isFinite(S.lon[i]) && Math.abs(S.lat[i]) > 1e-6) ok.push(t[i]);
    if (!ok.length) out.push({ level: "bad", title: "No GPS position", detail: "The GPS columns have no valid fix anywhere in the log." });
    else {
      const gaps = []; for (let i = 1; i < ok.length; i++) gaps.push(ok[i] - ok[i - 1]);
      const typ = median(gaps) || 1;
      let worst = null;
      for (let i = 1; i < ok.length; i++) { const g = ok[i] - ok[i - 1]; if (g > Math.max(2, 4 * typ) && ok[i] > L - 5 && ok[i - 1] < flightEnd && (!worst || g > worst.g)) worst = { g, t: ok[i - 1] }; }
      const minSats = S.sats ? Math.min(...Array.from(S.sats).filter((x) => Number.isFinite(x) && x >= 0)) : null;
      if (worst) out.push({ level: "warn", title: "GPS dropped out", detail: `No position for ${worst.g.toFixed(1)} s from ${at(worst.t)}, ${phaseAt(worst.t)}. GPS often loses lock under high acceleration; it should come back for the landing position.${Number.isFinite(minSats) ? ` Fewest satellites: ${minSats}.` : ""}` });
      else out.push({ level: "ok", title: "GPS kept its fix", detail: `A position about every ${typ < 1 ? (typ * 1000).toFixed(0) + " ms" : typ.toFixed(1) + " s"} through the flight.${Number.isFinite(minSats) ? ` Fewest satellites: ${minSats}.` : ""}` });
    }
  }

  // ---- battery
  if (S.batt) {
    const b = S.batt;
    const pad = median(Array.from(b.slice(Math.max(0, res.il - 300), Math.max(1, res.il))));
    let worst = null;
    for (const d of res.deployments) {
      const i0 = lb(t, d.t - 0.3), i1 = lb(t, d.t + 1.5);
      let mn = Infinity, tm = d.t; for (let i = i0; i < i1 && i < n; i++) if (b[i] < mn) { mn = b[i]; tm = t[i]; }
      if (Number.isFinite(mn) && (!worst || pad - mn > pad - worst.mn)) worst = { mn, t: tm };
    }
    let mnAll = Infinity; for (let i = res.il; i < res.iland; i++) if (b[i] < mnAll) mnAll = b[i];
    if (worst && pad - worst.mn > Math.max(0.4, 0.08 * pad)) out.push({ level: "warn", title: "Battery sagged at deployment", detail: `From ${pad.toFixed(2)} V on the pad to ${worst.mn.toFixed(2)} V at ${at(worst.t)}. A big sag when a charge fires can reset the flight computer; use a separate pyro battery or a bigger capacitor.` });
    else if (Number.isFinite(pad)) out.push({ level: "ok", title: "Battery steady", detail: `${pad.toFixed(2)} V on the pad, lowest ${Number.isFinite(mnAll) ? mnAll.toFixed(2) : pad.toFixed(2)} V in flight.` });
  }

  // ---- fast flights and the barometer
  if (res.stats?.maxMach > 0.8 && res.altSource !== "accelerometer")
    out.push({ level: "warn", title: "Near or past Mach 1", detail: `Top speed was Mach ${res.stats.maxMach.toFixed(2)}. Shock waves upset the barometer near Mach 1, so altitude and speed readings around ${at(res.maxV.t ?? L)} are less reliable.` });

  const order = { bad: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
