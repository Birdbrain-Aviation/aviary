// A small, fast canvas chart for time series (and simple x/y scatter).
// Features: multiple series on left/right axes, synced crosshair and zoom
// across a group, drag-to-zoom, shift-drag or right-drag to pan, wheel zoom,
// double-click to reset, phase bands, event markers, streaming with
// auto-follow, min/max decimation for large logs, PNG export.

import { h, cssVar } from "./ui.js";

export class ChartGroup {
  constructor() { this.charts = new Set(); }
  add(c) { this.charts.add(c); }
  remove(c) { this.charts.delete(c); }
  hover(x, src) { for (const c of this.charts) { c.hoverX = x; c.hoverSrc = src; c.redraw(); } }
  setView(v, src) { for (const c of this.charts) if (c !== src) c._setView(v, false); }
}

function lowerBound(arr, x, n) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

export function niceStep(range, maxTicks) {
  if (!(range > 0)) return 1;
  const raw = range / Math.max(1, maxTicks);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function tickLabel(v, step) {
  // as many decimals as the step itself has (2.5 -> 1, 0.25 -> 2, 50 -> 0)
  const d = Math.min(6, (String(+step.toPrecision(6)).split(".")[1] || "").length);
  const s = Math.abs(v) >= 10000 ? v.toLocaleString("en-US", { maximumFractionDigits: d }) : v.toFixed(d);
  return s === "-0" ? "0" : s.replace(/^-/, "−");
}

const DEFAULTS = {
  xLabel: "Time (s)", yLabel: "", y2Label: "", xUnit: "s",
  streaming: false, xWindow: 60, yIncludeZero: false, y2IncludeZero: false,
  padTop: 26, padBottom: 30, legend: true, tooltip: true, xMin: null,
  yFixed: null, y2Fixed: null,
};

export class TimeChart {
  constructor(el, opts = {}) {
    this.el = el;
    el.classList.add("chart");
    this.o = { ...DEFAULTS, ...opts };
    this.canvas = h("canvas", { "aria-label": this.o.ariaLabel || "Chart", role: "img" });
    this.tip = h("div", { class: "tip hidden" });
    this.legendEl = h("div", { class: "legend" });
    el.append(this.canvas, this.tip, this.legendEl);
    this.ctx = this.canvas.getContext("2d");
    this.series = [];
    this.bands = [];
    this.markers = [];
    this.view = null;
    this.follow = true;
    this.hoverX = null;
    this.drag = null;
    this.group = opts.group || null;
    if (this.group) this.group.add(this);
    this._colors();
    this._bind();
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(el);
    window.addEventListener("themechange", () => { this._colors(); this.redraw(); });
  }

  destroy() { this.ro.disconnect(); if (this.group) this.group.remove(this); this.el.innerHTML = ""; }

  _colors() {
    this.c = {
      ink: cssVar("--ink"), graphite: cssVar("--graphite"), faint: cssVar("--faint"),
      rule: cssVar("--rule"), panel: cssVar("--panel"), orange: cssVar("--orange"), orangeInk: cssVar("--orange-ink"),
      font: cssVar("--font") || "sans-serif",
    };
  }

  resolveColor(col) { return col && col.startsWith("--") ? cssVar(col) : col || this.c.ink; }

  // series: {id, label, color, axis:'y'|'y2', width, dash, unit, digits, style:'line'|'points'|'step'}
  addSeries(s) {
    const ser = { axis: "y", width: 1.75, dash: null, style: "line", visible: true, digits: 1, x: [], y: [], n: 0, ...s };
    ser.n = ser.x.length;
    this.series.push(ser);
    this._legend();
    this.redraw();
    return ser;
  }
  getSeries(id) { return this.series.find((s) => s.id === id); }
  removeSeries(id) { this.series = this.series.filter((s) => s.id !== id); this._legend(); this.redraw(); }
  clearSeries() { this.series = []; this._legend(); this.redraw(); }

  setData(id, x, y) {
    const s = this.getSeries(id);
    if (!s) return;
    s.x = x; s.y = y; s.n = x.length;
    this.redraw();
  }
  append(id, x, y) {
    const s = this.getSeries(id);
    if (!s || !Number.isFinite(x)) return;
    if (s.n > 0 && x < s.x[s.n - 1]) return; // keep x sorted
    s.x.push(x); s.y.push(y); s.n = s.x.length;
    this.redraw();
  }
  setBands(b) { this.bands = b || []; this.redraw(); }
  setMarkers(m) { this.markers = m || []; this.redraw(); }

  resetView() { this.view = null; this.follow = true; if (this.group) this.group.setView(null, this); this.redraw(); }
  _setView(v, propagate = true) {
    this.view = v; this.follow = v === null;
    if (propagate && this.group) this.group.setView(v, this);
    this.redraw();
  }

  toPNG() {
    const off = document.createElement("canvas");
    off.width = this.canvas.width; off.height = this.canvas.height;
    const c = off.getContext("2d");
    c.fillStyle = this.c.panel; c.fillRect(0, 0, off.width, off.height);
    c.drawImage(this.canvas, 0, 0);
    // legend as text
    c.scale(this.dpr || 1, this.dpr || 1);
    let lx = this.L || 56;
    c.font = `12px ${this.c.font}`;
    for (const s of this.series.filter((s) => s.visible)) {
      c.fillStyle = this.resolveColor(s.color); c.fillRect(lx, 8, 14, 3);
      c.fillStyle = this.c.graphite; c.fillText(s.label, lx + 18, 13); lx += 26 + c.measureText(s.label).width;
    }
    return off.toDataURL("image/png");
  }

  _legend() {
    this.legendEl.innerHTML = "";
    if (!this.o.legend) return;
    for (const s of this.series) {
      if (s.hideLegend) continue;
      const it = h("span", { class: s.visible ? "" : "off", title: "Show or hide " + s.label, onclick: () => { s.visible = !s.visible; it.classList.toggle("off", !s.visible); this.redraw(); } },
        h("i", { style: { background: this.resolveColor(s.color), height: s.dash ? "2px" : "3px" } }), s.label);
      this.legendEl.append(it);
    }
  }

  // full x extent of data
  _extent() {
    let x0 = Infinity, x1 = -Infinity;
    for (const s of this.series) {
      if (!s.visible || !s.n) continue;
      if (s.style === "points") { for (let i = 0; i < s.n; i++) { const v = s.x[i]; if (v < x0) x0 = v; if (v > x1) x1 = v; } }
      else { x0 = Math.min(x0, s.x[0]); x1 = Math.max(x1, s.x[s.n - 1]); }
    }
    for (const b of this.bands) { x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1); }
    if (!Number.isFinite(x0)) return [0, 10];
    if (this.o.xMin !== null) x0 = Math.min(x0, this.o.xMin);
    if (x1 - x0 < 1e-9) { x0 -= 1; x1 += 1; }
    return [x0, x1];
  }

  _xRange() {
    if (this.view) return [this.view.x0, this.view.x1];
    const [a, b] = this._extent();
    if (this.o.streaming) return [Math.max(a, b - this.o.xWindow), Math.max(b, a + Math.min(this.o.xWindow, 10))];
    return [a, b];
  }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const dpr = this.o.dpr || window.devicePixelRatio || 1;
    this.dpr = dpr;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const hasY2 = this.series.some((s) => s.axis === "y2" && s.visible);
    const L = 58, R = hasY2 ? 58 : 16, T = this.o.legend ? this.o.padTop : 10, B = this.o.padBottom;
    this.L = L; this.R = R; this.T = T; this.B = B; this.W = W; this.H = H;
    const pw = W - L - R, ph = H - T - B;
    if (pw < 20 || ph < 20) return;
    const [x0, x1] = this._xRange();
    this.x0 = x0; this.x1 = x1;
    const sx = (x) => L + ((x - x0) / (x1 - x0)) * pw;
    this.sx = sx;
    this.xinv = (px) => x0 + ((px - L) / pw) * (x1 - x0);

    // decimate visible data and find y ranges
    const ranges = { y: [Infinity, -Infinity], y2: [Infinity, -Infinity] };
    const paths = [];
    for (const s of this.series) {
      if (!s.visible || !s.n) continue;
      const pts = this._visiblePoints(s, x0, x1, pw);
      paths.push([s, pts]);
      const r = ranges[s.axis];
      for (let i = 1; i < pts.length; i += 2) { const v = pts[i]; if (Number.isFinite(v)) { if (v < r[0]) r[0] = v; if (v > r[1]) r[1] = v; } }
    }
    const yr = this._finishRange(ranges.y, this.o.yIncludeZero, this.o.yFixed);
    const y2r = this._finishRange(ranges.y2, this.o.y2IncludeZero, this.o.y2Fixed);
    const sy = (v, ax) => { const [a, b] = ax === "y2" ? y2r : yr; return T + ph - ((v - a) / (b - a)) * ph; };
    this.sy = sy; this.yr = yr; this.y2r = y2r;

    // bands
    ctx.save();
    for (const b of this.bands) {
      const a = Math.max(L, sx(b.x0)), e = Math.min(L + pw, sx(b.x1));
      if (e <= a) continue;
      ctx.fillStyle = this.resolveColor(b.color || "--panel-2");
      ctx.globalAlpha = b.alpha ?? 0.55;
      ctx.fillRect(a, T, e - a, ph);
      ctx.globalAlpha = 1;
      if (b.label && e - a > 34) {
        ctx.fillStyle = this.c.graphite; ctx.font = `11.5px ${this.c.font}`;
        ctx.fillText(b.label, a + 4, T + ph - 6);
      }
    }
    ctx.restore();

    // grid + axes
    ctx.font = `12px ${this.c.font}`;
    ctx.lineWidth = 1;
    const xs = niceStep(x1 - x0, Math.max(2, Math.floor(pw / 90)));
    ctx.strokeStyle = this.c.rule; ctx.fillStyle = this.c.graphite; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + 1e-9; v += xs) {
      const px = Math.round(sx(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke();
      ctx.fillText(tickLabel(v, xs), px, T + ph + 5);
    }
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const ys = niceStep(yr[1] - yr[0], Math.max(3, Math.floor(ph / 40)));
    for (let v = Math.ceil(yr[0] / ys) * ys; v <= yr[1] + 1e-9; v += ys) {
      const py = Math.round(sy(v, "y")) + 0.5;
      ctx.strokeStyle = Math.abs(v) < ys / 1e6 ? this.c.faint : this.c.rule;
      ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(L + pw, py); ctx.stroke();
      ctx.fillText(tickLabel(v, ys), L - 6, py);
    }
    if (hasY2) {
      ctx.textAlign = "left";
      const ys2 = niceStep(y2r[1] - y2r[0], Math.max(3, Math.floor(ph / 40)));
      for (let v = Math.ceil(y2r[0] / ys2) * ys2; v <= y2r[1] + 1e-9; v += ys2) ctx.fillText(tickLabel(v, ys2), L + pw + 6, sy(v, "y2"));
    }
    ctx.strokeStyle = this.c.faint;
    ctx.strokeRect(L + 0.5, T + 0.5, pw, ph);
    // axis labels
    ctx.fillStyle = this.c.graphite; ctx.font = `12px ${this.c.font}`;
    if (this.o.yLabel) { ctx.save(); ctx.translate(13, T + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(this.o.yLabel, 0, 0); ctx.restore(); }
    if (hasY2 && this.o.y2Label) { ctx.save(); ctx.translate(W - 11, T + ph / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(this.o.y2Label, 0, 0); ctx.restore(); }
    if (this.o.xLabel && H > 160) { ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(this.o.xLabel, L + pw, H - 1); }

    // series
    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
    for (const [s, pts] of paths) {
      ctx.strokeStyle = this.resolveColor(s.color);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = s.width;
      ctx.setLineDash(s.dash || []);
      ctx.lineJoin = "round";
      if (s.style === "points") {
        const r = s.radius || 2.2;
        for (let i = 0; i < pts.length; i += 2) {
          const v = pts[i + 1]; if (!Number.isFinite(v)) continue;
          ctx.beginPath(); ctx.arc(sx(pts[i]), sy(v, s.axis), r, 0, Math.PI * 2); ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      let pen = false, lastPy = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const v = pts[i + 1];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const px = sx(pts[i]), py = sy(v, s.axis);
        if (!pen) { ctx.moveTo(px, py); pen = true; }
        else if (s.style === "step") { ctx.lineTo(px, lastPy); ctx.lineTo(px, py); }
        else ctx.lineTo(px, py);
        lastPy = py;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // markers
    const rows = new Array(Math.max(2, Math.min(6, Math.floor((ph - 20) / 17)))).fill(-Infinity);
    ctx.font = `12px ${this.c.font}`;
    for (const m of this.markers) {
      if (m.x < x0 || m.x > x1) continue;
      const px = Math.round(sx(m.x)) + 0.5;
      const col = this.resolveColor(m.color || "--orange");
      ctx.strokeStyle = col; ctx.setLineDash(m.dash || [4, 3]); ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke(); ctx.setLineDash([]);
      if (m.label) {
        const w = ctx.measureText(m.label).width + 8;
        let row = rows.findIndex((r) => r < px - 2);
        if (row < 0) row = rows.indexOf(Math.min(...rows)); // all rows busy: reuse the one that frees up first
        rows[row] = px + w;
        const ty = T + 3 + row * 17;
        ctx.fillStyle = this.c.panel; ctx.globalAlpha = 0.9; ctx.fillRect(px + 1, ty, w, 15); ctx.globalAlpha = 1;
        ctx.fillStyle = m.textColor ? this.resolveColor(m.textColor) : this.c.orangeInk; ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(m.label, px + 5, ty + 1.5);
      }
    }

    // selection
    if (this.drag && this.drag.mode === "zoom") {
      const a = Math.max(L, Math.min(this.drag.px0, this.drag.px1)), e = Math.min(L + pw, Math.max(this.drag.px0, this.drag.px1));
      ctx.fillStyle = this.c.orange; ctx.globalAlpha = 0.12; ctx.fillRect(a, T, e - a, ph); ctx.globalAlpha = 1;
      ctx.strokeStyle = this.c.orange; ctx.strokeRect(a + 0.5, T + 0.5, e - a, ph);
    }

    // crosshair
    if (this.hoverX !== null && this.hoverX >= x0 && this.hoverX <= x1) {
      const px = Math.round(sx(this.hoverX)) + 0.5;
      ctx.strokeStyle = this.c.ink; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke(); ctx.globalAlpha = 1;
      const rows2 = [];
      for (const s of this.series) {
        if (!s.visible || !s.n || s.style === "points") continue;
        const v = this.valueAt(s, this.hoverX);
        if (v === null) continue;
        const py = sy(v, s.axis);
        ctx.fillStyle = this.resolveColor(s.color);
        ctx.beginPath(); ctx.arc(sx(this.hoverX), py, 3.5, 0, Math.PI * 2); ctx.fill();
        rows2.push([s, v]);
      }
      if (this.o.tooltip && this.hoverSrc === this && rows2.length) this._tooltip(rows2, px);
      else this.tip.classList.add("hidden");
    } else this.tip.classList.add("hidden");
  }

  _tooltip(rows, px) {
    const xLabel = this.o.xFormat ? this.o.xFormat(this.hoverX) : `${this.o.xLabel.replace(/\s*\(.*\)/, "") || "x"} ${this.hoverX.toFixed(2)} ${this.o.xUnit || ""}`;
    this.tip.innerHTML = "";
    this.tip.append(h("div", { style: { color: "var(--graphite)", marginBottom: "3px" } }, xLabel));
    for (const [s, v] of rows) {
      const val = s.format ? s.format(v) : v.toFixed(s.digits);
      this.tip.append(h("div", null, h("span", { class: "sw", style: { background: this.resolveColor(s.color) } }), `${s.label}: `, h("b", null, val), s.unit ? ` ${s.unit}` : ""));
    }
    this.tip.classList.remove("hidden");
    const tw = this.tip.offsetWidth;
    const left = px + 14 + tw > this.W - 4 ? px - 14 - tw : px + 14;
    this.tip.style.left = `${Math.max(4, left)}px`;
    this.tip.style.top = `${this.T + 6}px`;
  }

  valueAt(s, x) {
    if (!s.n) return null;
    const i = lowerBound(s.x, x, s.n);
    if (i <= 0) return s.x[0] - x > (s.x[1] - s.x[0] || 1) * 3 ? null : s.y[0];
    if (i >= s.n) return x - s.x[s.n - 1] > (s.x[s.n - 1] - s.x[s.n - 2] || 1) * 3 ? null : s.y[s.n - 1];
    const xa = s.x[i - 1], xb = s.x[i], ya = s.y[i - 1], yb = s.y[i];
    if (!Number.isFinite(ya) || !Number.isFinite(yb)) return Number.isFinite(ya) ? ya : Number.isFinite(yb) ? yb : null;
    if (s.style === "step") return ya;
    return ya + ((yb - ya) * (x - xa)) / (xb - xa || 1);
  }

  _finishRange(r, includeZero, fixed) {
    if (fixed) return fixed;
    let [a, b] = r;
    if (!Number.isFinite(a)) { a = 0; b = 1; }
    if (includeZero) { a = Math.min(a, 0); b = Math.max(b, 0); }
    if (b - a < 1e-9) { const m = Math.abs(a) * 0.05 || 1; a -= m; b += m; }
    const pad = (b - a) * 0.06;
    return [a - (a === 0 && includeZero ? 0 : pad), b + pad];
  }

  // returns flat [x,y,x,y...] of visible points, decimated to ~2 per pixel
  _visiblePoints(s, x0, x1, pw) {
    const out = [];
    if (s.style === "points") {
      for (let i = 0; i < s.n; i++) { const x = s.x[i]; if (x >= x0 && x <= x1) out.push(x, s.y[i]); }
      return out;
    }
    let i0 = Math.max(0, lowerBound(s.x, x0, s.n) - 1);
    let i1 = Math.min(s.n, lowerBound(s.x, x1, s.n) + 1);
    const count = i1 - i0;
    if (count <= pw * 2.5) { for (let i = i0; i < i1; i++) out.push(s.x[i], s.y[i]); return out; }
    const bw = (x1 - x0) / pw;
    let bucket = -1, mn = Infinity, mx = -Infinity, xmn = 0, xmx = 0, gap = false;
    const flush = () => {
      if (bucket < 0) return;
      if (mn === Infinity) { if (gap) out.push(x0 + bucket * bw, NaN); return; }
      if (xmn <= xmx) out.push(xmn, mn, xmx, mx); else out.push(xmx, mx, xmn, mn);
    };
    for (let i = i0; i < i1; i++) {
      const x = s.x[i], y = s.y[i];
      const b = Math.floor((x - x0) / bw);
      if (b !== bucket) { flush(); bucket = b; mn = Infinity; mx = -Infinity; gap = false; }
      if (!Number.isFinite(y)) { gap = true; continue; }
      if (y < mn) { mn = y; xmn = x; }
      if (y > mx) { mx = y; xmx = x; }
    }
    flush();
    return out;
  }

  _bind() {
    const cv = this.canvas;
    cv.style.touchAction = "none";
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("pointermove", (e) => {
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left;
      if (this.drag) {
        if (this.drag.mode === "zoom") { this.drag.px1 = px; this.redraw(); }
        else {
          const dx = this.xinv(this.drag.px0) - this.xinv(px);
          this._setView({ x0: this.drag.v0[0] + dx, x1: this.drag.v0[1] + dx });
        }
      }
      if (!this.xinv || px < this.L || px > this.W - this.R) { this.group ? this.group.hover(null, this) : (this.hoverX = null, this.redraw()); return; }
      const x = this.xinv(px);
      if (this.group) this.group.hover(x, this); else { this.hoverX = x; this.hoverSrc = this; this.redraw(); }
    });
    cv.addEventListener("pointerleave", () => { if (this.group) this.group.hover(null, this); else { this.hoverX = null; this.redraw(); } });
    cv.addEventListener("pointerdown", (e) => {
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left;
      cv.setPointerCapture(e.pointerId);
      const pan = e.shiftKey || e.button === 2 || e.button === 1;
      this.drag = { mode: pan ? "pan" : "zoom", px0: px, px1: px, v0: [this.x0, this.x1] };
    });
    cv.addEventListener("pointerup", (e) => {
      if (!this.drag) return;
      const d = this.drag; this.drag = null;
      if (d.mode === "zoom") {
        if (Math.abs(d.px1 - d.px0) > 6) {
          const a = this.xinv(Math.min(d.px0, d.px1)), b = this.xinv(Math.max(d.px0, d.px1));
          this._setView({ x0: a, x1: b });
        } else if (this.o.onClick && this.xinv) this.o.onClick(this.xinv(d.px0), e);
      }
      this.redraw();
    });
    cv.addEventListener("dblclick", () => this.resetView());
    cv.addEventListener("wheel", (e) => {
      if (!this.xinv) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const x = this.xinv(e.clientX - r.left);
      const k = Math.exp(Math.sign(e.deltaY) * 0.18);
      const [a, b] = [this.x0, this.x1];
      let na = x - (x - a) * k, nb = x + (b - x) * k;
      const [ea, eb] = this._extent();
      if (nb - na >= (eb - ea) * 1.02) { this.resetView(); return; }
      this._setView({ x0: na, x1: nb });
    }, { passive: false });
  }
}
