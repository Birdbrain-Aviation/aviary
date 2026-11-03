// Rocket profile editor (stages, motors, recovery, launch site) with a live
// prediction. Profiles are shared with Heron and Owl.
import { h, clear, toast, modal, numField, textField, selectField, debounce, pickFile, readFileText, download, confirmBox, safeName } from "/shared/js/ui.js";
import { host } from "/shared/js/host.js";
import { display, fmt, G0 } from "/shared/js/units.js";
import { TimeChart, ChartGroup } from "/shared/js/chart.js";
import { simulate, PHASE_LABEL } from "/shared/js/sim.js";
import { quickMotor, motorToJSON, parseMotorFile, impulseClass } from "/shared/js/motors.js";
import { uid, newStage, newDevice, saveRockets, liftoffMass } from "/shared/js/rockets.js";

// Editing units: small rockets read better in ounces/inches or grams/millimetres.
export function editUnits(system) {
  const imp = system === "imperial";
  const id = (x) => x;
  return {
    mass: imp ? { u: "oz", to: (kg) => kg / 0.028349523, from: (x) => x * 0.028349523, d: 2 } : { u: "g", to: (kg) => kg * 1000, from: (x) => x / 1000, d: 1 },
    len: imp ? { u: "in", to: (m) => m / 0.0254, from: (x) => x * 0.0254, d: 2 } : { u: "mm", to: (m) => m * 1000, from: (x) => x / 1000, d: 1 },
    alt: imp ? { u: "ft", to: (m) => m / 0.3048, from: (x) => x * 0.3048, d: 0 } : { u: "m", to: id, from: id, d: 1 },
    wind: imp ? { u: "mph", to: (v) => v / 0.44704, from: (x) => x * 0.44704, d: 1 } : { u: "m/s", to: id, from: id, d: 1 },
    temp: imp ? { u: "°F", to: (c) => c * 1.8 + 32, from: (f) => (f - 32) / 1.8, d: 0 } : { u: "°C", to: id, from: id, d: 1 },
  };
}
const round = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : "");
const RAIL_MIN = 15.24; // 50 ft/s, the usual minimum speed off the rail

export const KINDS = [["drogue", "Drogue"], ["main", "Main parachute"], ["chute", "Parachute (single deploy)"], ["streamer", "Streamer"]];
export const DEPLOY_RULES = [["apogee", "At apogee"], ["altitude", "At an altitude on the way down"], ["timer", "At a time after liftoff"], ["motor", "By the motor's ejection charge"], ["never", "Never (not fitted)"]];
const IGNITION = [["commanded", "Lit by the flight computer"], ["direct", "Lit straight from the stage below"], ["never", "Never lit (coasts)"]];
const SEPARATION = [["burnout", "Falls away when its motor burns out"], ["commanded", "Separated by the flight computer"]];
const SHAPES = [["neutral", "Flat (most composite motors)"], ["regressive", "Starts strong, tails off"], ["progressive", "Builds up"], ["blackpowder", "Black powder spike"]];

export class RocketEditor {
  constructor(el, { store, units, onChange }) {
    this.el = el;
    this.store = store;
    this.system = units;
    this.onChange = onChange || (() => {});
    this.save = debounce(() => saveRockets(host, this.store).catch((e) => toast("Couldn't save the rocket profiles: " + e.message, "fault")), 400);
    this.previewSoon = debounce(() => this.preview(), 250);
    this.charts = [];
  }

  get rocket() { return this.store.rockets.find((r) => r.id === this.store.selected) || this.store.rockets[0]; }
  setUnits(system) { this.system = system; }

  changed(structural = false) {
    this.save();
    this.onChange(this.rocket, structural);
    if (structural) this.render(); else this.previewSoon();
  }

  num(label, obj, key, conv, opts = {}) {
    const val = conv ? round(conv.to(obj[key] ?? 0), conv.d) : obj[key];
    return numField(label, val, conv ? conv.u : opts.unit, (v) => {
      if (v === null) return;
      if (opts.min !== undefined && v < opts.min) { toast(`${label} must be at least ${opts.min}.`, "fault"); return; }
      obj[key] = conv ? conv.from(v) : v;
      this.changed(opts.structural);
    }, { step: "any", title: opts.title, min: opts.min });
  }

