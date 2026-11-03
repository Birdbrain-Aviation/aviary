// Mockingbird's "Flight computer" tab (what is sent, sensor model, pyro
// channels, firmware messages, pass/fail limits) and the test editor.
import { h, clear, toast, modal, numField, textField, selectField, checkField, seg, confirmBox } from "/shared/js/ui.js";
import { fmt, G0 } from "/shared/js/units.js";
import { HILRun, FIELDS, DEFAULT_FIELDS, DEFAULT_TOL, defaultPyro, FAULT_TYPES, FAULT_REFS, SENSORS, newFault, describeFault } from "/shared/js/hil.js";
import { BAUDS } from "/shared/js/serial.js";

export const FIELD_GROUPS = [
  ["Time", ["t_ms"]],
  ["Barometer", ["p_pa", "temp_c"]],
  ["Accelerometer in g", ["ax_g", "ay_g", "az_g"]],
  ["Accelerometer in m/s²", ["ax", "ay", "az"]],
  ["Gyro", ["gx", "gy", "gz"]],
  ["GPS", ["lat", "lon", "gps_alt", "sats"]],
  ["Truth, for debugging only", ["alt_m", "vz"]],
];
export const AXES = [["z,1", "+Z points to the nose"], ["z,-1", "−Z points to the nose"], ["x,1", "+X points to the nose"], ["x,-1", "−X points to the nose"], ["y,1", "+Y points to the nose"], ["y,-1", "−Y points to the nose"]];

// ---- actions a pyro channel or a firmware message can trigger ----
export function actionOptions(rocket) {
  const o = [["", "Nothing"]];
  for (const d of rocket.recovery || []) if (d.deploy !== "motor") o.push([`deploy:${d.id}`, `Deploy ${d.name}`]);
  rocket.stages.forEach((s, k) => { if (k > 0) o.push([`ignite:${k}`, `Light ${s.name}`]); });
  rocket.stages.forEach((s, k) => { if (k < rocket.stages.length - 1) o.push([`separate:${k}`, `Separate ${s.name}`]); });
  return o;
}
export const encodeAction = (a) => (!a ? "" : a.type === "deploy" ? `deploy:${a.id}` : `${a.type}:${a.stage}`);
export const decodeAction = (v) => { if (!v) return null; const [type, x] = v.split(":"); return type === "deploy" ? { type, id: x } : { type, stage: Number(x) }; };

// The pyro table in use for a rocket: saved edits, else the rocket's own channel numbers.
export function pyroFor(set, rocket) {
  const saved = set.pyro[rocket.id];
  if (Array.isArray(saved) && saved.length) {
    const valid = new Set(actionOptions(rocket).map((o) => o[0]));
    return saved.map((p) => ({ ch: Number(p.ch), action: valid.has(encodeAction(p.action)) ? p.action : null })).filter((p) => p.ch > 0);
  }
  return defaultPyro(rocket);
}

// Example of what goes down the wire with the current settings.
function previewLines(set, rocket, site) {
  const lines = [];
  try {
    const run = new HILRun({ rocket, site, cfg: { ...set.run, padTime: 5, pyro: [] }, faults: [], send: (l) => lines.push(l), seed: 7 });
    run.start();
    run.advanceTo(3 / set.run.rate + 1e-6);
  } catch (e) { return { lines: ["(" + e.message + ")"], avg: 60 }; }
  const samples = lines.filter((l) => !/^\$MB[CH],/.test(l));
  const avg = samples.reduce((a, l) => a + l.length + 1, 0) / Math.max(1, samples.length);
  return { lines, avg };
}

