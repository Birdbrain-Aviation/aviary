// Talks to the app's local host process: settings, shared stores, files, events.

async function req(method, url, body, raw = false) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (typeof body === "string") { opt.body = body; opt.headers["Content-Type"] = "text/plain; charset=utf-8"; }
    else { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  }
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText);
  return raw ? r.text() : r.json();
}

export const host = {
  info: () => req("GET", "/api/info"),
  getSettings: () => req("GET", "/api/settings"),
  putSettings: (v) => req("PUT", "/api/settings", v),
  getStore: (name) => req("GET", "/api/store/" + name),
  putStore: (name, v) => req("PUT", "/api/store/" + name, v),
  list: (area) => req("GET", "/api/files?area=" + encodeURIComponent(area)),
  read: (area, path) => req("GET", `/api/file?area=${encodeURIComponent(area)}&path=${encodeURIComponent(path)}`, undefined, true),
  write: (area, path, text, unique = false) => req("PUT", `/api/file?area=${encodeURIComponent(area)}&path=${encodeURIComponent(path)}${unique ? "&unique=1" : ""}`, String(text)),
  append: (area, path, text) => req("POST", `/api/file/append?area=${encodeURIComponent(area)}&path=${encodeURIComponent(path)}`, String(text)),
  reveal: (area, path = "") => req("POST", `/api/reveal?area=${encodeURIComponent(area)}&path=${encodeURIComponent(path)}`, {}),
  quit: () => req("POST", "/api/quit", {}),
  post: (url, body) => req("POST", url, body),
  get: (url) => req("GET", url),
};

// One event stream per window. It keeps the app process alive while the
// window is open and carries live events (for example UDP telemetry).
const listeners = {};
let es;
export function connectEvents() {
  if (es) return es;
  const open = () => {
    es = new EventSource("/api/events");
    for (const name of Object.keys(listeners)) attach(name);
    es.onerror = () => { /* EventSource reconnects by itself */ };
  };
  const attach = (name) => es.addEventListener(name, (e) => {
    let d; try { d = JSON.parse(e.data); } catch { d = e.data; }
    for (const fn of listeners[name] || []) fn(d);
  });
  es = null; open();
  return es;
}
export function onEvent(name, fn) {
  const first = !listeners[name];
  (listeners[name] ||= []).push(fn);
  if (es && first) es.addEventListener(name, (e) => {
    let d; try { d = JSON.parse(e.data); } catch { d = e.data; }
    for (const f of listeners[name] || []) f(d);
  });
}

// Settings object that saves itself shortly after changes.
export async function loadSettings(defaults) {
  let s = null;
  try { s = await host.getSettings(); } catch { /* first run */ }
  const merged = deepMerge(structuredClone(defaults), s || {});
  let t;
  merged.save = () => { clearTimeout(t); t = setTimeout(() => { const { save, ...plain } = merged; host.putSettings(plain).catch(() => {}); }, 400); };
  return merged;
}

export function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) base[k] = deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}