  // ------------------------------------------------------------ layout
  render() {
    for (const c of this.charts) c.destroy();
    this.charts = [];
    const r = this.rocket, U = editUnits(this.system);
    clear(this.el);
    const sel = selectField("Rocket profile", r.id, this.store.rockets.map((x) => [x.id, x.name]), (v) => { this.store.selected = v; this.save(); this.onChange(this.rocket, true); this.render(); });
    sel.classList.add("rk-select");
    const bar = h("div", { class: "rk-bar" }, sel,
      h("button", { class: "btn", onclick: () => this.addRocket() }, "New"),
      h("button", { class: "btn", onclick: () => this.duplicate() }, "Duplicate"),
      h("button", { class: "btn", onclick: () => this.importRocket() }, "Import…"),
      h("button", { class: "btn", onclick: () => download(`${safeName(r.name) || "rocket"}.rocket.json`, JSON.stringify(r, null, 2), "application/json") }, "Export…"),
      h("button", { class: "btn danger", disabled: this.store.rockets.length < 2, onclick: () => this.remove() }, "Delete"),
      h("div", { class: "spacer" }),
      h("span", { class: "note" }, "Shared with Heron and Owl. Changes save automatically."));
    const form = h("div", { class: "rk-form" }, this.basics(r), this.stagesSection(r, U), this.recoverySection(r, U), this.siteSection(U));
    this.prevEl = h("div", { class: "rk-preview" });
    this.el.append(bar, h("div", { class: "rk-cols" }, form, this.prevEl));
    this.preview();
  }

