// Rocket motors: RASP .eng and RockSim .rse import, plus a quick motor
// builder for when you only know the designation (e.g. "G80") and impulse.

const LETTERS = "ABCDEFGHIJKLMNOPQRS";

export function impulseClass(I) {
  if (!(I > 0)) return "?";
  if (I <= 0.3125) return "1/8A";
  if (I <= 0.625) return "1/4A";
  if (I <= 1.25) return "1/2A";
  const n = Math.ceil(Math.log2(I / 1.25) - 1e-9);
  return LETTERS[Math.min(LETTERS.length - 1, Math.max(0, n - 1))];
}

// Class bounds in N·s, e.g. G → [80, 160]
export function classRange(letter) {
  const i = LETTERS.indexOf(letter.toUpperCase());
  if (i < 0) return null;
  return [1.25 * Math.pow(2, i), 2.5 * Math.pow(2, i)];
}

// Normalise a motor object and precompute what the simulator needs.
export function finishMotor(m) {
  let t = m.t.map(Number), f = m.f.map(Number);
  // sort, drop junk, start at (0,0), end at thrust 0
  const pts = t.map((x, i) => [x, f[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0).sort((a, b) => a[0] - b[0]);
  if (!pts.length) throw new Error("motor has no thrust data");
  if (pts[0][0] > 0) pts.unshift([0, 0]);
  if (pts[pts.length - 1][1] !== 0) pts.push([pts[pts.length - 1][0] + 0.01, 0]);
  t = pts.map((p) => p[0]); f = pts.map((p) => Math.max(0, p[1]));
  const cum = [0];
  for (let i = 1; i < t.length; i++) cum.push(cum[i - 1] + 0.5 * (f[i] + f[i - 1]) * (t[i] - t[i - 1]));
  const I = cum[cum.length - 1];
  const burn = t[t.length - 1];
  const peak = Math.max(...f);
  // burn time as commonly quoted: time thrust is above 5% of peak
  let tb0 = 0, tb1 = burn;
  for (let i = 0; i < t.length; i++) if (f[i] >= 0.05 * peak) { tb0 = t[i]; break; }
  for (let i = t.length - 1; i >= 0; i--) if (f[i] >= 0.05 * peak) { tb1 = t[i]; break; }
  const propMass = m.propMass > 0 ? m.propMass : I / (9.80665 * 190);
  const totalMass = m.totalMass > 0 ? m.totalMass : propMass * 2;
  return {
    name: m.name || "Motor", manufacturer: m.manufacturer || "", diameter: m.diameter || 0, length: m.length || 0,
    delays: m.delays || "", propMass, totalMass, source: m.source || "file", quick: m.quick,
    t, f, cum, totalImpulse: I, burnTime: tb1 - tb0, endTime: burn, peakThrust: peak,
    avgThrust: I / Math.max(1e-6, tb1 - tb0), cls: impulseClass(I),
  };
}

export function thrustAt(m, tt) {
  if (tt <= 0 || tt >= m.t[m.t.length - 1]) return 0;
  let lo = 0, hi = m.t.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (m.t[mid] <= tt) lo = mid; else hi = mid; }
  const a = m.t[lo], b = m.t[hi];
  return m.f[lo] + ((m.f[hi] - m.f[lo]) * (tt - a)) / (b - a || 1);
}

export function impulseAt(m, tt) {
  if (tt <= 0) return 0;
  const n = m.t.length;
  if (tt >= m.t[n - 1]) return m.totalImpulse;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (m.t[mid] <= tt) lo = mid; else hi = mid; }
  const fa = m.f[lo], ft = thrustAt(m, tt);
  return m.cum[lo] + 0.5 * (fa + ft) * (tt - m.t[lo]);
}

// Mass of one motor tt seconds after ignition (tt < 0 means not lit).
export function motorMass(m, tt) {
  if (tt <= 0) return m.totalMass;
  return m.totalMass - m.propMass * (impulseAt(m, tt) / (m.totalImpulse || 1));
}

// ---------- RASP .eng ----------
export function parseEng(text) {
  const motors = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    const isData = tok.length >= 2 && tok.length <= 3 && tok.every((x) => /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(x));
    if (!isData && tok.length >= 7) {
      if (cur && cur.t.length) motors.push(cur);
      cur = {
        name: tok[0], diameter: Number(tok[1]) / 1000, length: Number(tok[2]) / 1000, delays: tok[3],
        propMass: Number(tok[4]), totalMass: Number(tok[5]), manufacturer: tok.slice(6).join(" "), t: [], f: [], source: "eng",
      };
    } else if (isData && cur) {
      cur.t.push(Number(tok[0])); cur.f.push(Number(tok[1]));
    }
  }
  if (cur && cur.t.length) motors.push(cur);
  if (!motors.length) throw new Error("No motors found. A RASP .eng file has a header line (name, diameter, length, delays, propellant kg, total kg, maker) followed by time/thrust pairs.");
  return motors.map(finishMotor);
}

