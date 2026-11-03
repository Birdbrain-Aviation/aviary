// Turn a flight log (any format Heron reads) into replay data for
// Mockingbird's ReplaySim: the measured altitude and acceleration, with the
// liftoff, burnout, apogee and landing times Heron finds in it.

import { parseLogText, guessMapping, buildFlight } from "./flightlog.js";
import { analyzeFlight } from "./analysis.js";
import { gpsTrack } from "./flight3d.js";
import { G0 } from "./units.js";

export function replayFromLog(text, name = "log", mapping = null) {
  const parsed = parseLogText(text, name);
  const flight = buildFlight(parsed, mapping || guessMapping(parsed));
  const res = analyzeFlight(flight);
  return { ...replayFromAnalysis(res, flight, name), res, flight };
}

export function replayFromAnalysis(res, flight, name = "log") {
  const L = res.tLift;
  // from up to 20 s before liftoff (real pad data) to a few seconds after landing
  const tEnd = res.landed ? res.t[res.iland] + 4 : res.t[res.t.length - 1];
  const idx = [];
  for (let i = 0; i < res.t.length; i++) if (res.t[i] >= L - 20 && res.t[i] <= tEnd) idx.push(i);
  const pick = (arr) => (arr ? idx.map((i) => arr[i]) : null);
  const t = idx.map((i) => res.t[i] - L);
  // what the barometer measured (not the smoothed estimate), so the board sees the real noise
  const h = pick(res.agl);
  const v = pick(res.v);
  // with no accelerometer in the log, the estimate's acceleration stands in for one
  const f = res.f ? pick(res.f) : idx.map((i) => res.a[i] + G0);
  const S = flight.series || {};
  const trk = S.lat && S.lon ? gpsTrack(Array.from(res.t), S.lat, S.lon, L) : null;
  const replay = {
    name, t, h, v, f,
    east: trk ? pick(trk.east) : null, north: trk ? pick(trk.north) : null,
    tBurn: res.burns[res.burns.length - 1].end - L, tApogee: res.apogee.t - L, hApogee: res.apogee.h,
    tLand: res.landed ? res.t[res.iland] - L : null, landSpeed: res.landingSpeed ?? null,
    accelFromLog: !!res.f, notFlight: !!res.notFlight,
  };
  const summary = {
    apogee: res.apogee.h, timeToApogee: res.apogee.t - L, burnout: replay.tBurn, flightTime: replay.tLand, padBefore: Math.max(0, -t[0]),
    accel: res.f ? "from the log" : "estimated from altitude (no accelerometer in the log)", rate: res.rate,
  };
  return { replay, summary, geo: trk ? { lat: trk.lat0, lon: trk.lon0 } : null };
}