export function renderSetup(el, ctx) {
  const { set, D } = ctx;
  const rocket = ctx.rocket();
  const save = () => { set.save(); ctx.onChange && ctx.onChange(); };
  clear(el);

  // ---------------------------------------------------------- what is sent
  const sendBody = h("div", { class: "panel-body col", style: { gap: "12px" } });
  const drawSend = () => {
    clear(sendBody);
    const virtual = ctx.linkType() === "virtual";
    sendBody.append(h("div", { class: "row wrap" },
      seg([["mb", "Mockingbird protocol"], ["custom", "My own line format"]], set.run.protocol, (v) => { set.run.protocol = v; save(); drawSend(); }),
      h("span", { class: "note" }, set.run.protocol === "mb" ? "Recommended. The Arduino library reads it for you." : "For firmware that already reads a replay format.")));
    if (set.run.protocol === "custom" && virtual) sendBody.append(h("p", { class: "safety", style: { margin: 0 } }, "The virtual flight computer only understands the Mockingbird protocol, so it is used while the virtual flight computer is connected."));
    if (set.run.protocol === "mb") {
      const box = h("div", { class: "field-groups" });
      for (const [g, keys] of FIELD_GROUPS) {
        box.append(h("div", { class: "fg" }, h("div", { class: "fg-t" }, g), h("div", { class: "chips" }, keys.map((k) => checkField(h("span", null, h("code", null, k), " ", h("span", { class: "muted" }, FIELDS[k].label.replace(/\s*\(.*\)$/, ""))), set.run.fields.includes(k), (on) => {
          const cur = new Set(set.run.fields);
          on ? cur.add(k) : cur.delete(k);
          set.run.fields = Object.keys(FIELDS).filter((x) => cur.has(x));
          if (!set.run.fields.length) set.run.fields = ["t_ms"];
          save(); drawPreview();
        })))));
      }
      sendBody.append(h("div", null, h("div", { class: "sub-title" }, "Fields in each sample"), box,
        h("p", { class: "note", style: { marginBottom: 0 } }, "Names go out in a $MBH header line, so the order doesn't matter and your firmware can ignore fields it doesn't use.")));
    } else {
      const tpl = h("input", { type: "text", class: "mono", value: set.run.template, style: { width: "100%" }, "aria-label": "Line template", onchange: () => { set.run.template = tpl.value; save(); drawPreview(); } });
      const insert = (k) => { const s = tpl.selectionStart ?? tpl.value.length; tpl.value = tpl.value.slice(0, s) + `{${k}}` + tpl.value.slice(tpl.selectionEnd ?? s); set.run.template = tpl.value; save(); drawPreview(); tpl.focus(); };
      sendBody.append(h("div", null, h("div", { class: "sub-title" }, "Line template"), tpl,
        h("div", { class: "chips", style: { marginTop: "8px" } }, Object.keys(FIELDS).map((k) => h("button", { class: "btn small", title: FIELDS[k].label, onclick: () => insert(k) }, `{${k}}`))),
        h("div", { style: { marginTop: "8px" } }, checkField("Add a checksum (*HH, NMEA style)", set.run.templateCS, (v) => { set.run.templateCS = v; save(); drawPreview(); }))));
    }
    sendBody.append(h("div", { class: "grid-form" },
      selectField("Samples per second", set.run.rate, [10, 20, 25, 50, 100, 200].map((r) => [r, `${r} per second`]), (v) => { set.run.rate = Number(v); save(); drawPreview(); }),
      selectField("Baud rate", set.link.baud, BAUDS.map((b) => [b, String(b)]), (v) => { set.link.baud = Number(v); save(); drawPreview(); }, { title: "Must match Serial.begin() in your firmware. Applies the next time you connect." })));
    const prevBox = h("div");
    sendBody.append(prevBox);
    const drawPreview = () => {
      clear(prevBox);
      const { lines, avg } = previewLines(set, rocket, ctx.site());
      const rate = set.run.rate * Math.max(1, set.run.speed || 1);
      const need = avg * rate, cap = set.link.baud / 10;
      const pct = need / cap;
      prevBox.append(h("div", { class: "sub-title" }, "What the first lines look like"), h("div", { class: "preview-lines" }, lines.slice(0, 6).join("\n")),
        h("p", { class: pct > 0.7 ? "safety" : "note", style: { marginBottom: 0 } }, `About ${fmt(need / 1000, 1)} kB/s at ${set.run.speed > 1 ? set.run.speed + "× speed" : "real time"}, ${fmt(pct * 100, 0)}% of what ${set.link.baud} baud can carry.${pct > 0.7 ? " That's too close: lower the sample rate, drop fields, or raise the baud rate." : ""}`));
    };
    drawPreview();
  };
  drawSend();

  // ---------------------------------------------------------- sensors + timing
  const N = set.run.noise;
  const sensors = h("div", { class: "panel-body col", style: { gap: "12px" } },
    h("div", { class: "grid-form" },
      selectField("Accelerometer orientation", `${set.run.axis.up},${set.run.axis.sign}`, AXES, (v) => { const [a, s] = v.split(","); set.run.axis = { up: a, sign: Number(s) }; save(); }, { title: "Which axis of your accelerometer points toward the nose cone" }),
      numField("Barometer noise", N.baro, "Pa", (v) => { N.baro = Math.max(0, v ?? 0); save(); }, { title: "Standard deviation. 2 Pa is about 17 cm, typical for an MS5611 or BMP390." }),
      numField("Accelerometer noise", +(N.accel / G0).toFixed(4), "g", (v) => { N.accel = Math.max(0, (v ?? 0) * G0); save(); }),
      numField("Gyro noise", N.gyro, "°/s", (v) => { N.gyro = Math.max(0, v ?? 0); save(); })),
    h("p", { class: "note", style: { margin: 0 } }, "On the pad the nose axis reads +1 g, like a real accelerometer. During coast it reads slightly negative (drag), and about zero in free fall."),
    h("div", { class: "grid-form" },
      numField("Time on the pad before launch", set.run.padTime, "s", (v) => { set.run.padTime = Math.max(1, v ?? 10); save(); }, { title: "Lets the flight computer settle and zero its barometer. Tests can override it." }),
      selectField("Speed with your board", set.run.speed, [[1, "Real time"], [2, "2× faster"], [4, "4× faster"]], (v) => { set.run.speed = Number(v); save(); drawSend(); }),
      selectField("Speed with the virtual board", set.run.vfcSpeed, [[1, "Real time"], [5, "5× faster"], [20, "20× faster"], [0, "As fast as possible"]], (v) => { set.run.vfcSpeed = Number(v); save(); })),
    h("p", { class: "note", style: { margin: 0 } }, "Faster than real time only works if your firmware times things with the sample time (hil.millis() in the library) instead of millis()."));

  // ---------------------------------------------------------- pyro channels
  const pyroBody = h("div", { class: "panel-body col", style: { gap: "10px" } });
  const drawPyro = () => {
    clear(pyroBody);
    const rows = pyroFor(set, rocket);
    const opts = actionOptions(rocket);
    const commit = () => { set.pyro[rocket.id] = rows.map((r) => ({ ch: r.ch, action: r.action })); save(); };
    const tb = h("tbody");
    rows.forEach((r, i) => {
      const chIn = h("input", { type: "number", min: 1, step: 1, value: r.ch, style: { width: "70px" }, "aria-label": "Channel number", onchange: () => { r.ch = Math.max(1, Math.round(Number(chIn.value) || 1)); commit(); } });
      const sel = h("select", { "aria-label": `Channel ${r.ch} action`, onchange: () => { r.action = decodeAction(sel.value); commit(); } }, opts.map(([v, t]) => h("option", { value: v, selected: v === encodeAction(r.action) }, t)));
      tb.append(h("tr", null, h("td", null, chIn), h("td", null, sel), h("td", { class: "r" }, h("button", { class: "btn small ghost", onclick: () => { rows.splice(i, 1); commit(); drawPyro(); } }, "Remove"))));
    });
    pyroBody.append(
      h("p", { class: "note", style: { margin: 0 } }, h("span", null, "When your firmware sends "), h("code", null, "$MBE,PYRO,2"), h("span", null, ", Mockingbird does whatever channel 2 is wired to in the simulation.")),
      rows.length ? h("table", { class: "data" }, h("thead", null, h("tr", null, h("th", null, "Channel"), h("th", null, "Wired to"), h("th", null, ""))), tb) : h("p", { class: "note" }, "No channels."),
      h("div", { class: "row" },
        h("button", { class: "btn small", onclick: () => { rows.push({ ch: Math.max(0, ...rows.map((r) => r.ch)) + 1, action: null }); commit(); drawPyro(); } }, "Add channel"),
        h("button", { class: "btn small ghost", onclick: () => { delete set.pyro[rocket.id]; save(); drawPyro(); } }, "Match the rocket profile")));
  };
  drawPyro();

  // ---------------------------------------------------------- firmware messages
  const rulesBody = h("div", { class: "panel-body col", style: { gap: "10px" } });
  const drawRules = () => {
    clear(rulesBody);
    const rules = set.run.rules;
    const opts = actionOptions(rocket).slice(1);
    const tb = h("tbody");
    rules.forEach((r, i) => {
      const pat = h("input", { type: "text", class: "mono", value: r.pattern, placeholder: "e.g. DROGUE FIRED", "aria-label": "Text to look for", style: { width: "100%" }, onchange: () => { r.pattern = pat.value; save(); } });
      const sel = h("select", { "aria-label": "Action", onchange: () => { r.action = decodeAction(sel.value); save(); } }, opts.map(([v, t]) => h("option", { value: v, selected: v === encodeAction(r.action) }, t)));
      tb.append(h("tr", null, h("td", { style: { width: "50%" } }, pat), h("td", null, checkField("Regex", r.regex, (v) => { r.regex = v; save(); })), h("td", null, sel), h("td", { class: "r" }, h("button", { class: "btn small ghost", onclick: () => { rules.splice(i, 1); save(); drawRules(); } }, "Remove"))));
    });
    rulesBody.append(...[
      h("p", { class: "note", style: { margin: 0 } }, "If your firmware prints its own messages instead of the library's event lines, tell Mockingbird what they mean. Matching ignores upper and lower case."),
      rules.length ? h("table", { class: "data" }, h("thead", null, h("tr", null, h("th", null, "When a line contains"), h("th", null, ""), h("th", null, "Treat it as"), h("th", null, ""))), tb) : null,
      h("div", null, h("button", { class: "btn small", onclick: () => { rules.push({ pattern: "", regex: false, action: decodeAction(opts[0]?.[0]) }); save(); drawRules(); } }, "Add a message"))].filter(Boolean));
  };
  drawRules();

  // ---------------------------------------------------------- tolerances
  const T = set.run.tol;
  const num = (label, key, unit, conv, title) => numField(label, conv ? +conv.to(T[key]).toFixed(1) : T[key], unit, (v) => { if (v === null) return; T[key] = conv ? conv.from(v) : v; save(); }, { title });
  const altConv = { to: (m) => D.alt(m), from: (x) => D.fromAlt(x) };
  const velConv = { to: (v) => D.vel(v), from: (x) => D.fromVel(x) };
  const pctConv = { to: (f) => f * 100, from: (x) => x / 100 };
  const tolBody = h("div", { class: "panel-body col", style: { gap: "10px" } },
    h("div", { class: "grid-form" },
      num("Apogee: early by", "apogeeEarly", "s", null, "How early an apogee deployment may fire"),
      num("Apogee: late by", "apogeeLate", "s", null, "How late an apogee deployment may fire"),
      num("Altitude: off by", "altitudeFrac", "%", pctConv, "Of the target altitude, for altitude deployments"),
      num("…or at least", "altitudeMin", D.altUnit, altConv, "Altitude deployments may always be this far off"),
      num("Timer: off by", "timer", "s", null, "For timer deployments"),
      num("Ignition: early by", "igniteEarly", "s", null, "For upper-stage ignition"),
      num("Ignition: late by", "igniteLate", "s", null, "For upper-stage ignition"),
      num("Safe landing speed", "safeLanding", D.velUnit, velConv)),
    h("div", null, h("button", { class: "btn small ghost", onclick: () => { set.run.tol = { ...DEFAULT_TOL }; save(); renderSetup(el, ctx); } }, "Restore the usual limits")));

  // ---------------------------------------------------------- library help
  const snippet = `#include <MockingbirdHIL.h>

MockingbirdHIL hil(Serial);          // any Serial port

void setup() {
  Serial.begin(${set.link.baud});
  hil.begin("${rocket.name.replace(/^Example:\s*/, "").replace(/"/g, "").slice(0, 24)}");   // tells Mockingbird you're ready
}

void loop() {
  hil.poll();                         // read what Mockingbird sent
  float pressure = hil.active() ? hil.pressure() : readMyBarometer();
  float accelUp  = hil.active() ? hil.accelG(2)  : readMyAccelZ();   // 0=X 1=Y 2=Z
  uint32_t now   = hil.millis();      // sample time while testing

  // ... your flight logic ...
  // when it decides to fire a channel:
  //   if (hil.active()) hil.pyro(1);  else firePyro(1);
}`;
  const lib = h("div", { class: "panel-body col", style: { gap: "8px" } },
    h("p", { style: { margin: 0 } }, "The ", h("b", null, "MockingbirdHIL"), " library is in the Arduino folder of the download. Copy it into Documents\\Arduino\\libraries, restart the Arduino IDE, and open File › Examples › MockingbirdHIL."),
    h("pre", { class: "code" }, snippet),
    h("div", { class: "row" }, h("button", { class: "btn small", onclick: () => navigator.clipboard?.writeText(snippet).then(() => toast("Copied")) }, "Copy"),
      h("span", { class: "note" }, "Also send hil.event(\"APOGEE\"), hil.state(\"COAST\") and hil.telemetry(\"alt\", altitude) so detections and estimates show up in the results.")));

  const panel = (title, hint, body) => h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title" }, title), hint ? h("span", { class: "hint" }, hint) : null), body);
  el.append(h("div", { class: "setup" },
    h("div", { class: "col", style: { gap: "12px" } },
      panel("What Mockingbird sends", "Sensor readings streamed to your board", sendBody),
      panel("Sensors and timing", "", sensors),
      panel("Arduino library", "", lib)),
    h("div", { class: "col", style: { gap: "12px" } },
      panel("Pyro channels", `What each output does in the simulation of ${rocket.name.replace(/^Example:\s*/, "")}`, pyroBody),
      panel("Messages from your firmware", "Optional", rulesBody),
      panel("Pass and fail limits", "How strict the grading is", tolBody))));
}

