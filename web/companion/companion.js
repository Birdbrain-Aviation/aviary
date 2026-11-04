// Owl companion: the phone side. Shows Owl's live readouts (sent by Owl on the
// laptop over Wi-Fi) and points the way to the rocket using this phone's own
// GPS and compass. The rocket's last position is kept on the phone, so the
// arrow keeps working after you walk out of Wi-Fi range.

const $ = (sel) => document.querySelector(sel);
const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
};
const store = {
  get(k, d = null) { try { const v = localStorage.getItem("owl." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("owl." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- pairing key
const q = new URLSearchParams(location.search);
let key = q.get("k") || store.get("key");
if (q.get("k")) store.set("key", q.get("k"));

// ---------------------------------------------------------------- state
const C = {
  tab: store.get("tab", "live"),
  state: store.get("last")?.state || null,  // the newest snapshot from Owl
  stateAt: store.get("last")?.at || 0,       // when it arrived (phone clock, ms)
  fix: store.get("fix"),                     // rocket's last GPS fix {lat, lon, at}
  units: store.get("units", null),           // null = follow Owl
  speak: store.get("speak", false),
  keepOn: store.get("keepOn", true),
  me: null, heading: null, compass: false, geoErr: "",
  spoken: new Set(store.get("spoken", [])),
  keyBad: false,
};

const FT = 0.3048;
const imperial = () => (C.units || C.state?.units || "imperial") === "imperial";
const fmtNum = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const alt = (m) => (imperial() ? fmtNum(m / FT) : fmtNum(m));
const altU = () => (imperial() ? "ft" : "m");
const vel = (v) => (imperial() ? fmtNum(v / FT) : fmtNum(v));
const velU = () => (imperial() ? "ft/s" : "m/s");
const dist = (m) => {
  if (!Number.isFinite(m)) return "–";
  if (imperial()) { const ft = m / FT; return ft < 1000 ? `${fmtNum(Math.round(ft / 5) * 5)} ft` : `${fmtNum(m / 1609.344, 2)} mi`; }
  return m < 1000 ? `${fmtNum(Math.round(m))} m` : `${fmtNum(m / 1000, 2)} km`;
};
const ago = (ms) => { const s = ms / 1000; return s < 5 ? "just now" : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const compassWord = (b) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round((((b % 360) + 360) % 360) / 45) % 8];

function distanceBearing(a, b) {
  const R = 6371008.8, toR = Math.PI / 180;
  const p1 = a.lat * toR, p2 = b.lat * toR, dp = (b.lat - a.lat) * toR, dl = (b.lon - a.lon) * toR;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { distance: d, bearing: ((Math.atan2(y, x) / toR) + 360) % 360 };
}

// ---------------------------------------------------------------- data from Owl
let es = null;
function connect() {
  if (!key) return;
  try { es?.close(); } catch { /* */ }
  es = new EventSource(`/c/events?k=${encodeURIComponent(key)}`);
  es.addEventListener("state", (e) => { try { onState(JSON.parse(e.data)); } catch { /* */ } });
  es.addEventListener("ping", () => { C.pingAt = Date.now(); });
  es.onerror = async () => {
    if (es.readyState === 2) {
      // closed for good: wrong key, or Owl stopped sharing
      try { const r = await fetch(`/c/state?k=${encodeURIComponent(key)}`, { cache: "no-store" }); if (r.status === 401) { C.keyBad = true; render(); return; } } catch { /* laptop out of reach */ }
      setTimeout(connect, 3000);
    }
  };
}

function onState(s) {
  const now = Date.now();
  C.state = s; C.stateAt = now; C.keyBad = false;
  if (s.fix && Number.isFinite(s.fix.lat) && Number.isFinite(s.fix.lon)) {
    const at = now - (s.fix.ago || 0) * 1000;
    if (!C.fix || at > C.fix.at + 500 || C.fix.lat !== s.fix.lat || C.fix.lon !== s.fix.lon) { C.fix = { lat: s.fix.lat, lon: s.fix.lon, alt: s.fix.alt ?? null, at }; store.set("fix", C.fix); }
  }
  if (now - (C.savedAt || 0) > 2000) { store.set("last", { state: s, at: now }); C.savedAt = now; }
  speakEvents(s);
  scheduleRender();
}

// spoken callouts for the events Owl announces (launch, apogee, main, landing, signal)
function speakEvents(s) {
  const evs = s.events || [];
  for (const e of evs.slice().reverse()) {
    const id = `${e.what}|${e.t ?? ""}|${e.clock ?? ""}`;
    if (C.spoken.has(id)) continue;
    C.spoken.add(id);
    const fresh = !e.clock || Date.now() - Date.parse(e.clock) < 15000;
    if (C.speak && fresh && (e.kind === "hot" || e.kind === "bad" || e.kind === "good") && "speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(e.say || e.what);
      u.rate = 1.05;
      speechSynthesis.speak(u);
    }
  }
  if (C.spoken.size > 400) C.spoken = new Set([...C.spoken].slice(-200));
  store.set("spoken", [...C.spoken].slice(-200));
}

// ---------------------------------------------------------------- phone sensors
let geoWatch = null;
function startGeo() {
  if (geoWatch != null || !navigator.geolocation) return;
  geoWatch = navigator.geolocation.watchPosition((p) => {
    C.me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
    // walking heading from GPS when there's no compass
    if (!C.compass && Number.isFinite(p.coords.heading) && (p.coords.speed || 0) > 0.6) C.heading = p.coords.heading;
    C.geoErr = ""; scheduleRender();
  }, (e) => {
    C.geoErr = e.code === 1 ? "Location is off for this app. Settings › Privacy › Location Services › Safari Websites (or Owl): While Using." : "Waiting for a GPS position…";
    scheduleRender();
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}
async function startCompass() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== "granted") { C.compassErr = "Compass permission was declined."; render(); return; }
    }
  } catch { C.compassErr = "This browser won't share the compass here."; render(); return; }
  const onOri = (e) => {
    let hd = null;
    if (Number.isFinite(e.webkitCompassHeading)) hd = e.webkitCompassHeading;   // iPhone: degrees from north
    else if (e.absolute && Number.isFinite(e.alpha)) hd = 360 - e.alpha;          // Android
    if (hd == null) return;
    const so = (screen.orientation?.angle ?? window.orientation ?? 0) || 0;
    C.heading = (hd + so + 360) % 360; C.compass = true;
    scheduleRender();
  };
  window.addEventListener("deviceorientationabsolute", onOri);
  window.addEventListener("deviceorientation", onOri);
  C.compassAsked = true;
  store.set("compassAsked", true);
  render();
}

let wake = null;
async function keepAwake() {
  if (!C.keepOn || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => { wake = null; }); } catch { /* not allowed now */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { keepAwake(); if (!es || es.readyState === 2) connect(); } });

// ---------------------------------------------------------------- rendering
let pending = false;
function scheduleRender() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }

const OWL = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9 L10 4 L13 8 M26 9 L22 4 L19 8"/><path d="M6 9c0 9 3 18 10 19c7-1 10-10 10-19c-3-2-7-2-10 0c-3-2-7-2-10 0z"/><circle cx="11.5" cy="13.5" r="3"/><circle cx="20.5" cy="13.5" r="3"/><path d="M16 17l-1.5 3h3z" fill="#ff5a1f" stroke="none"/></svg>`;
const ICON = {
  live: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 4-7 5 9"/><path d="M3 21h18"/></svg>`,
  rec: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 5l3.5 9L12 12l-3.5 2z" fill="currentColor"/></svg>`,
  set: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>`,
};

function pill() {
  if (!key) return h("span", { class: "pill bad" }, h("i"), "Not paired");
  const age = Date.now() - C.stateAt;
  if (C.stateAt && age < 4000) {
    const s = C.state;
    if (!s?.connected) return h("span", { class: "pill warn" }, h("i"), "Owl: no radio");
    if (s.signalLost) return h("span", { class: "pill bad" }, h("i"), `No telemetry ${Math.round(s.lastPacketAgo || 0)} s`);
    return h("span", { class: "pill ok" }, h("i"), "Live");
  }
  return h("span", { class: "pill warn" }, h("i"), C.stateAt ? `Laptop out of reach · ${ago(age)}` : "Looking for Owl…");
}

function render() {
  const app = $("#app");
  app.innerHTML = "";
  app.append(h("header", { class: "top" }, h("div", { class: "brand", html: OWL + "<span>Owl</span>" }), h("div", { class: "spacer" }), pill()));
  const main = h("main");
  app.append(main);
  if (!key || C.keyBad) main.append(pairView());
  else if (C.tab === "rec") main.append(...recoveryView());
  else if (C.tab === "set") main.append(...settingsView());
  else main.append(...liveView());
  const tab = (id, label, icon) => h("button", { class: C.tab === id ? "on" : "", onclick: () => { C.tab = id; store.set("tab", id); if (id === "rec") startGeo(); render(); window.scrollTo(0, 0); } }, h("span", { html: icon }), label);
  app.append(h("nav", { class: "tabs" }, tab("live", "Live", ICON.live), tab("rec", "Recovery", ICON.rec), tab("set", "Settings", ICON.set)));
}

const RAIL = [["pad", "Pad"], ["boost", "Boost"], ["coast", "Coast"], ["drogue", "Descent"], ["main", "Main"], ["landed", "Landed"]];
const RAIL_I = { pad: 0, boost: 1, coast: 2, descent: 3, drogue: 3, main: 4, landed: 5 };

function liveView() {
  const s = C.state;
  if (!s) return [h("div", { class: "card empty" }, h("h2", null, "Waiting for Owl"), h("p", null, "Open Owl on the laptop and turn on Phone companion. The readouts appear here as soon as it sends them."))];
  const cur = RAIL_I[s.phase] ?? 0;
  const rail = h("div", { class: "rail" }, RAIL.map(([k, l]) => h("span", { class: RAIL_I[k] < cur ? "done" : RAIL_I[k] === cur ? "now" : "" }, l)));
  const hasAlt = Number.isFinite(s.alt);
  const vs = s.vs;
  const hero = h("section", { class: "card hero" },
    h("div", { class: "k" }, "Altitude above the pad"),
    h("div", { class: "big" + (hasAlt ? "" : " nodata") }, hasAlt ? alt(s.alt) : "No data", hasAlt ? h("small", null, altU()) : ""),
    h("div", { class: "subs" },
      h("div", null, h("div", { class: "k" }, "Speed"), h("div", { class: "v" }, Number.isFinite(vs) && hasAlt ? `${vs > 1 ? "↑ " : vs < -1 ? "↓ " : ""}${vel(Math.abs(vs))}` : "–", h("small", null, velU()))),
      h("div", null, h("div", { class: "k" }, "Highest"), h("div", { class: "v" }, s.max > 0 ? alt(s.max) : "–", h("small", null, altU()))),
      h("div", null, h("div", { class: "k" }, "Time"), h("div", { class: "v" }, s.tplus || "–"))));
  const tile = (k, v, u) => h("div", { class: "tile" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v ?? "–", u ? h("small", null, u) : ""));
  const lp = s.lastPacketAgo;
  const tiles = h("section", { class: "card tiles" },
    tile("Signal", Number.isFinite(s.rssi) ? fmtNum(s.rssi) : lp != null ? (lp < 2 ? "OK" : `${Math.round(lp)} s`) : "–", Number.isFinite(s.rssi) ? "dBm" : ""),
    tile("Battery", Number.isFinite(s.batt) ? fmtNum(s.batt, 2) : "–", Number.isFinite(s.batt) ? "V" : ""),
    tile("GPS", Number.isFinite(s.sats) ? fmtNum(s.sats) : s.fix ? "Fix" : "–", Number.isFinite(s.sats) ? "sats" : ""),
    tile("Flight computer", s.state ? String(s.state) : "–"));
  const evs = (s.events || []).slice(0, 10);
  const events = h("section", { class: "card" }, h("div", { class: "k" }, "Events"),
    evs.length ? h("ul", { class: "events" }, evs.map((e) => h("li", { class: e.kind || "" },
      h("span", { class: "t" }, Number.isFinite(e.t) ? `T${e.t >= 0 ? "+" : "−"}${Math.abs(e.t).toFixed(1)}` : ""),
      h("span", null, h("span", { class: "w" }, e.what), e.detail ? h("span", { class: "d" }, e.detail) : "")))) : h("p", { class: "muted small" }, "Nothing yet."));
  const out = [];
  if (C.stateAt && Date.now() - C.stateAt > 6000) out.push(h("div", { class: "banner" }, `Showing the last data from Owl, ${ago(Date.now() - C.stateAt)}. Recovery still works from the rocket's last position.`));
  out.push(h("div", { class: "muted small" }, [s.name, s.source].filter(Boolean).join(" · ")), rail, hero, tiles, events);
  return out;
}

function recoveryView() {
  startGeo();
  const f = C.fix;
  const out = [];
  if (!window.isSecureContext) out.push(h("div", { class: "banner" }, "Location and compass need the one-time certificate setup. Open the setup page from Owl's Phone companion window."));
  if (!f) { out.push(h("div", { class: "card empty" }, h("h2", null, "No rocket position yet"), h("p", null, "When Owl gets a GPS position from the rocket, the direction and distance appear here, and stay on this phone even out of Wi-Fi range."))); return out; }
  const me = C.me;
  const db = me ? distanceBearing(me, f) : null;
  const heading = C.heading;
  // arrow relative to where the phone points (compass) or to north
  const rot = db ? (heading != null ? db.bearing - heading : db.bearing) : 0;
  const north = heading != null ? -heading : 0;
  const svg = `<svg viewBox="0 0 200 200" aria-label="Direction to the rocket">
    <circle cx="100" cy="100" r="92" fill="none" stroke="var(--rule)" stroke-width="2"/>
    <g transform="rotate(${north} 100 100)"><text x="100" y="32" text-anchor="middle" font-size="14" font-weight="600" fill="var(--graphite)">N</text>
      <line x1="100" y1="8" x2="100" y2="17" stroke="var(--orange)" stroke-width="3" stroke-linecap="round"/></g>
    ${db ? `<g class="needle" style="transform: rotate(${rot}deg)"><path d="M100 22 L124 108 L100 92 L76 108 Z" fill="var(--orange)"/><line x1="100" y1="96" x2="100" y2="166" stroke="var(--ink)" stroke-width="7" stroke-linecap="round"/></g>` : ""}
    <circle cx="100" cy="100" r="6" fill="var(--ink)"/></svg>`;
  const maps = `https://maps.apple.com/?daddr=${f.lat.toFixed(6)},${f.lon.toFixed(6)}&dirflg=w`;
  out.push(h("section", { class: "card rec" },
    h("div", { class: "arrow", html: svg }),
    h("div", { class: "dist" }, db ? dist(db.distance) : "–"),
    h("div", { class: "dir" }, db ? `${Math.round(db.bearing)}° ${compassWord(db.bearing)}` : C.geoErr || "Finding your position…"),
    h("div", { class: "age" }, `Rocket position ${ago(Date.now() - f.at)}${f.alt != null && Number.isFinite(f.alt) ? "" : ""}${me ? ` · your GPS ±${dist(me.acc)}` : ""}`),
    h("div", { class: "hint" }, heading == null ? "Arrow points relative to north." : C.compass ? "Arrow points the way the phone faces. Hold it flat." : "Arrow points relative to the way you're walking.")));
  const btns = h("div", { class: "btns" });
  if (!C.compass) btns.append(h("button", { class: "btn primary wide", onclick: startCompass }, "Use the compass"));
  btns.append(
    h("a", { class: "btn", href: maps }, "Walk there in Maps"),
    h("button", { class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(`${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}`); flash("Copied"); } catch { flash("Couldn't copy"); } } }, "Copy position"));
  out.push(btns, h("div", { class: "coords muted", style: "text-align:center" }, `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}`));
  if (C.compassErr) out.push(h("div", { class: "hint", style: "text-align:center" }, C.compassErr));
  return out;
}

