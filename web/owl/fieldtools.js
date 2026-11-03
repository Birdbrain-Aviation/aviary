// Owl field tools: the pre-flight checklist (built from the rocket profile,
// ticked automatically where telemetry can prove it) and recovery mode (a
// full-screen arrow and distance to the rocket, from this laptop's own live
// location).

import { h, clear, modal, selectField, toast } from "/shared/js/ui.js";
import { distanceBearing } from "/shared/js/map.js";

// ------------------------------------------------------------------ checklist
const fmtM = (D, m) => `${D.fmtAlt(m)} ${D.altUnit}`;

// Items for a rocket. auto(ctx) returns true/false when telemetry can tell, or
// null when it can't (then it stays a manual tick).
export function checklistItems(rocket, D, custom = []) {
  const items = [];
  const add = (group, key, text, auto) => items.push({ group, key, text, auto: auto || null });
  if (rocket) {
    rocket.stages.forEach((s, k) => {
      const m = s.motor?.designation || s.motor?.name || "motor";
      const n = s.motorCount > 1 ? `${s.motorCount} × ${m}` : m;
      add("Motor", `motor${k}`, `${rocket.stages.length > 1 ? s.name + ": " : ""}${n} installed and retained`);
      if (s.ignition === "pad") add("Motor", `ign${k}`, `${rocket.stages.length > 1 ? s.name + ": " : ""}igniter in, leads shunted until the pad`);
      else add("Motor", `ign${k}`, `${s.name}: igniter wired to the flight computer${s.ignitionDelay ? `, ${s.ignitionDelay} s after the stage below burns out` : ""}`);
    });
    for (const d of rocket.recovery) {
      const when = d.deploy === "apogee" ? `at apogee${d.delay ? ` + ${d.delay} s` : ""}` : d.deploy === "altitude" ? `at ${fmtM(D, d.altitude)} on the way down` : d.deploy === "timer" ? `${d.time} s after liftoff` : `by the motor's ejection charge${d.delay ? ` (${d.delay} s delay)` : ""}`;
      add("Recovery", `dev_${d.id}`, `${d.name} packed, deploys ${when}${d.pyro ? `, charge on pyro ${d.pyro}` : ""}`);
    }
    add("Recovery", "harness", "Shock cords, quick links and chute protector checked");
  }
  add("Electronics", "batt", "Flight computer battery charged", (c) => (c.batt == null ? null : c.batt > (c.battLow || 0) + 0.05));
  add("Electronics", "link", "Telemetry coming in", (c) => (c.connected ? c.recentPackets : null));
  add("Electronics", "gps", "GPS has a position", (c) => (c.gpsSeen ? c.gpsFix : null));
  add("Electronics", "armed", "Flight computer armed, continuity on every charge", (c) => (c.armed == null ? null : c.armed));
  add("Pad", "rail", "Rail angle set for the wind, rocket slides freely");
  add("Pad", "rso", "Range safety check done, area clear");
  add("Pad", "record", "Owl is recording", (c) => c.recording);
  for (const x of custom) add("Your items", "c_" + x.id, x.text);
  return items;
}

// ctx: { set, D, store, state() -> live telemetry facts, save(), onChange() }
export function openChecklist(ctx) {
  const { set, D, store } = ctx;
  set.checklist ||= { rocket: store.selected, custom: {}, done: {} };
  const cl = set.checklist;
  if (!store.rockets.find((r) => r.id === cl.rocket)) cl.rocket = store.selected;
  const body = h("div", { class: "checklist" });
  let timer = null;
  const draw = () => {
    clear(body);
    const rocket = store.rockets.find((r) => r.id === cl.rocket);
    const custom = cl.custom[cl.rocket] || [];
    const items = checklistItems(rocket, D, custom);
    const live = ctx.state();
    const isDone = (it) => { const a = it.auto ? it.auto(live) : null; return a === true || !!cl.done[it.key]; };
    const doneN = items.filter(isDone).length;
    body.append(h("div", { class: "cl-top" },
      selectField("Rocket", cl.rocket, store.rockets.map((r) => [r.id, r.name]), (v) => { cl.rocket = v; cl.done = {}; ctx.save(); draw(); }),
      h("div", { class: "cl-progress" }, h("b", null, `${doneN} of ${items.length}`), " done",
        h("div", { class: "cl-bar" }, h("i", { style: { width: `${(100 * doneN) / Math.max(1, items.length)}%` } })))));
    let group = null, ul = null;
    for (const it of items) {
      if (it.group !== group) { group = it.group; body.append(h("h3", null, group)); ul = h("ul"); body.append(ul); }
      const a = it.auto ? it.auto(live) : null;
      const done = isDone(it);
      const box = h("input", { type: "checkbox", checked: done, disabled: a === true, onchange: () => { if (box.checked) cl.done[it.key] = new Date().toISOString(); else delete cl.done[it.key]; ctx.save(); draw(); ctx.onChange(); } });
      ul.append(h("li", { class: done ? "done" : "" },
        h("label", null, box, h("span", null, it.text)),
        a === true ? h("span", { class: "cl-auto" }, "from telemetry") : a === false ? h("span", { class: "cl-auto no" }, "not yet") : "",
        it.key.startsWith("c_") ? h("button", { class: "btn ghost icon small", title: "Remove", "aria-label": "Remove", onclick: () => { cl.custom[cl.rocket] = custom.filter((x) => "c_" + x.id !== it.key); delete cl.done[it.key]; ctx.save(); draw(); } }, "✕") : ""));
    }
    const inp = h("input", { type: "text", placeholder: "Add your own item, for example: camera on", "aria-label": "New checklist item" });
    const addIt = () => { const t = inp.value.trim(); if (!t) return; (cl.custom[cl.rocket] ||= []).push({ id: Math.random().toString(36).slice(2, 8), text: t }); ctx.save(); draw(); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addIt(); });
    body.append(h("div", { class: "cl-add" }, inp, h("button", { class: "btn small", onclick: addIt }, "Add")));
  };
  draw();
  timer = setInterval(draw, 1500);     // auto items follow the telemetry
  modal({
    title: "Pre-flight checklist", body, wide: true, onClose: () => { clearInterval(timer); ctx.onChange(); },
    actions: [{ label: "Clear ticks", onClick: () => { cl.done = {}; ctx.save(); draw(); ctx.onChange(); return false; } }, { label: "Done", kind: "primary" }],
  });
}

