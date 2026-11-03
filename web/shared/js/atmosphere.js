// International Standard Atmosphere with a ground reference, so a launch site
// at any elevation and temperature can be modelled.

export const R_AIR = 287.05287;   // J/(kg·K)
export const LAPSE = 0.0065;      // K/m in the troposphere
export const G = 9.80665;
export const GAMMA = 1.4;
export const P_SEA = 101325;
export const T_SEA = 288.15;
const EXP = G / (R_AIR * LAPSE);  // ≈ 5.2559

// Standard pressure at an elevation above mean sea level.
export function isaPressure(elevM) {
  if (elevM <= 11000) return P_SEA * Math.pow(1 - (LAPSE * elevM) / T_SEA, EXP);
  const p11 = P_SEA * Math.pow(1 - (LAPSE * 11000) / T_SEA, EXP);
  return p11 * Math.exp((-G * (elevM - 11000)) / (R_AIR * 216.65));
}

// Site atmosphere. heights are metres above the launch site (AGL).
export function siteAtmosphere(site = {}) {
  const elev = site.elevation ?? 0;
  const tGround = (site.tempC ?? 15) + 273.15;
  const pGround = site.pressurePa ?? isaPressure(elev);
  const tropoTop = Math.max(0, 11000 - elev);
  const tTop = tGround - LAPSE * tropoTop;
  const pTop = pGround * Math.pow(tTop / tGround, EXP);
  const temp = (h) => (h <= tropoTop ? tGround - LAPSE * Math.max(h, -500) : tTop);
  const pressure = (h) => {
    if (h <= tropoTop) return pGround * Math.pow((tGround - LAPSE * h) / tGround, EXP);
    return pTop * Math.exp((-G * (h - tropoTop)) / (R_AIR * tTop));
  };
  return {
    elevation: elev, tGround, pGround,
    temp,
    pressure,
    density: (h) => pressure(h) / (R_AIR * temp(h)),
    soundSpeed: (h) => Math.sqrt(GAMMA * R_AIR * temp(h)),
    // height above the site from a pressure reading (what an altimeter does)
    heightFromPressure: (p) => altitudeFromPressure(p, pGround, tGround),
  };
}

// Barometric altitude above the point where pressure was p0 (temperature t0 K).
export function altitudeFromPressure(p, p0, t0K = 288.15) {
  if (!(p > 0) || !(p0 > 0)) return NaN;
  return (t0K / LAPSE) * (1 - Math.pow(p / p0, 1 / EXP));
}

export function densityAt(h, site) { return siteAtmosphere(site).density(h); }
