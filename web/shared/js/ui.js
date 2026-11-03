// Small DOM helpers shared by all apps.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

let toastBox;
export function toast(msg, kind = "", ms = 4200) {
  if (!toastBox) { toastBox = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(toastBox); }
  const t = h("div", { class: "toast " + kind }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// modal({title, body, actions:[{label, kind, onClick -> false keeps open}], wide})
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const foot = h("div", { class: "modal-foot" });
  for (const a of actions) {
    foot.append(h("button", {
      class: "btn " + (a.kind || ""), onclick: async () => {
        const r = a.onClick ? await a.onClick() : undefined;
        if (r !== false) close();
      }
    }, a.label));
  }
  const box = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "modal-head" }, h("h2", null, title), h("div", { class: "spacer" }),
      h("button", { class: "btn ghost icon", "aria-label": "Close", onclick: close }, "✕")),
    h("div", { class: "modal-body" }, body),
    actions.length ? foot : null);
  const back = h("div", { class: "modal-back", onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener("keydown", onKey);
  setTimeout(() => { const f = box.querySelector("input,select,textarea,button.primary"); f && f.focus(); }, 30);
  return { close, el: box };
}

export function confirmBox(title, text, okLabel = "OK", kind = "primary") {
  return new Promise((res) => {
    modal({
      title, body: h("p", { style: { margin: 0 } }, text), onClose: () => res(false),
      actions: [{ label: "Cancel", onClick: () => res(false) }, { label: okLabel, kind, onClick: () => res(true) }],
    });
  });
}

// Labelled numeric input with a unit suffix. get/set work in display units.
export function numField(label, value, unit, onChange, opts = {}) {
  const inp = h("input", { type: "number", value: value ?? "", step: opts.step ?? "any", min: opts.min, max: opts.max, "aria-label": label });
  inp.addEventListener("change", () => {
    const v = inp.value === "" ? null : Number(inp.value);
    if (v !== null && !Number.isFinite(v)) { inp.classList.add("bad"); return; }
    inp.classList.remove("bad");
    onChange && onChange(v);
  });
  const wrap = h("label", { class: "field", title: opts.title },
    h("span", null, label),
    unit ? h("div", { class: "unit-input" }, inp, h("span", { class: "unit" }, unit)) : inp);
  wrap.input = inp;
  return wrap;
}

export function textField(label, value, onChange, opts = {}) {
  const inp = h("input", { type: "text", value: value ?? "", placeholder: opts.placeholder || "", "aria-label": label });
  inp.addEventListener(opts.live ? "input" : "change", () => onChange && onChange(inp.value));
  const wrap = h("label", { class: "field", title: opts.title }, h("span", null, label), inp);
  wrap.input = inp;
  return wrap;
}

export function selectField(label, value, options, onChange, opts = {}) {
  const sel = h("select", { "aria-label": label });
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    sel.append(h("option", { value: v, selected: String(v) === String(value) }, t));
  }
  sel.addEventListener("change", () => onChange && onChange(sel.value));
  const wrap = h("label", { class: "field", title: opts.title }, h("span", null, label), sel);
  wrap.input = sel;
  return wrap;
}

export function checkField(label, checked, onChange, opts = {}) {
  const inp = h("input", { type: "checkbox", checked: !!checked });
  inp.addEventListener("change", () => onChange && onChange(inp.checked));
  const l = h("label", { class: "check", title: opts.title }, inp, label);
  l.input = inp;
  return l;
}

export function seg(options, value, onChange) {
  const box = h("div", { class: "seg", role: "group" });
  const set = (v) => { for (const b of box.children) b.classList.toggle("on", b.dataset.v === String(v)); };
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    box.append(h("button", { "data-v": v, onclick: () => { set(v); onChange && onChange(v); } }, t));
  }
  set(value);
  box.set = set;
  return box;
}

export function tabs(names, value, onChange) {
  const box = h("div", { class: "tabs", role: "tablist" });
  const set = (v) => { for (const b of box.children) { const on = b.dataset.v === v; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); } };
  for (const [v, t] of names) box.append(h("button", { "data-v": v, role: "tab", onclick: () => { set(v); onChange(v); } }, t));
  set(value);
  box.set = set;
  return box;
}

export function download(name, text, type = "text/plain") {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function readFileText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(file); });
}

export function pickFile(accept = "") {
  return new Promise((res) => {
    const inp = h("input", { type: "file", accept, style: { display: "none" } });
    inp.addEventListener("change", () => { res(inp.files[0] || null); inp.remove(); });
    document.body.append(inp); inp.click();
  });
}

export function dropTarget(el, onFiles) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("over"); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme === "night" ? "night" : "day";
  window.dispatchEvent(new CustomEvent("themechange"));
}

export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function fmtTime(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return "–";
  const neg = s < 0; s = Math.abs(s);
  const m = Math.floor(s / 60), sec = s - m * 60;
  return (neg ? "−" : "") + (m ? `${m}:${sec.toFixed(1).padStart(4, "0")}` : sec.toFixed(1)) ;
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function safeName(s) { return String(s || "").replace(/:/g, " ").replace(/[\\/*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60); }

// Bird marks, drawn as simple geometric glyphs.
export const marks = {
  owl: `<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9 L10 4 L13 8 M26 9 L22 4 L19 8"/><path d="M6 9c0 9 3 18 10 19c7-1 10-10 10-19c-3-2-7-2-10 0c-3-2-7-2-10 0z"/><circle cx="11.5" cy="13.5" r="3"/><circle cx="20.5" cy="13.5" r="3"/><path d="M16 17l-1.5 3h3z" fill="currentColor"/></svg>`,
  heron: `<svg viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M39 17c-1-3 1-6 4-5l1 2"/><path d="M39 17c-2 4-2 7 0 11c2 5 1 9-4 12c-6 3-14 4-20 3c5-8 13-12 21-11"/><path d="M39 28c3 7 1 13-4 18c-3 3-4 7-4 12"/><path d="M44 14L56 23L42.5 17.5" style="stroke:var(--orange)" stroke-width="3.4"/></svg>`,
  mockingbird: `<svg viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="25" cy="25" r="14" style="fill:var(--orange)" stroke="none"/><path d="M24 37c-1-11 5-20 15-20c5 0 9 3 10 7l6 2l-6 2c0 11-6 18-15 18c-5 0-9-3-10-9z"/><path d="M28 40c5 3 12 2 17-4"/><path d="M36 49l-1 5M42 47l2 6"/><path d="M12 54L46 16" stroke-width="3"/><circle cx="41" cy="23" r="2.4" fill="currentColor" stroke="none"/></svg>`,
};

export function appHeader(app, name, subEl, toolsEl) {
  const brand = h("div", { class: "brand" }, h("span", { html: marks[app] }), h("span", { class: "brand-name" }, name));
  const sub = h("span", { class: "brand-sub" }, subEl || "");
  return h("header", { class: "app-header" }, brand, sub, h("div", { class: "header-tools" }, toolsEl || ""));
}