// Snapshot of the checklist for saving with a recording.
export function checklistRecord(ctx) {
  const { set, D, store } = ctx;
  const cl = set.checklist; if (!cl) return null;
  const rocket = store.rockets.find((r) => r.id === cl.rocket);
  const live = ctx.state();
  const items = checklistItems(rocket, D, cl.custom[cl.rocket] || []);
  return {
    rocket: rocket?.name || null,
    items: items.map((it) => { const a = it.auto ? it.auto(live) : null; return { group: it.group, item: it.text, done: a === true || !!cl.done[it.key], by: a === true ? "telemetry" : cl.done[it.key] ? "you" : null, at: cl.done[it.key] || null }; }),
  };
}

export function checklistProgress(ctx) {
  const { set, D, store } = ctx;
  const cl = set.checklist; if (!cl) return null;
  const rocket = store.rockets.find((r) => r.id === cl.rocket);
  const live = ctx.state();
  const items = checklistItems(rocket, D, cl.custom[cl.rocket] || []);
  return { done: items.filter((it) => (it.auto && it.auto(live) === true) || cl.done[it.key]).length, total: items.length };
}

// ------------------------------------------------------------------ recovery mode
// ctx: { D, last() -> {lat, lon, at, alt?}, pad() -> {lat, lon} | null }
export function openRecoveryMode(ctx) {
  const { D } = ctx;
  let me = null, watch = null, heading = null, err = "";
  const arrow = h("div", { class: "rm-arrow" });
  const dist = h("div", { class: "rm-dist" }, "–");
  const dir = h("div", { class: "rm-dir" });
  const info = h("div", { class: "rm-info" });
  const note = h("div", { class: "rm-note" });
  const root = h("div", { class: "recovery-mode", role: "dialog", "aria-label": "Recovery mode" },
    h("div", { class: "rm-head" }, h("span", { class: "rm-title" }, "Recovery"), h("div", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => close() }, "Exit")),
    h("div", { class: "rm-main" }, arrow, h("div", { class: "rm-text" }, dist, dir, info)), note);
  document.body.append(root);

  const draw = () => {
    const last = ctx.last();
    const from = me || ctx.pad();
    if (!last) { dist.textContent = "–"; dir.textContent = "No rocket position yet"; arrow.innerHTML = ""; info.textContent = ""; return; }
    const db = from ? distanceBearing([from.lat, from.lon], [last.lat, last.lon]) : null;
    // with a heading (you're walking), the arrow is relative to where you face
    const rel = db ? (heading != null ? db.bearing - heading : db.bearing) : 0;
    arrow.innerHTML = `<svg viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" r="92" fill="none" stroke="var(--rule)" stroke-width="2"/>
      ${heading == null ? `<text x="100" y="22" text-anchor="middle" font-size="14" fill="var(--graphite)">N</text>` : `<text x="100" y="22" text-anchor="middle" font-size="12" fill="var(--graphite)">AHEAD</text>`}
      ${db ? `<g transform="rotate(${rel} 100 100)"><path d="M100 26 L122 104 L100 90 L78 104 Z" fill="var(--orange)"/><line x1="100" y1="92" x2="100" y2="160" stroke="var(--ink)" stroke-width="6" stroke-linecap="round"/></g>` : ""}
      <circle cx="100" cy="100" r="5" fill="var(--ink)"/></svg>`;
    dist.textContent = db ? D.fmtDist(db.distance) : "–";
    dir.textContent = db ? `${Math.round(db.bearing)}° ${compassWord(db.bearing)}${me ? "" : " of the pad"}` : "Waiting for a position";
    const age = (performance.now() - last.at) / 1000;
    info.textContent = `Rocket ${last.lat.toFixed(6)}, ${last.lon.toFixed(6)} · ${age < 5 ? "live" : `last heard ${age < 90 ? Math.round(age) + " s" : Math.round(age / 60) + " min"} ago`}`;
    note.textContent = err || (me ? (heading != null ? "Arrow points relative to the way you're walking." : "Arrow points relative to north. Walk a few steps and it turns to match your direction.") : "Using the pad as the start point until this laptop's location comes in.");
  };
  if (navigator.geolocation) {
    watch = navigator.geolocation.watchPosition((p) => {
      me = { lat: p.coords.latitude, lon: p.coords.longitude };
      heading = Number.isFinite(p.coords.heading) && (p.coords.speed || 0) > 0.5 ? p.coords.heading : heading;
      err = ""; draw();
    }, () => { err = "This laptop's location isn't available (turn on Windows location services). Showing distance from the pad."; draw(); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  } else err = "This window can't get a location. Showing distance from the pad.";
  const timer = setInterval(draw, 1000);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  const close = () => { clearInterval(timer); if (watch != null) navigator.geolocation.clearWatch(watch); document.removeEventListener("keydown", onKey); root.remove(); };
  draw();
  return { close };
}

const compassWord = (b) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((b % 360) + 360) % 360 / 45) % 8];
