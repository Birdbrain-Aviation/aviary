// Flight animation: replays a flight as a rocket climbing through the sky,
// with motor flame and smoke while burning, parachutes opening at their
// deployment times, an altitude ruler, live readouts and an altitude profile
// with a playhead. Used by Heron (logs) and Mockingbird (test runs).
//
//   const anim = new FlightAnimation(el, { units: display("imperial"), name: "Flight" });
//   anim.setData({ t, h, v, phases, events });   // t: s from liftoff, h: m above ground, v: m/s up
//   anim.setData(sameButLonger, { live: true }); // keeps following the newest sample
//
// phases: [{ phase, t0, t1 }] with phase one of pad, boost, coast, descent
// (free fall), drogue, main, landed. events: [{ t, label, kind }].
// For the 3D view also pass east and north (metres from the pad, per sample)
// and geo: { lat, lon } of the pad, which places the terrain.

import { h, cssVar, download, seg } from "./ui.js";
import { OrbitCamera, TerrainRenderer, loadTerrain, loadMapTexture, groundAt } from "./flight3d.js";

const SPEEDS = [["auto", "Auto"], ["1", "1×"], ["2", "2×"], ["5", "5×"], ["10", "10×"], ["25", "25×"]];
const PHASE_NAME = { pad: "On the pad", boost: "Motor burning", coast: "Coasting", descent: "Free fall", drogue: "Under drogue", main: "Under main", landed: "Landed" };
const LEAN = 0.06; // how far the rocket leans into the wind, for show

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);
// steady pseudo-random number from a seed, so smoke looks the same when scrubbing
const hash = (x) => { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export class FlightAnimation {
  constructor(el, o = {}) {
    this.el = el;
    this.D = o.units;
    this.name = o.name || "Flight";
    this.d = null;
    this.tp = 0;           // playhead, s from liftoff
    this.playing = false;
    this.speed = o.speed || "auto";
    this.follow = false;   // live: stay on the newest sample
    this.top = 60;         // shown altitude at the top of the scene (eased)
    this.recording = null;

    this.canvas = h("canvas", { class: "fv-canvas", tabindex: 0, "aria-label": "Flight animation" });
    this.playBtn = h("button", { class: "btn small primary fv-play", onclick: () => this.toggle(), title: "Play or pause (space)" }, "Play");
    this.restartBtn = h("button", { class: "btn small", onclick: () => { this.seek(this.t0()); this.play(); }, title: "Back to the pad and play" }, "Restart");
    this.speedSel = h("select", { class: "fv-speed", "aria-label": "Playback speed", onchange: () => { this.speed = this.speedSel.value; this._lastFrame = null; } },
      SPEEDS.map(([v, l]) => h("option", { value: v, selected: v === this.speed }, l)));
    this.slider = h("input", { type: "range", class: "fv-slider", min: 0, max: 1, step: 0.01, value: 0, "aria-label": "Flight time",
      oninput: () => { this.follow = false; this.seek(Number(this.slider.value)); } });
    this.slider.addEventListener("pointerdown", () => { this._sliding = true; });
    window.addEventListener("pointerup", this._unslide = () => { this._sliding = false; });
    this.timeLbl = h("span", { class: "fv-time mono" }, "–");
    this.liveBtn = h("button", { class: "btn small hidden", onclick: () => { this.follow = true; this.seek(this.t1()); }, title: "Jump to the newest data" }, "Live");
    this.recBtn = h("button", { class: "btn small", onclick: () => this.record(), title: "Play the whole flight and save it as a video file" }, "Save video");
    this.view = "2d";
    this.viewSeg = seg([["2d", "2D"], ["3d", "3D"]], this.view, (v) => this.setView(v));
    this.viewSeg.classList.add("hidden");
    this.groundSeg = seg([["contours", "Contours"], ["map", "Map"]], "contours", (v) => { this.g3.map = v === "map"; if (this.g3.map) this._loadMap(); this._dirty = true; });
    this.followBtn = h("button", { class: "btn small", onclick: () => this._toggleFollow(), title: "Follow the rocket, or show the whole flight" }, "Whole flight");
    this.g3box = h("span", { class: "fv-3d hidden" }, this.groundSeg, this.followBtn);
    const bar = h("div", { class: "fv-bar" }, this.playBtn, this.restartBtn,
      h("label", { class: "fv-lbl" }, "Speed", this.speedSel), this.slider, this.timeLbl, this.liveBtn, this.viewSeg, this.g3box, this.recBtn);
    this.root = h("div", { class: "flightviz" }, h("div", { class: "fv-stage" }, this.canvas), bar);
    el.append(this.root);

    this.canvas.addEventListener("keydown", (e) => {
      if (e.key === " ") { e.preventDefault(); this.toggle(); }
      else if (e.key === "ArrowRight") { this.follow = false; this.seek(this.tp + 1); }
      else if (e.key === "ArrowLeft") { this.follow = false; this.seek(this.tp - 1); }
      else if (e.key === "Home") this.seek(this.t0());
      else if (e.key === "End") this.seek(this.t1());
    });
    // clicking or dragging on the profile scrubs
    const scrub = (e) => {
      const p = this._prof; if (!p || !this.d) return false;
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < p.x - 6 || x > p.x + p.w + 6 || y < p.y - 6 || y > p.y + p.h + 18) return false;
      this.follow = false;
      this.seek(lerp(this.t0(), this.t1(), clamp((x - p.x) / p.w, 0, 1)));
      return true;
    };
    const inScene = (e) => { const s = this._sceneRect, r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return s && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h; };
    this.canvas.addEventListener("pointerdown", (e) => {
      if (scrub(e)) { this._drag = true; this.canvas.setPointerCapture(e.pointerId); return; }
      if (this.view === "3d" && inScene(e)) {
        this._orbit = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
        this.canvas.setPointerCapture(e.pointerId);
      }
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this._drag) { scrub(e); return; }
      const o = this._orbit; if (!o) return;
      const dx = e.clientX - o.x, dy = e.clientY - o.y; o.x = e.clientX; o.y = e.clientY;
      const cam = this.g3.cam;
      if (o.pan) {
        // move the target across the screen plane
        const k = cam.dist * 0.0016, ca = Math.cos(cam.az), sa = Math.sin(cam.az);
        cam.target = [cam.target[0] - (dx * ca) * k, cam.target[1] + dy * k, cam.target[2] + (dx * sa) * k];
        this._setFollow(false);
      } else { cam.az -= dx * 0.006; cam.el = clamp(cam.el + dy * 0.005, 0.03, 1.5); }
      this._dirty = true;
    });
    this.canvas.addEventListener("pointerup", () => { this._drag = false; this._orbit = null; });
    this.canvas.addEventListener("contextmenu", (e) => { if (this.view === "3d") e.preventDefault(); });
    this.canvas.addEventListener("wheel", (e) => {
      if (this.view !== "3d" || !inScene(e)) return;
      e.preventDefault();
      this.g3.cam.dist = clamp(this.g3.cam.dist * Math.exp(e.deltaY * 0.0012), 20, 60000); this._dirty = true;
    }, { passive: false });
    this.canvas.addEventListener("dblclick", (e) => { if (this.view === "3d" && inScene(e)) { this._setFollow(true); this._frame3d(true); } });

    window.addEventListener("themechange", this._retheme = () => { this._dirty = true; });
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(this.root);
    this._resize();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ---------------------------------------------------------------- data
  setData(d, { live = false } = {}) {
    const first = !this.d;
    const wasFollowing = !!(this.d?.live && this.follow);
    const n = d?.t?.length || 0;
    if (!n) { this.d = null; this._draw(); return; }
    // keep only finite samples in time order
    const t = [], hh = [], v = [], ee = [], nn = [];
    const has3 = !!(d.east && d.north);
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      const ti = d.t[i], hi = d.h[i];
      if (!Number.isFinite(ti) || !Number.isFinite(hi) || ti <= last) continue;
      t.push(ti); hh.push(hi); v.push(Number.isFinite(d.v?.[i]) ? d.v[i] : NaN); last = ti;
      if (has3) { ee.push(Number.isFinite(d.east[i]) ? d.east[i] : 0); nn.push(Number.isFinite(d.north[i]) ? d.north[i] : 0); }
    }
    if (!t.length) { this.d = null; this._draw(); return; }
    // vertical speed from altitude where none was given
    for (let i = 0; i < t.length; i++) if (!Number.isFinite(v[i])) {
      const a = Math.max(0, i - 2), b = Math.min(t.length - 1, i + 2);
      v[i] = b > a ? (hh[b] - hh[a]) / (t[b] - t[a]) : 0;
    }
    let maxH = 0, iMax = 0;
    const hiPrefix = new Float64Array(t.length);
    for (let i = 0; i < t.length; i++) { if (hh[i] > maxH) { maxH = hh[i]; iMax = i; } hiPrefix[i] = maxH; }
    // while a live run is still climbing, the highest point so far is not apogee yet
    const apogeeKnown = !live || hh[t.length - 1] < maxH - Math.max(1, 0.01 * maxH);
    const phases = (d.phases || []).filter((p) => p.t1 > p.t0).slice().sort((a, b) => a.t0 - b.t0);
    const events = (d.events || []).filter((e) => Number.isFinite(e.t)).slice().sort((a, b) => a.t - b.t);
    const burns = phases.filter((p) => p.phase === "boost");
    let maxSpeed = 1;
    for (let i = 0; i < t.length; i++) if (Math.abs(v[i]) > maxSpeed) maxSpeed = Math.abs(v[i]);
    let tRail = 0;
    for (let i = 0; i < t.length; i++) if (t[i] >= 0 && hh[i] > 2.5) { tRail = t[i]; break; }
    // 3D extent: furthest the rocket got from the pad, sideways
    let maxR = 0, lastE = 0, lastN = 0;
    if (has3) for (let i = 0; i < t.length; i++) { const r = Math.hypot(ee[i], nn[i]); if (r > maxR) maxR = r; lastE = ee[i]; lastN = nn[i]; }
    this.d = { t, h: hh, v, maxH, apogee: { t: apogeeKnown ? t[iMax] : Infinity, h: maxH }, tRail, maxSpeed, hiPrefix, phases, events, burns, live,
      e: has3 ? ee : null, n: has3 ? nn : null, maxR, drift: [lastE, lastN], geo: d.geo || null };
    this.viewSeg.classList.toggle("hidden", !has3);
    if (!has3 && this.view === "3d") this.setView("2d");
    if (this.view === "3d") this._ensureTerrain();
    this.slider.min = this.t0(); this.slider.max = this.t1();
    this.liveBtn.classList.toggle("hidden", !live);
    if (live) {
      if (first) this.follow = true;
      if (this.recording && this.follow) this.playing = true;
      if (this.follow) this.tp = this.t1();
    } else {
      this.follow = false;
      if (wasFollowing) this.tp = this.t1();                  // a live run just ended: stay on its last moment
      else if (first || this.tp > this.t1()) this.tp = this.t0();
      if (this.recording && this.tp >= this.t1() - 1e-6) { this.pause(); this._stopRecording(); }
    }
    this.tp = clamp(this.tp, this.t0(), this.t1());
    if (first) this.top = this._targetTop(this.tp);
    this._dirty = true;
  }

  setUnits(D) { this.D = D; this._dirty = true; }

  t0() { return this.d ? Math.max(this.d.t[0], Math.min(-2, this.d.t[this.d.t.length - 1])) : 0; }
  t1() { return this.d ? this.d.t[this.d.t.length - 1] : 0; }

  _idx(t) {
    const T = this.d.t;
    let lo = 0, hi = T.length - 1;
    if (t <= T[0]) return 0;
    if (t >= T[hi]) return hi - 1 < 0 ? 0 : hi - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    return lo;
  }
  _at(arr, t) {
    const T = this.d.t;
    if (T.length === 1) return arr[0];
    const i = this._idx(t), k = clamp((t - T[i]) / (T[i + 1] - T[i] || 1), 0, 1);
    return lerp(arr[i], arr[i + 1], k);
  }
  hAt(t) { return Math.max(0, this._at(this.d.h, t)); }
  vAt(t) { return this._at(this.d.v, t); }

  // phase at time t, with the time it started
  phaseAt(t) {
    const P = this.d.phases;
    for (let i = P.length - 1; i >= 0; i--) if (t >= P[i].t0 && (t < P[i].t1 || i === P.length - 1)) return { phase: P[i].phase, t0: P[i].t0 };
    // no phases given: guess from the motion
    if (t < 0) return { phase: "pad", t0: this.t0() };
    if (t < this.d.apogee.t) return { phase: "coast", t0: 0 };
    return { phase: this.hAt(t) < 1 && t > this.d.apogee.t + 2 ? "landed" : "descent", t0: this.d.apogee.t };
  }
  firstPhase(name) { return this.d.phases.find((p) => p.phase === name); }

  // ---------------------------------------------------------------- 3D
  setView(v) {
    if (v === "3d" && !this.d?.e) v = "2d";
    this.view = v;
    this.viewSeg.set(v);
    this.g3box.classList.toggle("hidden", v !== "3d");
    if (v === "3d") {
      if (!this.g3) {
        let renderer = null;
        try { renderer = new TerrainRenderer(); } catch (e) { console.warn(e); }
        this.g3 = { cam: new OrbitCamera(), renderer: renderer && renderer.ok ? renderer : null, follow: true, map: false, terrain: null, key: "", status: "", E: 0 };
      }
      this._ensureTerrain();
      this._frame3d(true);
    }
    this._dirty = true;
  }

  _setFollow(on) { this.g3.follow = on; this.followBtn.textContent = on ? "Whole flight" : "Follow rocket"; }
  _toggleFollow() { this._setFollow(!this.g3.follow); this._frame3d(true); this._dirty = true; }

  // camera distance and target for the current mode
  _frame3d(snap) {
    const g = this.g3, d = this.d; if (!g || !d) return;
    const span = Math.max(150, d.maxH, d.maxR * 1.4);
    if (g.follow) { g.cam.dist = clamp(Math.max(160, d.maxH * 0.9, d.maxR), 160, 30000); }
    else {
      let x0 = 0, x1 = 0, z0 = 0, z1 = 0;
      for (let i = 0; i < d.t.length; i++) { x0 = Math.min(x0, d.e[i]); x1 = Math.max(x1, d.e[i]); z0 = Math.min(z0, -d.n[i]); z1 = Math.max(z1, -d.n[i]); }
      g.cam.target = [(x0 + x1) / 2, d.maxH * 0.45, (z0 + z1) / 2];
      g.cam.dist = span * 1.7;
    }
    if (snap) this._snap3 = true;
  }

  async _ensureTerrain() {
    const d = this.d, g = this.g3; if (!d || !g || !d.e) return;
    // terrain square: grows in steps so a live run doesn't reload it constantly
    const need = Math.max(700, d.maxR * 1.4, d.maxH * 0.6);
    let E = 1000; while (E < need && E < 8000) E *= 2;
    E = Math.max(E, g.E || 0);
    const geo = d.geo;
    const key = geo ? `${geo.lat.toFixed(5)},${geo.lon.toFixed(5)},${E}` : `flat,${E}`;
    if (key === g.key) return;
    g.key = key; g.E = E; g.mapCanvas = null; g.grid = niceStep(E / 6, 1);
    if (!geo) { g.terrain = { N: 2, E, h: new Float32Array(4), ok: false }; g.status = "Flat ground: no launch site position in this data"; g.renderer?.setTerrain(g.terrain); this._dirty = true; return; }
    g.status = "Loading terrain…"; this._dirty = true;
    const T = await loadTerrain(geo.lat, geo.lon, E).catch(() => ({ ok: false, N: 2, E, h: new Float32Array(4), why: "couldn't load elevation" }));
    if (g.key !== key) return;
    g.terrain = T.ok ? T : { N: 2, E, h: new Float32Array(4), ok: false };
    g.renderer?.setTerrain(g.terrain);
    g.status = T.ok ? (T.partial ? "Part of the terrain isn't saved for offline use" : "") : `Flat ground: ${T.why}. Open Owl at this site with internet, or use Save area for offline.`;
    if (g.map) this._loadMap();
    this._dirty = true;
  }

  async _loadMap() {
    const d = this.d, g = this.g3; if (!d?.geo || !g || g.mapCanvas !== null && g.mapKey === g.key) return;
    const key = g.key; g.mapKey = key;
    const cv = await loadMapTexture(d.geo.lat, d.geo.lon, g.E).catch(() => null);
    if (g.key !== key) return;
    g.mapCanvas = cv;
    g.renderer?.setMap(cv);
    if (!cv) g.status = "The map for this site isn't saved for offline use";
    this._dirty = true;
  }

  // position in 3D: x east, y up, z south
  _pos3(t) { const d = this.d; return [this._at(d.e, t), this.hAt(t), -this._at(d.n, t)]; }

  // ---------------------------------------------------------------- playback
  play() {
    if (!this.d) return;
    if (this.tp >= this.t1() - 1e-6 && !this.d.live) this.tp = this.t0();
    this.playing = true; this._lastFrame = null; this.follow = false;
    this.playBtn.textContent = "Pause";
  }
  pause() { this.playing = false; this.playBtn.textContent = "Play"; this._dirty = true; }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) { if (!this.d) return; this.tp = clamp(t, this.t0(), this.t1()); this._snap = true; this._draw(); }

  // Auto speed: real time around the moments that matter (burns, apogee,
  // deployments), faster in between, so a flight plays in about 40 seconds.
  _rate(t) {
    if (this.speed !== "auto") return Number(this.speed);
    const d = this.d, dur = this.t1() - this.t0();
    const base = clamp(dur / 40, 1, 40);
    const near = (a, b, pad) => t >= a - pad && t <= b + pad;
    if (t < 0.2 && t > this.t0()) return Math.min(base, 1.5);
    for (const b of d.burns) if (near(b.t0, b.t1, 0.6)) return 1;
    if (near(d.apogee.t, d.apogee.t, 1.2)) return Math.min(base, 1.5);
    for (const p of d.phases) if ((p.phase === "drogue" || p.phase === "main") && near(p.t0, p.t0, 1.2)) return Math.min(base, 1.5);
    const land = this.firstPhase("landed");
    if (land && near(land.t0, land.t0, 1)) return Math.min(base, 1.5);
    return base;
  }

  _loop(now) {
    if (!this.root.isConnected) { this.destroy(); return; }
    this._raf = requestAnimationFrame(this._loop);
    if (this.d && this.playing) {
      const dt = this._lastFrame == null ? 0 : Math.min(0.1, (now - this._lastFrame) / 1000);
      this.tp += dt * this._rate(this.tp);
      if (this.tp >= this.t1()) {
        this.tp = this.t1();
        if (this.d.live && this.recording) this.follow = true;      // keep recording as data arrives
        else if (this.d.live) { this.follow = true; this.pause(); }
        else { this.pause(); if (this.recording) this._stopRecording(); }
      }
    }
    this._lastFrame = now;
    if (this.root.offsetParent === null) return;               // hidden: nothing to draw
    const easing = this.d && (this.view === "3d" ? !!this._moving3 : Math.abs(Math.log(this._targetTop(this.tp) / this.top)) > 0.004);
    const flame = this.d && this.phaseAt(this.tp).phase === "boost";
    if (this.playing || this._dirty || easing || flame || this.recording) { this._dirty = false; this._draw(now); }
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this.ro?.disconnect();
    window.removeEventListener("themechange", this._retheme);
    window.removeEventListener("pointerup", this._unslide);
    if (this.recording) { try { this.recording.rec.stop(); } catch { /* */ } }
  }

  // ---------------------------------------------------------------- video
  record() {
    if (!this.d) return;
    if (this.recording) { this._stopRecording(); return; }
    if (!this.canvas.captureStream || typeof MediaRecorder === "undefined") { alert("This window can't record video."); return; }
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const stream = this.canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      download(`${this.name.replace(/[\\/:*?"<>|]+/g, "_")} animation.webm`, new Blob(chunks, { type: "video/webm" }));
      this.recBtn.textContent = "Save video"; this.recBtn.classList.remove("danger");
    };
    this.recording = { rec };
    this.recBtn.textContent = "Stop recording"; this.recBtn.classList.add("danger");
    this.seek(this.t0());
    rec.start(250);
    this.play();
  }
  _stopRecording() {
    const r = this.recording; this.recording = null;
    if (r && r.rec.state !== "inactive") setTimeout(() => r.rec.stop(), 400); // hold the last frame briefly
  }

  // ---------------------------------------------------------------- drawing
  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(200, Math.floor(r.width)); this.H = Math.max(200, Math.floor(r.height));
    this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
    this.canvas.style.width = this.W + "px"; this.canvas.style.height = this.H + "px";
    this.dpr = dpr;
    this._dirty = true;
    this._draw();
  }

  _targetTop(t) {
    const hNow = this.d ? this.hAt(t) : 0;
    const want = Math.max(40, hNow * 1.45);
    return niceStep(want, 1) * Math.ceil(want / niceStep(want, 1));
  }

  _draw(now = performance.now()) {
    const c = this.canvas.getContext("2d");
    if (!c || !this.W) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const W = this.W, H = this.H;
    const C = { panel: cssVar("--panel") || "#fbfcfb", ink: cssVar("--ink") || "#16202a", graphite: cssVar("--graphite") || "#56626c", faint: cssVar("--faint") || "#8a959d",
      rule: cssVar("--rule") || "#cdd5d8", panel2: cssVar("--panel-2") || "#f4f6f5", ruleStrong: cssVar("--rule-strong") || "#aab5ba", orange: cssVar("--orange") || "#ff5a1f", fault: cssVar("--fault") || "#c8242f", font: cssVar("--font") || "sans-serif", mono: cssVar("--mono") || "monospace" };
    this.C = C;
    const night = document.documentElement.dataset.theme === "night";
    c.fillStyle = C.panel; c.fillRect(0, 0, W, H);
    if (!this.d) {
      c.fillStyle = C.graphite; c.font = `15px ${C.font}`; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText("No flight to show yet.", W / 2, H / 2);
      this.timeLbl.textContent = "–";
      return;
    }
    // layout: scene on the left, readouts and profile on the right; stacked when narrow
    const wide = W >= 720;
    const scene = wide ? { x: 0, y: 0, w: Math.round(Math.max(320, W * 0.56)), h: H } : { x: 0, y: 0, w: W, h: Math.max(180, H - 200) };
    const side = wide ? { x: scene.w, y: 0, w: W - scene.w, h: H } : { x: 0, y: scene.h, w: W, h: H - scene.h };

    // ease the camera towards the altitude span that fits the rocket
    const target = this._targetTop(this.tp);
    if (this._snap || Math.abs(Math.log(target / this.top)) > 1.2) this.top = target;
    else this.top = lerp(this.top, target, 0.06);
    this._snap = false;

    this._sceneRect = scene;
    if (this.view === "3d" && this.g3) this._scene3d(c, scene, night, now); else this._scene(c, scene, night, now);
    this._side(c, side, wide);

    const T = this.tp;
    this.timeLbl.textContent = `T${T < 0 ? "−" : "+"}${Math.abs(T).toFixed(1)} s / ${this.t1().toFixed(1)} s`;
    if (!this._sliding) this.slider.value = T;
  }

  // Horizontal position of the rocket in screen pixels from the pad. Purely
  // for show: it leans a little into the wind going up and drifts downwind
  // coming down. Scaled with altitude so it always stays in view.
  _xPx(t, k, S) {
    const d = this.d, tA = d.apogee.t, h = this.hAt(t);
    let x = -LEAN * h * k;                                   // upwind on the way up
    if (Number.isFinite(tA) && t > tA) {
      const land = this.firstPhase("landed");
      const tt = land ? Math.min(t, land.t0) : t;
      x = -LEAN * h * k + S.w * 0.2 * ease((tt - tA) / 25); // downwind on the way down
    }
    return clamp(x, -S.w * 0.36, S.w * 0.36);
  }

  // Attitude in radians, nose up = 0, negative = nose upwind (left).
  _angle(t, phase, pt0, v) {
    const d = this.d, since = t - pt0;
    const lean = -Math.atan(LEAN * 1.6);
    if (phase === "pad" || t < d.tRail) return 0;
    if (phase === "boost" || phase === "coast") {
      // weathercock off the rail: swing into the wind, overshoot, settle
      const dt = t - d.tRail;
      let a = lean * (1 - Math.exp(-dt / 0.45) * Math.cos(dt * 6.5)) + Math.sin(t * 5.3) * 0.004;
      // arc over near apogee
      if (v < 25 && t < d.apogee.t + 0.5) a = lerp(a, -Math.PI / 2, ease(1 - Math.max(0, v) / 25));
      return a;
    }
    if (phase === "descent") return -Math.PI / 2 - ease(since / 1.6) * 0.9 + Math.sin(t * 2.7) * 0.18;
    if (phase === "drogue" || phase === "main") return lerp(-Math.PI / 2, -Math.PI * 0.44, ease(since / 2)) + Math.sin(t * 1.3) * 0.05;
    if (phase === "landed") return -Math.PI / 2;
    return 0;
  }

  _scene(c, S, night, now) {
    const D = this.D, d = this.d, T = this.tp, C = this.C;
    const groundPx = 30;
    const y0 = S.y + S.h - groundPx;                 // screen y of the ground
    const k = (y0 - S.y - 30) / this.top;             // px per metre
    const Y = (alt) => y0 - alt * k;
    const cx = S.x + S.w * 0.5;
    c.save();
    c.beginPath(); c.rect(S.x, S.y, S.w, S.h); c.clip();
    c.fillStyle = C.panel; c.fillRect(S.x, S.y, S.w, S.h);

    // altitude grid
    const unitM = D.altUnit === "ft" ? 0.3048 : 1;
    const stepU = niceStep(this.top / unitM, Math.max(3, Math.floor((y0 - S.y) / 80)));
    c.font = `10.5px ${C.mono}`; c.textAlign = "left"; c.textBaseline = "bottom";
    for (let a = stepU; a * unitM <= this.top * 1.02; a += stepU) {
      const yy = Math.round(Y(a * unitM)) + 0.5;
      c.strokeStyle = C.rule; c.lineWidth = 1; c.globalAlpha = 0.7;
      c.beginPath(); c.moveTo(S.x, yy); c.lineTo(S.x + S.w, yy); c.stroke();
      c.globalAlpha = 1;
      c.fillStyle = C.faint;
      c.fillText(`${Math.round(a).toLocaleString()} ${D.altUnit}`, S.x + 10, yy - 3);
    }

    // apogee line once it has been reached
    if (T >= d.apogee.t) {
      const ya = Math.round(Y(d.apogee.h)) + 0.5;
      if (ya > S.y + 14) {
        c.strokeStyle = C.orange; c.lineWidth = 1; c.setLineDash([5, 4]);
        c.beginPath(); c.moveTo(S.x, ya); c.lineTo(S.x + S.w, ya); c.stroke(); c.setLineDash([]);
        c.font = `600 11.5px ${C.font}`; c.textAlign = "right"; c.textBaseline = "bottom";
        c.fillStyle = C.orange; c.fillText(`APOGEE  ${D.fmtAlt(d.apogee.h)} ${D.altUnit}`, S.x + S.w - 12, ya - 4);
      }
    }

    // ground: one line with drawing-style hatching under it
    c.fillStyle = C.panel; c.fillRect(S.x, y0, S.w, groundPx);
    c.strokeStyle = C.rule; c.lineWidth = 1;
    c.beginPath();
    for (let x = S.x - groundPx; x < S.x + S.w; x += 9) { c.moveTo(x, y0 + groundPx); c.lineTo(x + groundPx * 0.6, y0 + 1); }
    c.stroke();
    c.strokeStyle = C.ink; c.lineWidth = 1.25;
    c.beginPath(); c.moveTo(S.x, y0 + 0.5); c.lineTo(S.x + S.w, y0 + 0.5); c.stroke();
    // pad and rail
    c.lineWidth = 1.25;
    c.beginPath(); c.moveTo(cx - 18, y0 - 0.5); c.lineTo(cx - 12, y0 - 5); c.lineTo(cx + 12, y0 - 5); c.lineTo(cx + 18, y0 - 0.5); c.stroke();
    const railPx = clamp(2.5 * k, 8, 60);
    c.beginPath(); c.moveTo(cx - 6, y0 - 5); c.lineTo(cx - 6, y0 - 5 - railPx); c.stroke();

    const { phase, t0: pt0 } = this.phaseAt(T);
    const hNow = this.hAt(T), vNow = this.vAt(T);
    const L = 50; // rocket length in px
    const rx = cx + this._xPx(T, k, S);
    // rocket centre: nozzle at the flight altitude, resting on the pad before launch
    const ry = phase === "landed" ? y0 - 11 : Math.min(Y(hNow), y0 - 5) - L / 2;
    const ang = this._angle(T, phase, pt0, vNow);

    // exhaust: gray clouds left along the path, drifting downwind and spreading
    const puff = this._puffer(c, night);
    for (const b of d.burns) {
      const life = 10, dt = Math.max(0.008, (b.t1 - b.t0) / 400);
      const from = Math.max(b.t0, T - life), to = Math.min(b.t1, T);
      for (let ts = Math.ceil(from / dt) * dt; ts <= to; ts += dt) {
        const age = T - ts, a = Math.pow(1 - age / life, 2) * 0.16;
        if (a <= 0.004) continue;
        const r = 4 + Math.sqrt(age) * 10;
        const tail = this._angle(ts, "boost", b.t0, this.vAt(ts));
        // nozzle position at the moment this puff left it
        const ex = cx + this._xPx(ts, k, S) - Math.sin(tail) * L * 0.5;
        const ey = Math.min(Y(this.hAt(ts)), y0 - 5) - L / 2 + Math.cos(tail) * L * 0.5 + 4;
        const px = ex + (hash(ts) - 0.5) * (2 + age * 5) + age * 5;
        const py = Math.min(ey + (hash(ts + 9) - 0.5) * 4 + age * 0.8, y0 - r * 0.6);
        if (py < S.y - r) continue;
        // when zoomed far out many puffs land on the same pixels: thin them out
        const spacing = Math.abs(this.vAt(ts)) * k * dt;
        const every = Math.min(400, Math.ceil((r * 0.25) / Math.max(spacing, 1e-3)));
        if (Math.round(ts / dt) % every) continue;
        puff(px, py, r, a);
      }
    }
    // ignition cloud spreading along the ground
    const ig = d.burns[0];
    if (ig && T > ig.t0 - 0.2) {
      for (let i = 0; i < 26; i++) {
        const ts = ig.t0 - 0.2 + (i / 26) * 1.2;
        if (ts > T) break;
        const age = T - ts, a = Math.pow(Math.max(0, 1 - age / 14), 1.5) * 0.11;
        if (a <= 0.004) continue;
        const dir = i % 2 ? 1 : -1, r = 8 + Math.sqrt(age) * 10;
        puff(cx + dir * (6 + Math.sqrt(age) * 18 * (0.6 + hash(i))) + age * 3, y0 - r * 0.4, r, a);
      }
    }

    // parachute
    const deployed = phase === "drogue" || phase === "main" || (phase === "landed" && (this.firstPhase("main") || this.firstPhase("drogue")));
    if (deployed) {
      const isMain = phase === "main" || (phase === "landed" && !!this.firstPhase("main"));
      const since = T - pt0;
      if (phase === "landed") {
        // canopy collapsed on the ground beside the rocket
        c.fillStyle = isMain ? C.orange : C.panel; c.strokeStyle = C.ink; c.lineWidth = 1.1;
        c.beginPath(); c.moveTo(rx - 34, y0); c.quadraticCurveTo(rx - 56, y0 - 9, rx - 80, y0); c.closePath(); c.fill(); c.stroke();
        c.beginPath(); c.moveTo(rx - 22, y0 - 10); c.lineTo(rx - 36, y0 - 1); c.stroke();
      } else this._canopy(c, rx, ry - 3, isMain, ease(since / 0.9), T);
    }

    // the rocket
    c.save();
    c.translate(rx, ry);
    c.rotate(ang);
    this._rocket(c, L, phase === "boost", now, vNow);
    c.restore();

    // velocity arrow beside the rocket: points where it is going, grows with speed
    if (phase !== "landed" && phase !== "pad" && Math.abs(vNow) > 0.5) {
      const e = 0.05;
      const vx = (this._xPx(T + e, k, S) - this._xPx(T - e, k, S)) / (2 * e);   // px/s, the show drift
      const vy = -vNow * k;                                                      // px/s, up is negative
      const mag = Math.hypot(vx, vy);
      if (mag > 1e-6) {
        const ux = vx / mag, uy = vy / mag;
        const len = 12 + 72 * Math.sqrt(Math.min(1, Math.abs(vNow) / d.maxSpeed));
        const side = phase === "drogue" || phase === "main" || phase === "descent" ? 44 : 26;
        const ax = rx - side, ay = clamp(ry, S.y + len / 2 + 6, y0 - len / 2 - 6);
        this._arrow(c, ax, ay, ux, uy, len, `${D.fmtVel(Math.abs(vNow))} ${D.velUnit}`);
      }
    }

    // altitude tag with a short leader
    if (phase !== "landed" && phase !== "pad") {
      const ty = clamp(ry, S.y + 14, y0 - 14);
      const tx = rx + 28;
      c.strokeStyle = C.faint; c.lineWidth = 1;
      c.beginPath(); c.moveTo(rx + 12, ty); c.lineTo(tx - 4, ty); c.stroke();
      c.font = `600 11.5px ${C.mono}`; c.textAlign = "left"; c.textBaseline = "middle";
      c.fillStyle = C.ink; c.fillText(`${D.fmtAlt(hNow)} ${D.altUnit}`, tx, ty);
    }

    this._caption(c, S, T);
    c.restore();
  }

  // ---------------------------------------------------------------- 3D scene
  // Ground from WebGL, everything else as line art projected on top.
  _scene3d(c, S, night, now) {
    const D = this.D, d = this.d, T = this.tp, C = this.C, g = this.g3;
    const cam = g.cam;
    const P0 = this._pos3(T);
    // follow: ease the camera target towards the rocket
    const prev = cam.target.slice();
    if (g.follow) {
      const want = [P0[0], P0[1] + 8 / Math.max(1e-6, cam.frame(S.w, S.h).project(...P0)?.s || 1), P0[2]];
      const k = this._snap3 ? 1 : 0.12;
      cam.target = cam.target.map((v, i) => lerp(v, want[i], k));
    }
    this._snap3 = false;
    this._moving3 = Math.hypot(cam.target[0] - prev[0], cam.target[1] - prev[1], cam.target[2] - prev[2]) > 0.05 * Math.max(1, cam.dist / 500);

    const F = cam.frame(S.w, S.h, S.x, S.y);
    const P = F.project;
    c.save();
    c.beginPath(); c.rect(S.x, S.y, S.w, S.h); c.clip();
    const glc = g.renderer?.render(F.M, Math.max(2, Math.round(S.w * this.dpr)), Math.max(2, Math.round(S.h * this.dpr)), { panel: C.panel, panel2: C.panel2, ink: C.ink, night }, { map: g.map, grid: g.grid || 100 });
    if (glc) c.drawImage(glc, S.x, S.y, S.w, S.h);
    else { c.fillStyle = C.panel; c.fillRect(S.x, S.y, S.w, S.h); }
    const T3 = g.terrain;
    const ground = (x, z) => groundAt(T3, x, z);

    const line = (pts, style, width, dash) => {
      c.strokeStyle = style; c.lineWidth = width; c.setLineDash(dash || []); c.lineJoin = "round"; c.lineCap = "round";
      c.beginPath(); let pen = false;
      for (const p of pts) { if (!p) { pen = false; continue; } if (!pen) { c.moveTo(p.x, p.y); pen = true; } else c.lineTo(p.x, p.y); }
      c.stroke(); c.setLineDash([]);
    };
    // flight path: whole flight faint, flown part in ink, ground track dashed
    const n = d.t.length, stride = Math.max(1, Math.floor(n / 1500));
    const all = [], flown = [], track = [];
    for (let i = 0; i < n; i += stride) {
      const x = d.e[i], y = Math.max(0, d.h[i]), z = -d.n[i];
      const p = P(x, y, z);
      all.push(p); if (d.t[i] <= T) flown.push(p);
      track.push(P(x, ground(x, z) + 0.3, z));
    }
    flown.push(P(...P0));
    line(track, C.faint, 1, [3, 5]);
    line(all, C.ruleStrong, 1.2);
    line(flown, C.ink, 1.75);

    // pad
    const pad = P(0, ground(0, 0), 0);
    if (pad) { c.strokeStyle = C.ink; c.lineWidth = 1.25; c.beginPath(); c.moveTo(pad.x - 7, pad.y); c.lineTo(pad.x + 7, pad.y); c.moveTo(pad.x, pad.y - 4); c.lineTo(pad.x, pad.y + 4); c.stroke(); }

    // apogee mark
    if (T >= d.apogee.t) {
      const a = P(...this._pos3(d.apogee.t));
      if (a) {
        c.strokeStyle = C.orange; c.lineWidth = 1.5; c.beginPath(); c.arc(a.x, a.y, 4, 0, Math.PI * 2); c.stroke();
        c.font = `600 11.5px ${C.font}`; c.textAlign = "left"; c.textBaseline = "bottom"; c.fillStyle = C.orange;
        c.fillText(`APOGEE  ${D.fmtAlt(d.apogee.h)} ${D.altUnit}`, a.x + 8, a.y - 4);
      }
    }
    // landing mark
    const land = this.firstPhase("landed");
    if (land && T >= land.t0) {
      const [lx, , lz] = this._pos3(land.t0), lp = P(lx, ground(lx, lz), lz);
      if (lp) { c.strokeStyle = C.ink; c.lineWidth = 1.25; c.beginPath(); c.moveTo(lp.x - 4, lp.y - 4); c.lineTo(lp.x + 4, lp.y + 4); c.moveTo(lp.x + 4, lp.y - 4); c.lineTo(lp.x - 4, lp.y + 4); c.stroke(); }
    }

    const { phase, t0: pt0 } = this.phaseAt(T);
    const vNow = this.vAt(T);
    const here = P(...P0);
    const ref = here ? here.s : 1;

    // horizontal travel direction (for attitude), upwind for the weathercock
    const hdir = (t) => {
      const a = this._pos3(t - 0.5), b = this._pos3(t + 0.5);
      const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz);
      if (l > 1) return [dx / l, dz / l];
      const de = -d.drift[0], dn = -d.drift[1], m = Math.hypot(de, dn);       // into the wind: back towards where it came from
      return m > 1 ? [de / m, -dn / m] : [-1, 0];
    };
    const axisAt = (t, ph, p0, v) => {
      const th = Math.abs(this._angle(t, ph, p0, v));
      const [hx, hz] = ph === "boost" || ph === "coast" ? (Math.abs(v) > 15 ? hdir(t) : hdir(t)) : hdir(t);
      return [hx * Math.sin(th), Math.cos(th), hz * Math.sin(th)];
    };

    // exhaust: gray clouds along the burn, spreading and drifting
    const puff = this._puffer(c, night);
    const wind = (() => { const m = Math.hypot(d.drift[0], d.drift[1]); return m > 1 ? [d.drift[0] / m, -d.drift[1] / m] : [1, 0]; })();
    for (const b of d.burns) {
      const life = 10, dt = Math.max(0.008, (b.t1 - b.t0) / 400);
      const from = Math.max(b.t0, T - life), to = Math.min(b.t1, T);
      let lastP = null;
      for (let ts = Math.ceil(from / dt) * dt; ts <= to; ts += dt) {
        const age = T - ts, a = Math.pow(1 - age / life, 2) * 0.16;
        if (a <= 0.004) continue;
        const p = this._pos3(ts);
        const q = P(p[0] + wind[0] * age * 2.5 + (hash(ts) - 0.5) * age * 1.5, Math.max(ground(p[0], p[2]), p[1] - 1), p[2] + wind[1] * age * 2.5 + (hash(ts + 4) - 0.5) * age * 1.5);
        if (!q) continue;
        const r = (4 + Math.sqrt(age) * 10) * clamp(q.s / ref, 0.25, 2);
        if (lastP && Math.hypot(q.x - lastP.x, q.y - lastP.y) < r * 0.25) continue;     // thin out overlapping puffs
        lastP = q;
        puff(q.x, q.y, r, a);
      }
    }
    const ig = d.burns[0];
    if (ig && T > ig.t0 - 0.2) {
      for (let i = 0; i < 18; i++) {
        const ts = ig.t0 - 0.2 + (i / 18) * 1.2;
        if (ts > T) break;
        const age = T - ts, a = Math.pow(Math.max(0, 1 - age / 14), 1.5) * 0.11;
        if (a <= 0.004) continue;
        const ang = hash(i * 3.7) * Math.PI * 2, dist = 1 + Math.sqrt(age) * 3;
        const q = P(Math.cos(ang) * dist + wind[0] * age, ground(0, 0) + 0.5, Math.sin(ang) * dist + wind[1] * age);
        if (q) puff(q.x, q.y, (8 + Math.sqrt(age) * 10) * clamp(q.s / ref, 0.25, 2), a);
      }
    }

    if (here) {
      const L = 46;
      // drop line to the ground
      const gy = ground(P0[0], P0[2]);
      if (phase !== "pad" && phase !== "landed" && P0[1] - gy > 3) line([here, P(P0[0], gy, P0[2])], C.faint, 1, [2, 4]);
      // where the rocket points, as seen on screen
      const ax3 = axisAt(T, phase, pt0, vNow);
      const halfW = (L / 2) / Math.max(1e-6, here.s);
      const nose = P(P0[0] + ax3[0] * halfW, P0[1] + ax3[1] * halfW, P0[2] + ax3[2] * halfW);
      let ang = 0, squash = 1;
      if (nose) { const vx = nose.x - here.x, vy = nose.y - here.y; ang = Math.atan2(vx, -vy); squash = clamp(Math.hypot(vx, vy) / (L / 2), 0.3, 1); }
      // centre of the rocket sits half a length above the nozzle on the pad
      const cx = here.x + (phase === "landed" ? 0 : Math.sin(ang) * (L / 2) * squash), cy = here.y - (phase === "landed" ? 6 : Math.cos(ang) * (L / 2) * squash);
      // parachute
      const deployed = phase === "drogue" || phase === "main";
      if (deployed) this._canopy(c, cx, cy - 3, phase === "main", ease((T - pt0) / 0.9), T);
      if (phase === "landed" && (this.firstPhase("main") || this.firstPhase("drogue"))) {
        const isMain = !!this.firstPhase("main");
        c.fillStyle = isMain ? C.orange : C.panel; c.strokeStyle = C.ink; c.lineWidth = 1.1;
        c.beginPath(); c.moveTo(cx - 30, cy + 6); c.quadraticCurveTo(cx - 50, cy - 3, cx - 72, cy + 6); c.closePath(); c.fill(); c.stroke();
      }
      c.save(); c.translate(cx, cy); c.rotate(ang); c.scale(1, squash);
      this._rocket(c, L, phase === "boost", now, vNow);
      c.restore();

      // velocity arrow: real direction of travel, projected
      if (phase !== "landed" && phase !== "pad" && Math.abs(vNow) > 0.5) {
        const a = this._pos3(T - 0.1), b = this._pos3(T + 0.1);
        const v3 = [(b[0] - a[0]) / 0.2, vNow, (b[2] - a[2]) / 0.2], sp = Math.hypot(...v3);
        const k = 20 / Math.max(1e-6, here.s) / Math.max(1e-6, sp);
        const tip = P(P0[0] + v3[0] * k, P0[1] + v3[1] * k, P0[2] + v3[2] * k);
        if (tip) {
          const dx = tip.x - here.x, dy = tip.y - here.y, m = Math.hypot(dx, dy);
          if (m > 0.5) {
            const ux = dx / m, uy = dy / m;
            const len = 12 + 72 * Math.sqrt(Math.min(1, sp / d.maxSpeed));
            this._arrow(c, cx - 30 - Math.abs(uy) * 0, clamp(cy, S.y + len / 2 + 6, S.y + S.h - len / 2 - 6), ux, uy, len, `${D.fmtVel(sp)} ${D.velUnit}`);
          }
        }
      }
      // altitude tag
      if (phase !== "landed" && phase !== "pad") {
        const tx = cx + 28, ty = clamp(cy, S.y + 14, S.y + S.h - 14);
        c.strokeStyle = C.faint; c.lineWidth = 1;
        c.beginPath(); c.moveTo(cx + 12, ty); c.lineTo(tx - 4, ty); c.stroke();
        c.font = `600 11.5px ${C.mono}`; c.textAlign = "left"; c.textBaseline = "middle";
        c.fillStyle = C.ink; c.fillText(`${D.fmtAlt(P0[1])} ${D.altUnit}`, tx, ty);
      }
    }

    // compass
    {
      const o = P(cam.target[0], cam.target[1], cam.target[2]), nn = P(cam.target[0], cam.target[1], cam.target[2] - cam.dist * 0.1);
      if (o && nn) {
        const ang = Math.atan2(nn.x - o.x, -(nn.y - o.y)), x = S.x + S.w - 30, y = S.y + S.h - 32;
        c.save(); c.translate(x, y);
        c.strokeStyle = C.rule; c.lineWidth = 1; c.beginPath(); c.arc(0, 0, 14, 0, Math.PI * 2); c.stroke();
        c.rotate(ang);
        c.fillStyle = C.orange; c.beginPath(); c.moveTo(0, -11); c.lineTo(4, 2); c.lineTo(-4, 2); c.closePath(); c.fill();
        c.strokeStyle = C.ink; c.beginPath(); c.moveTo(0, 2); c.lineTo(0, 10); c.stroke();
        c.restore();
        c.font = `600 10px ${C.font}`; c.fillStyle = C.graphite; c.textAlign = "center"; c.textBaseline = "bottom";
        c.fillText("N", x + Math.sin(ang) * 22, y - Math.cos(ang) * 22 + 5);
      }
    }
    // status line
    const st = !g.renderer ? "3D needs WebGL, which this window doesn't have" : g.status;
    if (st) {
      c.font = `11.5px ${C.font}`; c.fillStyle = C.graphite; c.textAlign = "left"; c.textBaseline = "bottom";
      c.fillText(st, S.x + 14, S.y + S.h - 12);
    } else if (T3?.ok && g.renderer) {
      c.font = `11px ${C.font}`; c.fillStyle = C.faint; c.textAlign = "left"; c.textBaseline = "bottom";
      c.fillText(`Contours every ${D.fmtAlt(g.renderer.interval)} ${D.altUnit} · drag to turn, right-drag to move, scroll to zoom`, S.x + 14, S.y + S.h - 12);
    }
    this._caption(c, S, T);
    c.restore();
  }

  // ---------------------------------------------------------------- shared line art
  _puffer(c, night) {
    const gray = night ? [160, 170, 178] : [150, 157, 162];
    const rgba = (a) => `rgba(${gray[0]},${gray[1]},${gray[2]},${a})`;
    return (x, y, r, a) => {
      if (!(r > 0.3)) return;
      const g = c.createRadialGradient(x, y, r * 0.15, x, y, r);
      g.addColorStop(0, rgba(a)); g.addColorStop(0.6, rgba(a * 0.6)); g.addColorStop(1, rgba(0));
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    };
  }

  // parachute hanging above an attachment point (screen pixels)
  _canopy(c, ax, ay, isMain, inflate, T) {
    const C = this.C;
    const R = (isMain ? 26 : 14) * (0.3 + 0.7 * inflate);
    const sway = Math.sin(T * 1.3) * 0.06;
    const lineLen = isMain ? 56 : 44;
    const ccx = ax + Math.sin(sway) * lineLen, ccy = ay - Math.cos(sway) * lineLen;
    c.strokeStyle = C.ink; c.lineWidth = 0.8; c.globalAlpha = 0.7;
    c.beginPath();
    for (const f of [-1, -0.4, 0.4, 1]) { c.moveTo(ccx + f * R * Math.cos(sway), ccy + f * R * Math.sin(sway)); c.lineTo(ax, ay); }
    c.stroke(); c.globalAlpha = 1;
    c.save(); c.translate(ccx, ccy); c.rotate(sway);
    const hR = R * (0.38 + 0.3 * inflate);
    c.beginPath(); c.moveTo(-R, 0); c.bezierCurveTo(-R, -hR * 1.35, R, -hR * 1.35, R, 0);
    // scalloped skirt
    c.quadraticCurveTo(R * 0.66, -hR * 0.18, R * 0.33, 0); c.quadraticCurveTo(0, -hR * 0.18, -R * 0.33, 0); c.quadraticCurveTo(-R * 0.66, -hR * 0.18, -R, 0);
    c.closePath();
    c.fillStyle = isMain ? C.orange : C.panel; c.fill();
    c.strokeStyle = C.ink; c.lineWidth = 1.2; c.stroke();
    c.restore();
  }

  // orange arrow centred on (ax, ay) along the unit vector (ux, uy), with a speed label
  _arrow(c, ax, ay, ux, uy, len, label) {
    const C = this.C;
    const x0 = ax - (ux * len) / 2, y0 = ay - (uy * len) / 2, x1 = ax + (ux * len) / 2, y1 = ay + (uy * len) / 2;
    c.strokeStyle = C.orange; c.fillStyle = C.orange; c.lineWidth = 2; c.lineCap = "round";
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1 - ux * 6, y1 - uy * 6); c.stroke();
    const hw = 4.5, hl = 9;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x1 - ux * hl - uy * hw, y1 - uy * hl + ux * hw);
    c.lineTo(x1 - ux * hl + uy * hw, y1 - uy * hl - ux * hw);
    c.closePath(); c.fill();
    c.font = `600 11px ${C.mono}`; c.textAlign = "right"; c.textBaseline = "middle";
    c.fillText(label, Math.min(x0, x1) - 8, ay);
  }

  // event caption that fades after a few seconds
  _caption(c, S, T) {
    const C = this.C, ev = [...this.d.events].reverse().find((e) => e.t <= T && T - e.t < 3);
    if (!ev) return;
    c.globalAlpha = clamp(3 - (T - ev.t), 0, 1) * clamp((T - ev.t) / 0.15, 0, 1);
    c.font = `600 13px ${C.font}`; c.textAlign = "left"; c.textBaseline = "middle";
    const tw = c.measureText(ev.label).width;
    const bx = S.x + 14, by = S.y + 14, bw = tw + 26, bh = 30;
    c.fillStyle = C.panel; c.fillRect(bx, by, bw, bh);
    c.strokeStyle = C.rule; c.lineWidth = 1; c.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    c.fillStyle = ev.kind === "bad" ? C.fault : C.orange; c.fillRect(bx, by, 3, bh + 1);
    c.fillStyle = C.ink; c.fillText(ev.label, bx + 14, by + bh / 2 + 1);
    c.globalAlpha = 1;
  }

  // Line drawing of a rocket, centred on the origin, nose up (−y).
  _rocket(c, L, burning, now, v) {
    const C = this.C;
    const w = L * 0.16, nose = L * 0.3;
    const yTop = -L / 2, yBot = L / 2, yJoin = yTop + nose;
    if (burning) {
      const fl = 0.8 + 0.2 * Math.sin(now / 31) * Math.sin(now / 11 + 1);
      const len = L * (0.32 + 0.18 * fl) * (1 + clamp(Math.abs(v) / 400, 0, 0.4));
      c.fillStyle = C.orange;
      c.beginPath(); c.moveTo(-w * 0.32, yBot + 1.5); c.quadraticCurveTo(-w * 0.45, yBot + len * 0.45, 0, yBot + len); c.quadraticCurveTo(w * 0.45, yBot + len * 0.45, w * 0.32, yBot + 1.5); c.closePath(); c.fill();
    }
    c.lineJoin = "round"; c.lineCap = "round";
    c.strokeStyle = C.ink; c.lineWidth = 1.4; c.fillStyle = C.panel;
    // fins
    const fin = (s) => { c.beginPath(); c.moveTo(s * w / 2, yBot - L * 0.24); c.lineTo(s * (w / 2 + L * 0.14), yBot - L * 0.02); c.lineTo(s * (w / 2 + L * 0.14), yBot + L * 0.05); c.lineTo(s * w / 2, yBot); c.closePath(); c.fill(); c.stroke(); };
    fin(-1); fin(1);
    // body and nose as one outline
    c.beginPath();
    c.moveTo(-w / 2, yBot); c.lineTo(-w / 2, yJoin);
    c.bezierCurveTo(-w / 2, yJoin - nose * 0.55, -w * 0.12, yTop + nose * 0.08, 0, yTop);
    c.bezierCurveTo(w * 0.12, yTop + nose * 0.08, w / 2, yJoin - nose * 0.55, w / 2, yJoin);
    c.lineTo(w / 2, yBot); c.closePath(); c.fill(); c.stroke();
    // nose joint, one orange band, nozzle
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(-w / 2, yJoin); c.lineTo(w / 2, yJoin); c.stroke();
    c.strokeStyle = C.orange; c.lineWidth = 2;
    c.beginPath(); c.moveTo(-w / 2 + 1, yJoin + L * 0.14); c.lineTo(w / 2 - 1, yJoin + L * 0.14); c.stroke();
    c.strokeStyle = C.ink; c.lineWidth = 1.4;
    c.beginPath(); c.moveTo(-w * 0.3, yBot); c.lineTo(-w * 0.36, yBot + 2.5); c.lineTo(w * 0.36, yBot + 2.5); c.lineTo(w * 0.3, yBot); c.stroke();
  }

  _side(c, S, wide) {
    const D = this.D, d = this.d, T = this.tp, C = this.C;
    const pad = 18;
    const { phase } = this.phaseAt(T);
    const hNow = this.hAt(T), vRaw = this.vAt(T), vNow = Math.abs(vRaw) < 0.3 ? 0 : vRaw;
    const hiSoFar = Math.max(hNow, T < d.t[0] ? 0 : d.hiPrefix[T >= d.t[d.t.length - 1] ? d.t.length - 1 : this._idx(T)]);

    c.fillStyle = C.panel; c.fillRect(S.x, S.y, S.w, S.h);
    c.strokeStyle = C.rule; c.lineWidth = 1;
    c.beginPath();
    if (wide) { c.moveTo(S.x + 0.5, S.y); c.lineTo(S.x + 0.5, S.y + S.h); } else { c.moveTo(S.x, S.y + 0.5); c.lineTo(S.x + S.w, S.y + 0.5); }
    c.stroke();

    // readouts
    const items = [
      ["Time", `T${T < 0 ? "−" : "+"}${Math.abs(T).toFixed(1)}`, "s"],
      ["Altitude", D.fmtAlt(hNow), D.altUnit],
      ["Vertical speed", D.fmtVel(vNow), D.velUnit],
      ["Highest so far", D.fmtAlt(hiSoFar), D.altUnit],
    ];
    let y = S.y + pad;
    if (wide) {
      c.textBaseline = "alphabetic";
      c.fillStyle = C.orange;
      c.fillRect(S.x + pad, y + 2, 3, 22);
      c.fillStyle = C.ink; c.font = `600 20px ${C.font}`; c.textAlign = "left";
      c.fillText(PHASE_NAME[phase] || phase, S.x + pad + 12, y + 20);
      if (this.recording) { c.fillStyle = C.orange; c.beginPath(); c.arc(S.x + S.w - pad - 6, y + 12, 6, 0, Math.PI * 2); c.fill(); }
      y += 44;
      const colW = (S.w - pad * 2) / 2;
      items.forEach(([k, v, u], i) => {
        const x = S.x + pad + (i % 2) * colW, yy = y + Math.floor(i / 2) * 64;
        c.fillStyle = C.faint; c.font = `11px ${C.font}`; c.fillText(k.toUpperCase(), x, yy + 12);
        c.fillStyle = C.ink; c.font = `600 30px ${C.font}`; c.fillText(v, x, yy + 44);
        const vw = c.measureText(v).width;
        c.fillStyle = C.graphite; c.font = `14px ${C.font}`; c.fillText(u, x + vw + 5, yy + 44);
      });
      y += 2 * 64 + 10;
    } else {
      c.textBaseline = "alphabetic"; c.textAlign = "left";
      const cols = S.w >= 520 ? 4 : 2, colW = (S.w - pad * 2) / cols;
      items.forEach(([k, v, u], i) => {
        const x = S.x + pad + (i % cols) * colW, yy = y + Math.floor(i / cols) * 40;
        c.fillStyle = C.graphite; c.font = `11px ${C.font}`; c.fillText(k, x, yy + 10);
        c.fillStyle = C.ink; c.font = `700 17px ${C.font}`; c.fillText(`${v} ${u}`, x, yy + 30);
      });
      y += Math.ceil(items.length / cols) * 40 + 2;
    }

    // altitude profile with phase bands, events and the playhead
    const P = { x: S.x + pad + 4, y: y + 8, w: S.w - pad * 2 - 8, h: Math.max(50, S.y + S.h - y - 8 - 34) };
    this._prof = P;
    const tA = this.t0(), tB = this.t1();
    const X = (t) => P.x + ((t - tA) / (tB - tA || 1)) * P.w;
    const hMax = Math.max(1, d.maxH * 1.08);
    const Yp = (alt) => P.y + P.h - (alt / hMax) * P.h;
    c.fillStyle = C.faint; c.font = `11px ${C.font}`; c.textAlign = "left"; c.textBaseline = "bottom";
    c.fillText(wide ? "ALTITUDE PROFILE · CLICK OR DRAG TO JUMP" : "", P.x, P.y - 3);
    for (const b of d.burns) {
      c.globalAlpha = 0.1; c.fillStyle = C.orange; c.fillRect(X(Math.max(tA, b.t0)), P.y, Math.max(1, X(Math.min(tB, b.t1)) - X(Math.max(tA, b.t0))), P.h);
      c.globalAlpha = 1;
    }
    c.strokeStyle = C.rule; c.lineWidth = 1; c.strokeRect(P.x + 0.5, P.y + 0.5, P.w, P.h);
    // curve: drawn bold up to the playhead
    const stride = Math.max(1, Math.floor(d.t.length / (P.w * 2)));
    const path = (until) => {
      c.beginPath(); let started = false;
      for (let i = 0; i < d.t.length; i += stride) {
        if (d.t[i] < tA) continue;
        if (d.t[i] > until) break;
        const px = X(d.t[i]), py = Yp(Math.max(0, d.h[i]));
        if (!started) { c.moveTo(px, py); started = true; } else c.lineTo(px, py);
      }
      if (until < tB && started) c.lineTo(X(until), Yp(this.hAt(until)));
      c.stroke();
    };
    c.lineJoin = "round";
    c.strokeStyle = C.ruleStrong; c.lineWidth = 1.25; path(tB);
    c.strokeStyle = C.ink; c.lineWidth = 1.75; path(T);
    // event ticks
    for (const e of d.events) {
      if (e.t < tA || e.t > tB) continue;
      const ex = X(e.t);
      c.strokeStyle = e.t <= T ? C.ink : C.faint; c.globalAlpha = 0.45; c.lineWidth = 1;
      c.beginPath(); c.moveTo(ex, P.y + P.h); c.lineTo(ex, P.y + P.h + 6); c.stroke(); c.globalAlpha = 1;
    }
    // time axis
    c.fillStyle = C.graphite; c.font = `11px ${C.mono}`; c.textBaseline = "top";
    const ts = niceStep(tB - tA, Math.max(2, Math.floor(P.w / 80)));
    for (let t = Math.ceil(tA / ts) * ts; t <= tB; t += ts) {
      const tx = X(t);
      c.textAlign = tx < P.x + 12 ? "left" : tx > P.x + P.w - 12 ? "right" : "center";
      c.fillText(`${Math.round(t * 10) / 10}`, tx, P.y + P.h + 8);
    }
    c.textAlign = "right"; c.fillText("s", P.x + P.w, P.y + P.h + 20);
    // playhead
    const px = X(T);
    c.strokeStyle = C.orange; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(Math.round(px) + 0.5, P.y); c.lineTo(Math.round(px) + 0.5, P.y + P.h); c.stroke();
    c.fillStyle = C.panel; c.beginPath(); c.arc(px, Yp(hNow), 4.5, 0, Math.PI * 2); c.fill(); c.lineWidth = 2; c.stroke();
  }
}

// Convert per-sample phase names into [{ phase, t0, t1 }] intervals.
export function phasesFromSamples(t, phase) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const p = phase[i];
    if (!p) continue;
    const last = out[out.length - 1];
    if (last && last.phase === p) last.t1 = t[i];
    else { if (last) last.t1 = t[i]; out.push({ phase: p, t0: t[i], t1: t[i] }); }
  }
  return out;
}