// ---------------------------------------------------------------- test editor
export function editTest(test, { rocket, isNew, onSave, onDelete }) {
  const t = structuredClone(test);
  const stageOpts = rocket.stages.map((s, k) => [k, `${s.name} (stage ${k + 1})`]);
  const wrap = h("div", { class: "col", style: { gap: "12px" } });
  const draw = () => {
    clear(wrap);
    wrap.append(h("div", { class: "grid-form two" },
      textField("Name", t.name, (v) => { t.name = v; }),
      numField("Time on the pad", t.padTime ?? "", "s", (v) => { if (v === null || v <= 0) delete t.padTime; else t.padTime = v; }, { title: "Leave blank to use the setting on the Flight computer tab" })),
      textField("What it checks", t.note || "", (v) => { t.note = v; }, { placeholder: "A sentence shown with the results" }));
    const list = h("div", { class: "col", style: { gap: "8px" } });
    if (!t.faults.length) list.append(h("p", { class: "note", style: { margin: 0 } }, "No faults: a clean flight."));
    t.faults.forEach((fl, i) => {
      const T = FAULT_TYPES[fl.type];
      const whole = T.whole || fl.ref === "whole";
      const typeSel = selectField("Fault", fl.type, Object.entries(FAULT_TYPES).map(([k, v]) => [k, v.label]), (v) => { t.faults[i] = newFault(v); draw(); });
      const fields = [typeSel];
      if (!T.whole) {
        let sign = (Number(fl.offset) || 0) < 0 ? -1 : 1;
        fields.push(numField("Starts", Math.abs(Number(fl.offset) || 0), "s", (v) => { fl.offset = sign * Math.abs(v ?? 0); }, { min: 0 }));
        fields.push(selectField("", sign < 0 ? "before" : "after", [["before", "before"], ["after", "after"]], (v) => { sign = v === "before" ? -1 : 1; fl.offset = sign * Math.abs(Number(fl.offset) || 0); }));
        fields.push(selectField("", fl.ref === "whole" ? "liftoff" : fl.ref, FAULT_REFS, (v) => { fl.ref = v; }));
        fields.push(numField(T.holds ? "Drifts for" : "Lasts", fl.duration, "s", (v) => { fl.duration = Math.max(0, v ?? 0); }, { min: 0 }));
      }
      for (const p of T.params) {
        if (p.kind === "sensor") fields.push(selectField(p.label, fl.params[p.key], SENSORS, (v) => { fl.params[p.key] = v; }));
        else if (p.kind === "stage") fields.push(selectField(p.label, fl.params[p.key], stageOpts, (v) => { fl.params[p.key] = Number(v); }));
        else fields.push(numField(p.label, fl.params[p.key], p.unit, (v) => { fl.params[p.key] = v ?? p.value; }));
      }
      list.append(h("div", { class: "rk-card" },
        h("div", { class: "rk-card-head" }, h("b", null, T.label), h("span", { class: "muted", style: { fontSize: "13px" } }, whole ? "whole flight" : ""), h("div", { class: "spacer" }),
          h("button", { class: "btn small ghost", onclick: () => { t.faults.splice(i, 1); draw(); } }, "Remove")),
        h("p", { class: "note", style: { margin: 0 } }, T.desc),
        h("div", { class: "fault-row" }, fields)));
    });
    const addSel = h("select", { "aria-label": "Fault to add" }, Object.entries(FAULT_TYPES).map(([k, v]) => h("option", { value: k }, v.label)));
    wrap.append(h("div", { class: "sub-title" }, "Faults"), list,
      h("div", { class: "row" }, addSel, h("button", { class: "btn", onclick: () => { t.faults.push(newFault(addSel.value)); draw(); } }, "Add fault")));
  };
  draw();
  const actions = [];
  if (!isNew && onDelete) actions.push({ label: "Delete test", kind: "danger", onClick: async () => { if (await confirmBox("Delete test", `Delete "${test.name}"?`, "Delete", "danger")) onDelete(); else return false; } });
  actions.push({ label: "Cancel" }, { label: isNew ? "Add test" : "Save", kind: "primary", onClick: () => { if (!t.name.trim()) { toast("Give the test a name.", "fault"); return false; } onSave(t); } });
  modal({ title: isNew ? "New test" : "Edit test", body: wrap, wide: true, actions });
}

export { describeFault };