function settingsView() {
  const sw = (on, fn) => h("button", { class: "switch" + (on ? " on" : ""), role: "switch", "aria-checked": on ? "true" : "false", onclick: fn });
  const seg = (opts, val, fn) => h("div", { class: "seg" }, opts.map(([v, l]) => h("button", { class: v === val ? "on" : "", onclick: () => fn(v) }, l)));
  return [h("section", { class: "card" },
    h("div", { class: "row" }, h("div", null, "Units"), seg([[null, "As Owl"], ["imperial", "ft"], ["metric", "m"]], C.units, (v) => { C.units = v; store.set("units", v); render(); })),
    h("div", { class: "row" }, h("div", null, h("div", null, "Speak events"), h("div", { class: "muted small" }, "Launch, apogee, main, landing, signal lost")),
      sw(C.speak, () => { C.speak = !C.speak; store.set("speak", C.speak); if (C.speak && "speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance("Voice on")); render(); })),
    h("div", { class: "row" }, h("div", null, h("div", null, "Keep the screen on"), h("div", { class: "muted small" }, "While this app is open")),
      sw(C.keepOn, () => { C.keepOn = !C.keepOn; store.set("keepOn", C.keepOn); if (C.keepOn) keepAwake(); else wake?.release(); render(); })),
    h("div", { class: "row" }, h("div", null, "Rocket position"), h("button", { class: "btn", style: "min-height:36px;padding:6px 12px", onclick: () => { if (confirm("Forget the rocket's last position on this phone?")) { C.fix = null; store.set("fix", null); render(); } } }, "Forget"))),
  h("p", { class: "muted small", style: "padding: 0 4px" }, `Connected to ${location.host}. Pairing code ${key ? key.slice(0, 4) + "…" : "none"}. This app only reads from Owl; it can't change anything on the laptop.`)];
}

function pairView() {
  const inp = h("input", { class: "code", inputmode: "latin", autocapitalize: "off", autocomplete: "off", placeholder: "pairing code", value: "" });
  return h("section", { class: "card empty" },
    h("h2", null, C.keyBad ? "Pairing code changed" : "Pair with Owl"),
    h("p", null, "Scan the code in Owl's Phone companion window, or type the pairing code shown there."),
    inp,
    h("button", { class: "btn primary wide", onclick: () => { const v = inp.value.trim().toLowerCase(); if (!v) return; key = v; store.set("key", v); C.keyBad = false; connect(); render(); } }, "Pair"));
}

let flashT = null;
function flash(msg) {
  let el = $("#flash");
  if (!el) { el = h("div", { id: "flash", style: "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 80px);transform:translateX(-50%);background:var(--ink);color:var(--panel);padding:9px 16px;border-radius:20px;font-size:14px;z-index:9" }); document.body.append(el); }
  el.textContent = msg; el.style.display = "block";
  clearTimeout(flashT); flashT = setTimeout(() => { el.style.display = "none"; }, 1400);
}

// ---------------------------------------------------------------- start
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => { /* certificate not trusted yet */ });
// keep the pairing code in the address, so Add to Home Screen keeps it
if (key && !q.get("k")) history.replaceState(null, "", `${location.pathname}?k=${encodeURIComponent(key)}`);
render();
connect();
keepAwake();
if (C.tab === "rec") startGeo();
setInterval(() => { if (C.tab !== "set") scheduleRender(); }, 1000);   // ages and the status pill