// ---------- RockSim .rse ----------
export function parseRse(text) {
  const motors = [];
  const engRe = /<engine\b([^>]*)>([\s\S]*?)<\/engine>/gi;
  const attr = (s, k) => { const m = s.match(new RegExp("\\b" + k + "\\s*=\\s*\"([^\"]*)\"", "i")); return m ? m[1] : ""; };
  let m;
  while ((m = engRe.exec(text))) {
    const a = m[1];
    const t = [], f = [];
    const ptRe = /<eng-data\b([^>]*)\/?>/gi;
    let p;
    while ((p = ptRe.exec(m[2]))) { t.push(Number(attr(p[1], "t"))); f.push(Number(attr(p[1], "f"))); }
    motors.push(finishMotor({
      name: attr(a, "code"), manufacturer: attr(a, "mfg"), diameter: Number(attr(a, "dia")) / 1000, length: Number(attr(a, "len")) / 1000,
      delays: attr(a, "delays"), propMass: Number(attr(a, "propWt")) / 1000, totalMass: Number(attr(a, "initWt")) / 1000, t, f, source: "rse",
    }));
  }
  if (!motors.length) throw new Error("No motors found in the RockSim file.");
  return motors;
}

export function parseMotorFile(name, text) {
  return /\.rse$/i.test(name) || /<engine\b/i.test(text) ? parseRse(text) : parseEng(text);
}

// ---------- quick motor ----------
// designation like "G80" (letter + average thrust), total impulse in N·s
// (defaults to the middle of the class), burn shape.
export function quickMotor({ designation = "G80", totalImpulse, propMass, totalMass, shape = "neutral", diameter = 0.029 } = {}) {
  const mm = String(designation).toUpperCase().match(/^([A-S])\s*(\d+(?:\.\d+)?)/);
  if (!mm) throw new Error('Designation should look like "G80" (impulse class letter, then average thrust in newtons).');
  const [lo, hi] = classRange(mm[1]);
  const avg = Number(mm[2]);
  const I = totalImpulse > 0 ? totalImpulse : (lo + hi) / 2;
  const tb = I / avg;
  // shape templates on normalised time 0..1 (relative thrust)
  const shapes = {
    neutral: [[0, 0], [0.03, 1.25], [0.08, 1.1], [0.5, 1.0], [0.88, 0.95], [0.96, 0.4], [1, 0]],
    regressive: [[0, 0], [0.03, 1.7], [0.15, 1.4], [0.5, 0.95], [0.85, 0.7], [0.95, 0.3], [1, 0]],
    progressive: [[0, 0], [0.04, 0.8], [0.3, 0.9], [0.7, 1.15], [0.9, 1.2], [0.97, 0.5], [1, 0]],
    blackpowder: [[0, 0], [0.06, 2.6], [0.12, 2.2], [0.2, 0.7], [0.9, 0.6], [0.97, 0.3], [1, 0]],
  };
  const tpl = shapes[shape] || shapes.neutral;
  let area = 0;
  for (let i = 1; i < tpl.length; i++) area += 0.5 * (tpl[i][1] + tpl[i - 1][1]) * (tpl[i][0] - tpl[i - 1][0]);
  const k = I / (area * tb);
  const t = tpl.map((p) => +(p[0] * tb).toFixed(4));
  const f = tpl.map((p) => +(p[1] * k).toFixed(3));
  const isp = shape === "blackpowder" ? 80 : 190;
  const pm = propMass > 0 ? propMass : I / (9.80665 * isp);
  return finishMotor({
    name: `${mm[1]}${mm[2]} (approx.)`, manufacturer: "Quick motor", diameter, t, f, propMass: pm,
    totalMass: totalMass > 0 ? totalMass : pm * (shape === "blackpowder" ? 1.9 : 2.1), source: "quick",
    quick: { designation, totalImpulse: I, shape },
  });
}

// Plain-data form for saving inside rocket profiles.
export function motorToJSON(m) {
  const { cum, ...rest } = m;
  return rest;
}
export function motorFromJSON(o) { return o ? finishMotor(o) : null; }
