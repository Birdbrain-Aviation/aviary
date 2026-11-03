// A small offline-friendly slippy map: OpenStreetMap tiles through the app's
// local cache, markers, a track line, drag to pan, wheel to zoom.

import { h, cssVar } from "./ui.js";

const TILE = 256;
const R_EARTH = 6371008.8;

export function distanceBearing(a, b) {
  if (!a || !b) return null;
  const toR = Math.PI / 180;
  const [la1, lo1, la2, lo2] = [a[0] * toR, a[1] * toR, b[0] * toR, b[1] * toR];
  const dla = la2 - la1, dlo = lo2 - lo1;
  const s = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  const d = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  const y = Math.sin(dlo) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
  return { distance: d, bearing: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
}

export function compassName(deg) {
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return names[Math.round(deg / 22.5) % 16];
}

const project = (lat, lon, z) => {
  const s = TILE * 2 ** z;
  const sin = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
};
const unproject = (x, y, z) => {
  const s = TILE * 2 ** z;
  const lon = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return [(180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon];
};

export class TileMap {
  constructor(el, { lat = 0, lon = 0, zoom = 15 } = {}) {
    this.el = el;
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.style.overflow = "hidden"; el.style.background = "var(--panel-2)";
    this.tileLayer = h("div", { style: { position: "absolute", inset: "0" } });
    this.canvas = h("canvas", { style: { position: "absolute", inset: "0", width: "100%", height: "100%" } });
    this.zoomIn = h("button", { class: "btn icon small", "aria-label": "Zoom in", onclick: () => this.setZoom(this.zoom + 1) }, "+");
    this.zoomOut = h("button", { class: "btn icon small", "aria-label": "Zoom out", onclick: () => this.setZoom(this.zoom - 1) }, "−");
    this.status = h("div", { style: { position: "absolute", left: "8px", bottom: "8px", fontSize: "12px", color: "var(--graphite)", background: "var(--panel)", padding: "2px 6px", borderRadius: "3px", opacity: "0.92" } });
    const attr = h("div", { style: { position: "absolute", right: "4px", bottom: "2px", fontSize: "11px", color: "var(--graphite)", background: "var(--panel)", padding: "0 4px", opacity: "0.85" } }, "© OpenStreetMap contributors");
    const ctrls = h("div", { style: { position: "absolute", right: "8px", top: "8px", display: "flex", flexDirection: "column", gap: "4px", zIndex: 2 } }, this.zoomIn, this.zoomOut);
    el.append(this.tileLayer, this.canvas, ctrls, this.status, attr);
    this.lat = lat; this.lon = lon; this.zoom = zoom;
    this.imgs = new Map();
    this.markers = []; this.tracks = [];
    this.failed = 0; this.loaded = 0;
    this._bind();
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(el);
    window.addEventListener("themechange", () => this.render());
  }

  setView(lat, lon, zoom = this.zoom) { this.lat = lat; this.lon = lon; this.zoom = Math.max(2, Math.min(19, Math.round(zoom))); this.render(); }
  setZoom(z) { this.setView(this.lat, this.lon, z); }
  setMarkers(m) { this.markers = m.filter((x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lon)); this._overlay(); }
  setTracks(t) { this.tracks = t; this._overlay(); }

  fit(points, maxZoom = 17) {
    const pts = points.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return;
    if (pts.length === 1) { this.setView(pts[0][0], pts[0][1], Math.max(this.zoom, 15)); return; }
    const W = this.el.clientWidth || 400, H = this.el.clientHeight || 300;
    for (let z = maxZoom; z >= 2; z--) {
      const xy = pts.map((p) => project(p[0], p[1], z));
      const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
      if (Math.max(...xs) - Math.min(...xs) < W - 80 && Math.max(...ys) - Math.min(...ys) < H - 80) {
        const c = unproject((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, z);
        this.setView(c[0], c[1], z); return;
      }
    }
  }

  _origin() {
    const [cx, cy] = project(this.lat, this.lon, this.zoom);
    return [cx - this.el.clientWidth / 2, cy - this.el.clientHeight / 2];
  }

  render() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const [ox, oy] = this._origin();
    const z = this.zoom, n = 2 ** z;
    const want = new Set();
    for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W) / TILE); tx++) {
      for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const key = `${z}/${wx}/${ty}/${tx}`;
        want.add(key);
        let img = this.imgs.get(key);
        if (!img) {
          img = h("img", { alt: "", draggable: false, style: { position: "absolute", width: TILE + "px", height: TILE + "px", userSelect: "none", filter: "var(--map-filter, none)" } });
          img.onload = () => { this.loaded++; this._status(); };
          img.onerror = () => { img.style.visibility = "hidden"; this.failed++; this._status(); };
          img.src = `/tiles/${z}/${wx}/${ty}.png`;
          this.imgs.set(key, img);
          this.tileLayer.append(img);
        }
        img.style.left = Math.round(tx * TILE - ox) + "px";
        img.style.top = Math.round(ty * TILE - oy) + "px";
      }
    }
    for (const [k, img] of this.imgs) if (!want.has(k)) { img.remove(); this.imgs.delete(k); }
    this._overlay();
  }

  _status() {
    this.status.textContent = this.failed > 0 && this.loaded === 0 ? "Map tiles aren't available offline here. Distance and bearing still work." : "";
    this.status.style.display = this.status.textContent ? "block" : "none";
  }

  _overlay() {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== W * dpr) { this.canvas.width = W * dpr; this.canvas.height = H * dpr; }
    const c = this.canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const [ox, oy] = this._origin();
    const px = (lat, lon) => { const [x, y] = project(lat, lon, this.zoom); return [x - ox, y - oy]; };
    for (const tr of this.tracks) {
      const pts = tr.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length < 2) continue;
      c.strokeStyle = tr.color?.startsWith("--") ? cssVar(tr.color) : tr.color || cssVar("--d-alt");
      c.lineWidth = tr.width || 2.5; c.setLineDash(tr.dash || []);
      c.beginPath();
      pts.forEach((p, i) => { const [x, y] = px(p[0], p[1]); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke(); c.setLineDash([]);
    }
    c.font = `600 13px ${cssVar("--font")}`;
    for (const m of this.markers) {
      const [x, y] = px(m.lat, m.lon);
      const col = m.color?.startsWith("--") ? cssVar(m.color) : m.color || cssVar("--orange");
      c.fillStyle = col; c.strokeStyle = cssVar("--panel"); c.lineWidth = 2.5;
      c.beginPath();
      if (m.kind === "rocket") { c.moveTo(x, y - 11); c.lineTo(x + 8, y + 7); c.lineTo(x, y + 3); c.lineTo(x - 8, y + 7); c.closePath(); }
      else if (m.kind === "station") { c.rect(x - 6, y - 6, 12, 12); }
      else c.arc(x, y, 6, 0, Math.PI * 2);
      c.stroke(); c.fill();
      if (m.label) {
        const w = c.measureText(m.label).width;
        c.fillStyle = cssVar("--panel"); c.globalAlpha = 0.9; c.fillRect(x + 11, y - 9, w + 8, 18); c.globalAlpha = 1;
        c.fillStyle = cssVar("--ink"); c.textBaseline = "middle"; c.fillText(m.label, x + 15, y);
      }
    }
  }

  _bind() {
    let drag = null;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      drag = { x: e.clientX, y: e.clientY, lat: this.lat, lon: this.lon };
      this.el.setPointerCapture(e.pointerId);
      this.onUserMove && this.onUserMove();
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const [cx, cy] = project(drag.lat, drag.lon, this.zoom);
      const [lat, lon] = unproject(cx - (e.clientX - drag.x), cy - (e.clientY - drag.y), this.zoom);
      this.lat = lat; this.lon = lon; this.render();
    });
    this.el.addEventListener("pointerup", () => { drag = null; });
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const [ox, oy] = this._origin();
      const [la, lo] = unproject(ox + mx, oy + my, this.zoom);
      const nz = Math.max(2, Math.min(19, this.zoom + (e.deltaY < 0 ? 1 : -1)));
      if (nz === this.zoom) return;
      const [px2, py2] = project(la, lo, nz);
      const [clat, clon] = unproject(px2 - mx + this.el.clientWidth / 2, py2 - my + this.el.clientHeight / 2, nz);
      this.onUserMove && this.onUserMove();
      this.setView(clat, clon, nz);
    }, { passive: false });
  }
}
