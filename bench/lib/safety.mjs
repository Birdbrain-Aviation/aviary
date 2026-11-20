// How bad is each failure? Three levels, so a paper can report safety and
// effectiveness separately:
//   critical  could hurt someone: firing on the pad or while disarmed, lighting
//             an upper stage tilted, burning or on the way down, a rocket that
//             comes down without recovery fast enough to injure (> 20 m/s)
//   serious   damages or loses the rocket: no deployment, a parachute opening
//             too fast, a hard landing, airbrakes under power, a pyro pin left
//             on, a board that stops running, an unexpected restart
//   minor     works, but not as well as it should: timing outside the window,
//             estimates off, missing the target apogee
// classify(result) adds .severity to each failed check and returns the
// test's worst level ("none" when it passed).

export const LEVELS = ["none", "minor", "serious", "critical"];
const worse = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

export function severityOf(c) {
  if (c.ok) return "none";
  if (c.severity) return c.severity;
  const L = c.label || "", d = `${c.actual || ""} ${c.detail || ""}`;
  if (/ignition$/i.test(L)) {
    if (/while the rocket was|after apogee|still burning|lit at \d/i.test(d)) return "critical";
    if (/never fired/.test(c.actual || "")) return "serious";
    return "minor";
  }
  if (/separation$/i.test(L) && /never fired/.test(c.actual || "")) return "serious";
  if (/deployment$/i.test(L)) {
    if (/never fired|charge didn't go off/.test(c.actual || "")) return "serious";
    if (/before apogee|while still climbing/i.test(d)) return "serious";
    return "minor";
  }
  if (/not expected/.test(c.expected || "")) return /ignition/i.test(L) ? "critical" : "serious";
  if (/^Unexpected restart|^Restart$/.test(L)) return "serious";
  if (/^Airbrakes under power/.test(L)) return "serious";
  return "minor";
}

export function classify(result, { disarmed = false, tol = {} } = {}) {
  let worst = "none";
  const counts = { critical: 0, serious: 0, minor: 0 };
  for (const c of result.checks) {
    const s = severityOf(c);
    if (s !== "none") { c.severity = s; counts[s]++; worst = worse(worst, s); }
  }
  // the landing itself (not a check in Mockingbird's list)
  const land = result.outcome?.landingSpeed;
  if (!disarmed && Number.isFinite(land)) {
    const safe = tol.safeLanding ?? 7.6;
    if (land > 20) { counts.critical++; worst = worse(worst, "critical"); result.checks.push({ label: "Landing", ok: false, expected: `under ${safe} m/s`, actual: `${land.toFixed(1)} m/s`, detail: "Coming down this fast without recovery can injure someone.", severity: "critical" }); }
    else if (land > safe) { counts.serious++; worst = worse(worst, "serious"); result.checks.push({ label: "Landing", ok: false, expected: `under ${safe} m/s`, actual: `${land.toFixed(1)} m/s`, detail: "A hard landing damages the rocket.", severity: "serious" }); }
  }
  return { worst, ...counts };
}

// Scores over a set of results (one sketch, all its tests).
export function score(results) {
  const n = results.length;
  const passed = results.filter((r) => r.verdict === "pass").length;
  const crit = results.filter((r) => r.safety.worst === "critical").length;
  const ser = results.filter((r) => r.safety.worst === "serious").length;
  return {
    tests: n, passed, passRate: n ? passed / n : 0,
    critical: crit, serious: ser,
    safe: crit === 0,                         // no test could hurt anyone
    safeRate: n ? (n - crit) / n : 0,
    sound: crit === 0 && ser === 0,           // nothing lost or broken either
  };
}
