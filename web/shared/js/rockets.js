// Rocket profiles shared by all three apps (stored by the host as
// %APPDATA%\Aviary\rockets.json). Units are SI throughout.

import { quickMotor, motorToJSON } from "./motors.js";

export function uid(prefix = "r") { return prefix + "_" + Math.random().toString(36).slice(2, 9); }

export function newStage(i = 0) {
  return {
    name: i === 0 ? "Booster" : "Sustainer", dryMass: 0.5, diameter: 0.054, cd: 0.5,
    motor: motorToJSON(quickMotor({ designation: "G80", totalImpulse: 120 })), motorCount: 1,
    ignition: i === 0 ? "pad" : "commanded", ignitionDelay: 1.0, separation: "burnout",
  };
}

export function newDevice(kind = "main") {
  return kind === "drogue"
    ? { id: uid("d"), name: "Drogue", kind: "drogue", diameter: 0.3, cd: 0.8, deploy: "apogee", delay: 1, altitude: 150, time: 0, inflation: 0.4, pyro: 1 }
    : { id: uid("d"), name: "Main", kind: "main", diameter: 0.9, cd: 0.8, deploy: "altitude", delay: 0, altitude: 152.4, time: 0, inflation: 1.0, pyro: 2 };
}

export function exampleRockets() {
  const g80 = motorToJSON(quickMotor({ designation: "G80", totalImpulse: 120, propMass: 0.0625, totalMass: 0.125 }));
  const c6 = motorToJSON(quickMotor({ designation: "C6", totalImpulse: 9, propMass: 0.0125, totalMass: 0.024, shape: "blackpowder", diameter: 0.018 }));
  return [
    {
      id: "example-dual", name: "Example: 54 mm G dual deploy", notes: "Approximate G80 curve. Import the real .eng from thrustcurve.org for accurate results.",
      stages: [{ name: "Rocket", dryMass: 0.75, diameter: 0.054, cd: 0.5, motor: g80, motorCount: 1, ignition: "pad", ignitionDelay: 0, separation: "burnout" }],
      recovery: [
        { id: "drogue", name: "Drogue", kind: "drogue", diameter: 0.3, cd: 0.8, deploy: "apogee", delay: 1, altitude: 0, time: 0, inflation: 0.4, pyro: 1 },
        { id: "main", name: "Main", kind: "main", diameter: 0.76, cd: 0.8, deploy: "altitude", delay: 0, altitude: 152.4, time: 0, inflation: 1.0, pyro: 2 },
      ],
      descentBodyCd: 0.8,
    },
    {
      id: "example-two-stage", name: "Example: two-stage G", notes: "Drag separation at booster burnout; the flight computer lights the sustainer 1 s later.",
      stages: [
        { name: "Booster", dryMass: 0.35, diameter: 0.054, cd: 0.55, motor: g80, motorCount: 1, ignition: "pad", ignitionDelay: 0, separation: "burnout" },
        { name: "Sustainer", dryMass: 0.6, diameter: 0.054, cd: 0.45, motor: g80, motorCount: 1, ignition: "commanded", ignitionDelay: 1.0, separation: "burnout" },
      ],
      recovery: [
        { id: "drogue", name: "Drogue", kind: "drogue", diameter: 0.3, cd: 0.8, deploy: "apogee", delay: 1, altitude: 0, time: 0, inflation: 0.4, pyro: 1 },
        { id: "main", name: "Main", kind: "main", diameter: 0.76, cd: 0.8, deploy: "altitude", delay: 0, altitude: 152.4, time: 0, inflation: 1.0, pyro: 2 },
      ],
      descentBodyCd: 0.8,
    },
    {
      id: "example-c6", name: "Example: small C6 rocket", notes: "Single deploy by the motor's ejection charge.",
      stages: [{ name: "Rocket", dryMass: 0.055, diameter: 0.025, cd: 0.6, motor: c6, motorCount: 1, ignition: "pad", ignitionDelay: 0, separation: "burnout" }],
      recovery: [{ id: "chute", name: "Parachute", kind: "chute", diameter: 0.3, cd: 0.8, deploy: "motor", delay: 5, altitude: 0, time: 0, inflation: 0.3, pyro: 0 }],
      descentBodyCd: 0.8,
    },
  ];
}

export function blankRocket() {
  return {
    id: uid(), name: "New rocket", notes: "",
    stages: [{ ...newStage(0), name: "Rocket" }],
    recovery: [newDevice("drogue"), newDevice("main")],
    descentBodyCd: 0.8,
  };
}

export const DEFAULT_SITE = {
  name: "Launch site", elevation: 0, tempC: 15, windSpeed: 3, windDir: 270, railLength: 1.5, lat: 40.85, lon: -119.12,
};

// Load the shared rocket list, seeding it with examples on first run.
export async function loadRockets(host) {
  let store = null;
  try { store = await host.getStore("rockets"); } catch { /* none yet */ }
  if (!store || !Array.isArray(store.rockets) || !store.rockets.length) {
    store = { rockets: exampleRockets(), selected: "example-dual", site: { ...DEFAULT_SITE } };
  }
  store.site = { ...DEFAULT_SITE, ...(store.site || {}) };
  if (!store.rockets.find((r) => r.id === store.selected)) store.selected = store.rockets[0].id;
  return store;
}

export async function saveRockets(host, store) {
  await host.putStore("rockets", store);
}

export function describeRocket(r) {
  const s = r.stages;
  const motors = s.map((st) => `${st.motorCount > 1 ? st.motorCount + "× " : ""}${st.motor?.name || "no motor"}`).join(" + ");
  return `${s.length > 1 ? s.length + " stages, " : ""}${motors}`;
}

export function liftoffMass(r) {
  return r.stages.reduce((m, st) => m + st.dryMass + (st.motor?.totalMass || 0) * (st.motorCount || 1), 0);
}