  basics(r) {
    return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Rocket")),
      h("div", { class: "panel-body" },
        h("div", { class: "grid-form two" },
          textField("Name", r.name, (v) => { r.name = v.trim() || "Rocket"; this.changed(true); }),
          textField("Notes", r.notes, (v) => { r.notes = v; this.changed(); }, { placeholder: "Anything worth remembering" }))));
  }

  // ------------------------------------------------------------ stages
  stagesSection(r, U) {
    const body = h("div", { class: "panel-body col", style: { gap: "12px" } });
    r.stages.forEach((s, k) => body.append(this.stageCard(r, s, k, U)));
    body.append(h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => { const st = newStage(r.stages.length); st.diameter = r.stages[r.stages.length - 1].diameter; if (r.stages.length === 1 && /^(rocket|airframe|stage 1)$/i.test(r.stages[0].name)) r.stages[0].name = "Booster"; r.stages.push(st); this.changed(true); } }, "Add a stage on top"),
      h("span", { class: "note" }, "Stage 1 is the bottom stage, lit on the pad.")));
    return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, r.stages.length > 1 ? `Stages (${r.stages.length})` : "Body and motor"),
      h("span", { class: "hint" }, "Masses are without the motor")), body);
  }

  stageCard(r, s, k, U) {
    const last = r.stages.length - 1;
    const multi = r.stages.length > 1;
    const head = h("div", { class: "rk-card-head" },
      h("b", null, multi ? `Stage ${k + 1}` : "Airframe"),
      multi ? h("span", { class: "muted" }, k === 0 ? "bottom, lit on the pad" : k === last ? "top" : "middle") : null,
      h("div", { class: "spacer" }),
      multi ? h("button", { class: "btn small ghost", title: "Remove this stage", onclick: async () => { if (await confirmBox("Remove stage", `Remove ${s.name}?`, "Remove", "danger")) { r.stages.splice(k, 1); this.changed(true); } } }, "Remove") : null);
    const grid = h("div", { class: "grid-form" },
      multi ? textField("Name", s.name, (v) => { s.name = v || `Stage ${k + 1}`; this.changed(true); }) : null,
      this.num("Dry mass", s, "dryMass", U.mass, { min: 0.001, title: "Everything in this stage except the motor" }),
      this.num("Body diameter", s, "diameter", U.len, { min: 0.001 }),
      this.num("Drag coefficient (Cd)", s, "cd", null, { min: 0.05, title: multi ? "Cd of the whole stack while this is the bottom stage. Heron can measure it from a real flight." : "Typical model rockets are 0.4 to 0.6. Heron can measure it from a real flight." }),
      this.num("Motors in this stage", s, "motorCount", null, { min: 1, structural: true, title: "More than 1 for a cluster of identical motors" }));
    const opts = h("div", { class: "grid-form" });
    if (k > 0) {
      opts.append(selectField("Ignition", s.ignition, IGNITION, (v) => { s.ignition = v; this.changed(true); }));
      if (s.ignition === "commanded") opts.append(this.num("Light it this long after the stage below burns out", s, "ignitionDelay", null, { unit: "s", min: 0 }));
    }
    if (k < last) opts.append(selectField("Separation", s.separation, SEPARATION, (v) => { s.separation = v; this.changed(true); }));
    return h("div", { class: "rk-card" }, head, grid, opts.childElementCount ? opts : null, this.motorBox(s));
  }

  motorBox(s) {
    const m = s.motor;
    const curve = h("div", { class: "rk-curve" });
    const info = m
      ? h("div", { class: "rk-motor-info" },
          h("div", { class: "rk-motor-name" }, `${s.motorCount > 1 ? s.motorCount + " × " : ""}${m.name}`, h("span", { class: "badge" }, `${impulseClass(m.totalImpulse)} class`)),
          h("div", { class: "muted" }, `${fmt(m.totalImpulse, 1)} N·s, ${fmt(m.avgThrust, 0)} N average, ${fmt(m.peakThrust, 0)} N peak, ${fmt(m.burnTime, 2)} s burn`),
          h("div", { class: "muted" }, `${m.manufacturer ? m.manufacturer + ", " : ""}${fmt(m.totalMass * 1000, 0)} g loaded, ${fmt(m.propMass * 1000, 0)} g propellant`),
          m.source === "quick" ? h("div", { class: "note", style: { marginTop: "4px" } }, "Approximate thrust curve. Load the real .eng file from thrustcurve.org for accurate results.") : null)
      : h("div", { class: "muted" }, "No motor");
    const box = h("div", { class: "rk-motor" }, curve,
      h("div", { class: "col", style: { gap: "8px", minWidth: 0 } }, info,
        h("div", { class: "row wrap", style: { gap: "6px" } },
          h("button", { class: "btn small", onclick: () => this.loadMotorFile(s) }, "Load .eng / .rse…"),
          h("button", { class: "btn small", onclick: () => this.fromLibrary(s) }, "From Motors folder…"),
          h("button", { class: "btn small", onclick: () => this.quickMotorDialog(s) }, "Quick motor…"))));
    if (m && m.t?.length) setTimeout(() => {
      const c = new TimeChart(curve, { legend: false, padTop: 8, padBottom: 22, xLabel: "", yLabel: "N", yIncludeZero: true, tooltip: true, xFormat: (x) => `${x.toFixed(2)} s` });
      c.addSeries({ id: "f", label: "Thrust", color: "--d-aux2", x: m.t, y: m.f, unit: "N", digits: 0, width: 1.75 });
      this.charts.push(c);
    }, 0);
    return box;
  }

  setMotor(s, motor) {
    s.motor = motorToJSON(motor);
    this.changed(true);
    toast(`Motor set to ${motor.name}`, "go");
  }

  async chooseMotor(list, s) {
    if (list.length === 1) return this.setMotor(s, list[0]);
    const body = h("div", { class: "col" }, h("p", { class: "note", style: { margin: 0 } }, "This file has several motors. Pick one:"),
      ...list.map((mo) => h("button", { class: "btn", style: { justifyContent: "flex-start" }, onclick: () => { this.setMotor(s, mo); dlg.close(); } }, `${mo.name} — ${mo.manufacturer || "unknown maker"}, ${fmt(mo.totalImpulse, 1)} N·s, delays ${mo.delays || "–"}`)));
    const dlg = modal({ title: "Choose a motor", body });
  }

  async loadMotorFile(s) {
    const f = await pickFile(".eng,.rse,.txt,.xml");
    if (!f) return;
    try {
      const text = await readFileText(f);
      const list = parseMotorFile(f.name, text);
      host.write("motors", safeName(f.name) || "motor.eng", text).catch(() => {});
      this.chooseMotor(list, s);
    } catch (e) { toast(`Couldn't read ${f.name}: ${e.message}`, "fault", 8000); }
  }

  async fromLibrary(s) {
    let files = [];
    try { files = (await host.list("motors")).files.filter((x) => !x.dir && /\.(eng|rse|txt|xml)$/i.test(x.name)); } catch { /* */ }
    const body = h("div", { class: "col" });
    if (!files.length) body.append(h("p", { class: "note", style: { margin: 0 } }, "The Motors folder is empty. Motor files you load are copied there, or put .eng and .rse files from thrustcurve.org in Documents\\Aviary\\Motors yourself."));
    for (const f of files) body.append(h("button", { class: "btn", style: { justifyContent: "flex-start" }, onclick: async () => { dlg.close(); try { this.chooseMotor(parseMotorFile(f.name, await host.read("motors", f.path)), s); } catch (e) { toast(e.message, "fault"); } } }, f.path));
    body.append(h("div", { class: "row", style: { marginTop: "6px" } }, h("button", { class: "btn small ghost", onclick: () => host.reveal("motors").catch((e) => toast(e.message, "fault")) }, "Open the Motors folder")));
    const dlg = modal({ title: "Motors folder", body });
  }

  quickMotorDialog(s) {
    const q = { designation: s.motor?.quick?.designation || "G80", totalImpulse: s.motor?.quick?.totalImpulse || "", shape: s.motor?.quick?.shape || "neutral", propMass: "", totalMass: "" };
    const body = h("div", { class: "col", style: { gap: "12px" } },
      h("p", { class: "note", style: { margin: 0 } }, "When you only know the motor's name. The letter sets the impulse class and the number is the average thrust in newtons. Leave impulse blank to use the middle of the class."),
      h("div", { class: "grid-form" },
        textField("Designation", q.designation, (v) => { q.designation = v; }, { placeholder: "e.g. G80" }),
        numField("Total impulse", q.totalImpulse, "N·s", (v) => { q.totalImpulse = v; }),
        selectField("Thrust shape", q.shape, SHAPES, (v) => { q.shape = v; }),
        numField("Propellant mass", q.propMass, "g", (v) => { q.propMass = v; }, { title: "Optional" }),
        numField("Loaded motor mass", q.totalMass, "g", (v) => { q.totalMass = v; }, { title: "Optional" })));
    modal({
      title: "Quick motor", body,
      actions: [{ label: "Cancel" }, { label: "Use this motor", kind: "primary", onClick: () => {
        try {
          const mo = quickMotor({ designation: q.designation, totalImpulse: Number(q.totalImpulse) || undefined, shape: q.shape, propMass: q.propMass ? q.propMass / 1000 : undefined, totalMass: q.totalMass ? q.totalMass / 1000 : undefined, diameter: s.diameter });
          this.setMotor(s, mo);
        } catch (e) { toast(e.message, "fault"); return false; }
      } }],
    });
  }

  // ------------------------------------------------------------ recovery
  recoverySection(r, U) {
    const body = h("div", { class: "panel-body col", style: { gap: "12px" } });
    if (!r.recovery.length) body.append(h("p", { class: "note", style: { margin: 0 } }, "No recovery devices. Add at least one, or the rocket comes in ballistic."));
    r.recovery.forEach((d, i) => body.append(this.deviceCard(r, d, i, U)));
    body.append(h("div", { class: "row wrap" },
      h("button", { class: "btn", onclick: () => { r.recovery.push(newDevice("drogue")); this.changed(true); } }, "Add drogue"),
      h("button", { class: "btn", onclick: () => { r.recovery.push(newDevice("main")); this.changed(true); } }, "Add main"),
      h("button", { class: "btn", onclick: () => { const d = newDevice("main"); Object.assign(d, { name: "Parachute", kind: "chute", deploy: "motor", delay: 5, pyro: 0 }); r.recovery.push(d); this.changed(true); } }, "Add motor-ejected parachute"),
      h("div", { class: "spacer" }),
      this.num("Body Cd while falling", r, "descentBodyCd", null, { min: 0.1, title: "Drag of the tumbling or side-on body after apogee" })));
    return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Recovery"), h("span", { class: "hint" }, "Pyro channel numbers say which output fires each one")), body);
  }

  deviceCard(r, d, i, U) {
    const grid = h("div", { class: "grid-form" },
      textField("Name", d.name, (v) => { d.name = v || "Parachute"; this.changed(true); }),
      selectField("Type", d.kind, KINDS, (v) => { d.kind = v; this.changed(); }),
      this.num(d.kind === "streamer" ? "Size (as a parachute diameter)" : "Diameter", d, "diameter", U.len, { min: 0.01 }),
      this.num("Drag coefficient (Cd)", d, "cd", null, { min: 0.05, title: "Round parachutes are about 0.75 to 0.9" }),
      selectField("Opens", d.deploy, DEPLOY_RULES, (v) => { d.deploy = v; if (v === "motor") d.pyro = 0; else if (!(d.pyro > 0)) d.pyro = Math.max(0, ...r.recovery.map((x) => x.pyro || 0)) + 1; this.changed(true); }));
    if (d.deploy === "apogee") grid.append(this.num("Delay after apogee", d, "delay", null, { unit: "s", min: 0 }));
    if (d.deploy === "motor") grid.append(this.num("Motor delay after burnout", d, "delay", null, { unit: "s", min: 0, title: "The number after the dash in the motor name, e.g. G80-7 is 7 s" }));
    if (d.deploy === "altitude") grid.append(this.num("Altitude", d, "altitude", U.alt, { min: 0 }));
    if (d.deploy === "timer") grid.append(this.num("Time after liftoff", d, "time", null, { unit: "s", min: 0 }));
    grid.append(this.num("Opening time", d, "inflation", null, { unit: "s", min: 0.05, title: "How long it takes to fill" }));
    if (d.deploy !== "motor" && d.deploy !== "never") grid.append(this.num("Pyro channel", d, "pyro", null, { min: 0, structural: true, title: "Which flight computer output fires it (0 = none)" }));
    const head = h("div", { class: "rk-card-head" }, h("b", null, d.name), h("span", { class: "muted" }, KINDS.find((k) => k[0] === d.kind)?.[1] || ""), h("div", { class: "spacer" }),
      h("button", { class: "btn small ghost", onclick: () => { r.recovery.splice(i, 1); this.changed(true); } }, "Remove"));
    return h("div", { class: "rk-card" }, head, grid);
  }

  // ------------------------------------------------------------ site
  siteSection(U) {
    const s = this.store.site;
    return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Launch site"), h("span", { class: "hint" }, "Used for every rocket")),
      h("div", { class: "panel-body" }, h("div", { class: "grid-form" },
        textField("Name", s.name, (v) => { s.name = v; this.changed(); }),
        this.num("Elevation above sea level", s, "elevation", U.alt),
        this.num("Temperature", s, "tempC", U.temp),
        this.num("Wind speed", s, "windSpeed", U.wind, { min: 0 }),
        this.num("Wind from", s, "windDir", null, { unit: "°", title: "Compass direction the wind blows from (270 = from the west)" }),
        this.num("Launch rail length", s, "railLength", U.alt, { min: 0 }),
        this.num("Latitude", s, "lat", null, { unit: "°", title: "For simulated GPS" }),
        this.num("Longitude", s, "lon", null, { unit: "°" }))));
  }

  // ------------------------------------------------------------ preview
  preview() {
    const el = this.prevEl;
    if (!el) return;
    for (const c of this.charts.filter((c) => c.el.closest(".rk-preview"))) c.destroy();
    this.charts = this.charts.filter((c) => !c.el.closest(".rk-preview"));
    clear(el);
    const r = this.rocket, D = display(this.system), U = editUnits(this.system);
    let out;
    try { out = simulate(r, this.store.site, { rate: 50 }); }
    catch (e) { el.append(h("div", { class: "panel" }, h("div", { class: "panel-body" }, h("p", { class: "note" }, "Can't simulate this rocket yet: " + e.message)))); return; }
    const s = out.summary;
    const descent = descentRates(out);
    const cell = (k, v, u, cls = "") => h("div", { class: "stat " + cls }, h("div", { class: "k" }, k), h("div", { class: "v" }, v, u ? h("small", null, u) : ""));
    const stats = h("div", { class: "rk-stats" },
      cell("Apogee", D.fmtAlt(s.apogee), D.altUnit),
      cell("Time to apogee", fmt(s.apogeeTime, 1), "s"),
      cell("Top speed", D.fmtVel(s.maxVelocity), D.velUnit),
      cell("Top Mach", fmt(s.maxMach, 2), ""),
      cell("Peak acceleration", fmt(s.maxAccel / G0, 1), "g"),
      cell("Off the rail at", D.fmtVel(s.railExitVelocity), D.velUnit, s.railExitVelocity !== null && s.railExitVelocity < RAIL_MIN ? "warn" : ""),
      cell("Liftoff mass", fmt(U.mass.to(liftoffMass(r)), U.mass.d > 1 ? 1 : 0), U.mass.u),
      ...descent.map((d) => cell(`Under ${d.name}`, D.fmtVel(d.rate), D.velUnit)),
      cell("Landing speed", D.fmtVel(s.landingVelocity), D.velUnit, s.landingVelocity > 7.6 ? "warn" : ""),
      cell("Flight time", fmt(s.flightTime, 0), "s"),
      cell("Drift", D.fmtDist(s.drift), ""));
    const warn = this.warnings(r, out, D);
    const chartBox = h("div", { class: "rk-chart" });
    const velBox = h("div", { class: "rk-chart small" });
    el.append(h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, "Prediction"), h("span", { class: "hint" }, `Ideal flight at ${this.store.site.name || "the launch site"}, ${fmt(U.wind.to(this.store.site.windSpeed || 0), 0)} ${U.wind.u} wind`)),
      h("div", { class: "panel-body flush" }, stats,
        warn.length ? h("ul", { class: "rk-warn" }, warn.map(([k, t]) => h("li", { class: k }, t))) : h("p", { class: "rk-ok" }, "No problems spotted."),
        chartBox, velBox)));
    setTimeout(() => {
      const g = new ChartGroup();
      const lift = out.events.find((e) => e.type === "liftoff")?.t ?? 0;
      const x = out.series.t.map((t) => t - lift);
      const c1 = new TimeChart(chartBox, { group: g, yLabel: `Altitude (${D.altUnit})`, xLabel: "Time from liftoff (s)", yIncludeZero: true });
      c1.addSeries({ id: "h", label: "Altitude", color: "--d-alt", x, y: out.series.h.map(D.alt), unit: D.altUnit, digits: 0, width: 2 });
      const c2 = new TimeChart(velBox, { group: g, yLabel: `Speed (${D.velUnit})`, xLabel: "", yIncludeZero: true });
      c2.addSeries({ id: "v", label: "Vertical speed", color: "--d-vel", x, y: out.series.v.map(D.vel), unit: D.velUnit, digits: 0 });
      const marks = out.events.filter((e) => ["burnout", "apogee", "deploy", "separation", "ignition"].includes(e.type) && !(e.type === "ignition" && e.stage === 0))
        .map((e) => ({ x: e.t - lift, label: e.type === "apogee" ? `Apogee ${D.fmtAlt(e.h)} ${D.altUnit}` : e.label, color: e.type === "deploy" || e.type === "apogee" ? "--orange" : "--graphite", textColor: e.type === "deploy" || e.type === "apogee" ? undefined : "--graphite" }));
      c1.setMarkers(marks);
      c2.setMarkers(marks.map((m) => ({ ...m, label: "" })));
      this.charts.push(c1, c2);
    }, 0);
  }

  warnings(r, out, D) {
    const s = out.summary, sim = out.sim, W = [];
    if (sim.liftoff === null) { W.push(["bad", "It never leaves the pad: the motor's thrust is less than the rocket's weight."]); return W; }
    const st0 = r.stages[0];
    if (st0.motor) {
      const tw = (st0.motor.avgThrust * (st0.motorCount || 1)) / (liftoffMass(r) * G0);
      if (tw < 3) W.push(["bad", `Thrust-to-weight is only ${fmt(tw, 1)} to 1. Below 3 to 1 the rocket leaves the rail too slowly to fly straight.`]);
      else if (tw < 5) W.push(["warn", `Thrust-to-weight is ${fmt(tw, 1)} to 1. 5 to 1 or more is the usual rule of thumb.`]);
    }
    if (s.railExitVelocity !== null && s.railExitVelocity < RAIL_MIN) W.push(["warn", `Leaves the rail at ${D.fmtVel(s.railExitVelocity)} ${D.velUnit}. Aim for at least ${D.system === "imperial" ? "50 ft/s" : "15 m/s"}: use a longer rail or more thrust.`]);
    if (!r.recovery.some((d) => d.deploy !== "never")) W.push(["bad", `No recovery device: it would hit the ground at ${D.fmtVel(s.landingVelocity)} ${D.velUnit}.`]);
    for (const dep of s.deployments) {
      const d = r.recovery.find((x) => x.id === dep.id);
      if (!d) continue;
      if (dep.v > 5) W.push(["warn", `${d.name} opens while still climbing at ${D.fmtVel(dep.v)} ${D.velUnit}${d.deploy === "motor" ? ": the motor delay is too short" : ""}.`]);
      else if (dep.v < -20 && d.kind !== "main") W.push(["warn", `${d.name} opens at ${D.fmtVel(-dep.v)} ${D.velUnit} on the way down, which risks a zipper or a torn parachute${d.deploy === "motor" ? ": the motor delay is too long" : ""}.`]);
      else if (dep.v < -45) W.push(["warn", `${d.name} opens at ${D.fmtVel(-dep.v)} ${D.velUnit}. That's a hard opening; a drogue would slow it first.`]);
    }
    if (s.landingVelocity > 7.6) W.push(["warn", `Lands at ${D.fmtVel(s.landingVelocity)} ${D.velUnit}. Under ${D.fmtVel(7.6)} ${D.velUnit} is the usual target; try a bigger parachute.`]);
    const main = r.recovery.find((d) => d.deploy === "altitude");
    if (main && s.apogee < main.altitude) W.push(["info", `Apogee is below ${main.name}'s deployment altitude, so it opens right after apogee.`]);
    r.stages.forEach((st, k) => { if (st.motor?.source === "quick") W.push(["info", `${r.stages.length > 1 ? st.name : "The motor"} uses an approximate thrust curve.`]); });
    r.stages.forEach((st, k) => { if (k > 0 && sim.ign[k] === null && st.ignition !== "never") W.push(["warn", `${st.name} never lit in the simulation.`]); });
    if (s.drift > 800) W.push(["info", `Drifts ${D.fmtDist(s.drift)} in this wind.`]);
    return W;
  }

  // ------------------------------------------------------------ list actions
  addRocket() {
    const r = { id: uid(), name: "New rocket", notes: "", stages: [{ ...newStage(0), name: "Rocket" }], recovery: [newDevice("drogue"), newDevice("main")], descentBodyCd: 0.8 };
    this.store.rockets.push(r); this.store.selected = r.id; this.changed(true);
  }
  duplicate() {
    const r = structuredClone(this.rocket); r.id = uid(); r.name = r.name.replace(/^Example:\s*/, "") + " (copy)";
    this.store.rockets.push(r); this.store.selected = r.id; this.changed(true);
  }
  async remove() {
    const r = this.rocket;
    if (this.store.rockets.length < 2) return;
    if (!(await confirmBox("Delete rocket", `Delete ${r.name}? Heron and Owl use the same list.`, "Delete", "danger"))) return;
    this.store.rockets = this.store.rockets.filter((x) => x.id !== r.id);
    this.store.selected = this.store.rockets[0].id; this.changed(true);
  }
  async importRocket() {
    const f = await pickFile(".json");
    if (!f) return;
    try {
      const r = JSON.parse(await readFileText(f));
      if (!Array.isArray(r.stages) || !r.stages.length) throw new Error("This isn't a rocket profile exported from Aviary.");
      if (this.store.rockets.some((x) => x.id === r.id)) r.id = uid();
      r.recovery ||= []; r.descentBodyCd ??= 0.8;
      this.store.rockets.push(r); this.store.selected = r.id; this.changed(true);
      toast(`Imported ${r.name}`, "go");
    } catch (e) { toast(`Couldn't import ${f.name}: ${e.message}`, "fault", 8000); }
  }
}

// Steady descent rate under each recovery device, from a simulated flight.
export function descentRates(out) {
  const sim = out.sim, S = out.series, res = [];
  const deps = sim.events.filter((e) => e.type === "deploy").sort((a, b) => a.t - b.t);
  const end = sim.landed ? sim.landed.t : S.t[S.t.length - 1];
  deps.forEach((d, i) => {
    const t1 = i + 1 < deps.length ? deps[i + 1].t : end;
    const t0 = d.t + 0.7 * (t1 - d.t);
    const vs = [];
    for (let j = 0; j < S.t.length; j++) if (S.t[j] >= t0 && S.t[j] <= t1 - 0.05 && S.v[j] < 0) vs.push(-S.v[j]);
    if (vs.length) { vs.sort((a, b) => a - b); res.push({ id: d.id, name: sim.r.recovery.find((x) => x.id === d.id)?.name || d.id, rate: vs[vs.length >> 1] }); }
  });
  return res;
}

export { PHASE_LABEL };
