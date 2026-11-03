// 3D flight view support: terrain from elevation tiles, a small WebGL
// renderer for the ground, and the camera maths used to project the flight
// (drawn as line art by flightviz.js) on top of it. No libraries.
//
// World axes: x = east, y = up, z = south (so north is -z). Metres, with the
// pad at the origin and y = 0 at the pad's ground height.

const R_EARTH_M_PER_DEG = 111320;

// ------------------------------------------------------------------ maths
export const m4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(e, t, u) {
    let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
};

// Orbiting camera. az: angle round the vertical (0 = looking north),
// el: angle above the horizon, dist: metres from the target.
export class OrbitCamera {
  constructor() { this.az = 0.6; this.el = 0.42; this.dist = 800; this.target = [0, 0, 0]; this.fov = (38 * Math.PI) / 180; }
  eye() {
    const c = Math.cos(this.el);
    return [this.target[0] + this.dist * c * Math.sin(this.az), this.target[1] + this.dist * Math.sin(this.el), this.target[2] + this.dist * c * Math.cos(this.az)];
  }
  // matrices for a viewport of w x h pixels; returns a projector to screen pixels
  frame(w, h, ox = 0, oy = 0) {
    const eye = this.eye();
    const near = Math.max(0.5, this.dist / 2000), far = this.dist * 60 + 20000;
    const P = m4.perspective(this.fov, w / h, near, far), V = m4.lookAt(eye, this.target, [0, 1, 0]);
    const M = m4.mul(P, V);
    const focal = h / (2 * Math.tan(this.fov / 2));
    const project = (x, y, z) => {
      const cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13];
      const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= near * 0.5) return null;
      return { x: ox + (cx / cw * 0.5 + 0.5) * w, y: oy + (1 - (cy / cw * 0.5 + 0.5)) * h, s: focal / cw, w: cw };
    };
    return { M, eye, project, focal };
  }
}

// ------------------------------------------------------------------ terrain
const tileXY = (lat, lon, z) => {
  const n = 2 ** z, lr = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n];
};

async function loadTileImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`tile ${r.status}`);
  return createImageBitmap(await r.blob());
}

// Heights on an N x N grid covering [-E, E] metres east and north of (lat, lon).
// Returns { N, E, h: Float32Array (metres above the pad), padElev, ok, why }.
export async function loadTerrain(lat, lon, E, N = 129) {
  const out = { N, E, h: new Float32Array(N * N), padElev: 0, ok: false, why: "" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) { out.why = "no launch site position"; return out; }
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const mpp = (2 * E) / (N - 1);                                   // metres per grid step
  let z = Math.round(Math.log2((156543 * cosLat) / mpp));
  z = Math.max(8, Math.min(14, z));
  const toLL = (e, n) => [lat + n / R_EARTH_M_PER_DEG, lon + e / (R_EARTH_M_PER_DEG * cosLat)];
  const [ax, ay] = tileXY(...toLL(-E, E), z), [bx, by] = tileXY(...toLL(E, -E), z);
  const tiles = new Map();
  const jobs = [];
  for (let x = Math.floor(ax); x <= Math.floor(bx); x++) for (let y = Math.floor(ay); y <= Math.floor(by); y++) {
    jobs.push(loadTileImage(`/elev/${z}/${x}/${y}.png`).then((bmp) => {
      const cv = new OffscreenCanvas(256, 256), c = cv.getContext("2d", { willReadFrequently: true });
      c.drawImage(bmp, 0, 0);
      tiles.set(`${x}/${y}`, c.getImageData(0, 0, 256, 256).data);
    }).catch(() => {}));
  }
  if (jobs.length > 36) { out.why = "area too large"; return out; }
  await Promise.all(jobs);
  if (!tiles.size) { out.why = "elevation for this site isn't saved"; return out; }
  const sample = (la, lo) => {
    const [fx, fy] = tileXY(la, lo, z);
    const px = (fx - Math.floor(fx)) * 256 - 0.5, py = (fy - Math.floor(fy)) * 256 - 0.5;
    const d = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (!d) return NaN;
    const read = (ix, iy) => { ix = Math.max(0, Math.min(255, ix)); iy = Math.max(0, Math.min(255, iy)); const k = (iy * 256 + ix) * 4; return d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768; };
    const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
    return (read(x0, y0) * (1 - tx) + read(x0 + 1, y0) * tx) * (1 - ty) + (read(x0, y0 + 1) * (1 - tx) + read(x0 + 1, y0 + 1) * tx) * ty;
  };
  out.padElev = sample(lat, lon);
  if (!Number.isFinite(out.padElev)) { out.why = "elevation for this site isn't saved"; return out; }
  let missing = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = -E + i * mpp, n = E - j * mpp;                       // row 0 = north edge
    const v = sample(...toLL(e, n));
    if (!Number.isFinite(v)) missing++;
    out.h[j * N + i] = Number.isFinite(v) ? v - out.padElev : 0;
  }
  out.ok = true;
  out.partial = missing > 0;
  return out;
}

// Map pictures for the same square, drawn into one canvas (north up).
export async function loadMapTexture(lat, lon, E, px = 1024) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let z = Math.round(Math.log2((156543 * cosLat * px) / (2 * E * 256) * 256 / 256));
  z = Math.max(10, Math.min(17, Math.round(Math.log2((156543 * cosLat) / ((2 * E) / px)))));
  const toLL = (e, n) => [lat + n / R_EARTH_M_PER_DEG, lon + e / (R_EARTH_M_PER_DEG * cosLat)];
  const [ax, ay] = tileXY(...toLL(-E, E), z), [bx, by] = tileXY(...toLL(E, -E), z);
  if ((Math.floor(bx) - Math.floor(ax) + 1) * (Math.floor(by) - Math.floor(ay) + 1) > 49) return null;
  const cv = document.createElement("canvas"); cv.width = cv.height = px;
  const c = cv.getContext("2d");
  c.fillStyle = "#eef1f0"; c.fillRect(0, 0, px, px);
  const sx = px / ((bx - ax) * 256), sy = px / ((by - ay) * 256);
  let got = 0;
  const jobs = [];
  for (let x = Math.floor(ax); x <= Math.floor(bx); x++) for (let y = Math.floor(ay); y <= Math.floor(by); y++) {
    jobs.push(loadTileImage(`/tiles/${z}/${x}/${y}.png`).then((bmp) => {
      c.drawImage(bmp, (x - ax) * 256 * sx, (y - ay) * 256 * sy, 256 * sx + 0.5, 256 * sy + 0.5); got++;
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  return got ? cv : null;
}

// Ground height at (x east, z south) from a loaded terrain, bilinear.
export function groundAt(T, x, z) {
  if (!T || !T.ok) return 0;
  const { N, E, h } = T, step = (2 * E) / (N - 1);
  const fi = (x + E) / step, fj = (z + E) / step;                 // row 0 is the north edge (z = -E)
  if (fi < 0 || fj < 0 || fi > N - 1 || fj > N - 1) return 0;
  const i = Math.min(N - 2, Math.floor(fi)), j = Math.min(N - 2, Math.floor(fj)), tx = fi - i, ty = fj - j;
  return (h[j * N + i] * (1 - tx) + h[j * N + i + 1] * tx) * (1 - ty) + (h[(j + 1) * N + i] * (1 - tx) + h[(j + 1) * N + i + 1] * tx) * ty;
}

// ------------------------------------------------------------------ renderer
const VS = `#version 300 es
in vec3 aPos; in vec3 aNor;
uniform mat4 uMVP;
out vec3 vP; out vec3 vN;
void main() { vP = aPos; vN = aNor; gl_Position = uMVP * vec4(aPos, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec3 vP; in vec3 vN;
out vec4 o;
uniform vec3 uBg, uBase, uLine, uLight;
uniform float uInterval, uGrid, uExtent, uMap, uLines;
uniform sampler2D uTex;
float lineAA(float f, float w) { float d = abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-5); return 1.0 - clamp(d - w, 0.0, 1.0); }
void main() {
  vec3 n = normalize(vN);
  float shade = 0.84 + 0.16 * max(dot(n, normalize(uLight)), 0.0);
  vec3 base = uBase;
  if (uMap > 0.5) {
    vec2 uv = vec2((vP.x + uExtent) / (2.0 * uExtent), (vP.z + uExtent) / (2.0 * uExtent));
    vec3 t = texture(uTex, uv).rgb;
    float g = dot(t, vec3(0.299, 0.587, 0.114));
    base = mix(vec3(g), t, 0.5) * 0.92 + 0.08;
  }
  vec3 col = base * shade;
  float f = vP.y / uInterval;
  float major = step(abs(mod(floor(f + 0.5), 5.0)), 0.5);
  col = mix(col, uLine, uLines * lineAA(f, 0.0) * (0.16 + 0.16 * major) * (1.0 - 0.4 * uMap));
  // a faint grid only where there are no contours to show the ground
  vec2 g2 = vP.xz / uGrid;
  float gl = max(lineAA(g2.x, 0.0), lineAA(g2.y, 0.0));
  col = mix(col, uLine, gl * 0.1 * (1.0 - uLines));
  float r = max(abs(vP.x), abs(vP.z)) / uExtent;
  o = vec4(mix(col, uBg, smoothstep(0.72, 0.98, r)), 1.0);
}`;

const hex = (c) => {
  const m = String(c || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) { const r = String(c).match(/(\d+)\D+(\d+)\D+(\d+)/); return r ? [r[1] / 255, r[2] / 255, r[3] / 255] : [1, 1, 1]; }
  const v = parseInt(m[1], 16); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

export class TerrainRenderer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.gl = this.canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.ok = !!this.gl;
    if (!this.ok) return;
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p;
    this.u = {};
    for (const n of ["uMVP", "uBg", "uBase", "uLine", "uLight", "uInterval", "uGrid", "uExtent", "uMap", "uLines", "uTex"]) this.u[n] = gl.getUniformLocation(p, n);
    this.tex = gl.createTexture();
    this.hasMap = false;
    this.setTerrain({ N: 2, E: 1000, h: new Float32Array(4), ok: false });
  }

  setTerrain(T) {
    if (!this.ok) return;
    const gl = this.gl, { N, E, h } = T, step = (2 * E) / (N - 1);
    const pos = new Float32Array(N * N * 3), nor = new Float32Array(N * N * 3);
    const H = (i, j) => h[Math.max(0, Math.min(N - 1, j)) * N + Math.max(0, Math.min(N - 1, i))];
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3, y = H(i, j);
      pos[k] = -E + i * step; pos[k + 1] = y; pos[k + 2] = -E + j * step;
      const nx = H(i - 1, j) - H(i + 1, j), nz = H(i, j - 1) - H(i, j + 1), ny = 2 * step;
      const l = Math.hypot(nx, ny, nz); nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
      if (y < lo) lo = y; if (y > hi) hi = y;
    }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let q = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    if (!this.vao) { this.vao = gl.createVertexArray(); this.bp = gl.createBuffer(); this.bn = gl.createBuffer(); this.bi = gl.createBuffer(); }
    gl.bindVertexArray(this.vao);
    const attr = (buf, data, name) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); const loc = gl.getAttribLocation(this.p, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0); };
    attr(this.bp, pos, "aPos"); attr(this.bn, nor, "aNor");
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bi); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.count = idx.length;
    this.E = E;
    // contour spacing from the height range: about 8–15 lines across it
    const span = Math.max(1, hi - lo);
    const raw = span / 10, p10 = 10 ** Math.floor(Math.log10(raw));
    this.interval = [1, 2, 5, 10].map((m) => m * p10).find((v) => v >= raw) || 10 * p10;
    this.flat = !T.ok || span < 1;
  }

  setMap(canvas) {
    if (!this.ok) return;
    const gl = this.gl;
    this.hasMap = !!canvas;
    if (!canvas) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // Draw the ground for camera matrix M into a w x h (device pixel) canvas.
  render(M, w, h, colors, { map = false, grid = 100 } = {}) {
    if (!this.ok) return null;
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const bg = hex(colors.panel);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.p);
    gl.uniformMatrix4fv(this.u.uMVP, false, M);
    gl.uniform3fv(this.u.uBg, bg);
    gl.uniform3fv(this.u.uBase, colors.night ? hex(colors.panel2) : [0.985, 0.988, 0.985]);
    gl.uniform3fv(this.u.uLine, hex(colors.ink));
    gl.uniform3fv(this.u.uLight, [-0.5, 0.8, -0.35]);
    gl.uniform1f(this.u.uInterval, this.interval);
    gl.uniform1f(this.u.uGrid, grid);
    gl.uniform1f(this.u.uExtent, this.E);
    gl.uniform1f(this.u.uMap, map && this.hasMap ? 1 : 0);
    gl.uniform1f(this.u.uLines, this.flat ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(this.u.uTex, 0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return this.canvas;
  }
}

// GPS fixes to east/north metres from the pad, on the flight's time base.
// fixes: arrays lat[], lon[] aligned with t (NaN where no fix).
export function gpsTrack(t, lat, lon, tLift) {
  const ok = [];
  for (let i = 0; i < t.length; i++) if (Number.isFinite(lat[i]) && Number.isFinite(lon[i]) && Math.abs(lat[i]) > 1e-6 && Math.abs(lat[i]) <= 90 && Math.abs(lon[i]) <= 180) ok.push(i);
  if (ok.length < 5) return null;
  // pad: median of fixes in the 20 s before liftoff, else the first fix
  const pre = ok.filter((i) => t[i] < tLift && t[i] > tLift - 20);
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const lat0 = pre.length ? med(pre.map((i) => lat[i])) : lat[ok[0]], lon0 = pre.length ? med(pre.map((i) => lon[i])) : lon[ok[0]];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  // distinct fixes only (loggers repeat the last fix between updates)
  const ft = [], fe = [], fn = [];
  for (const i of ok) {
    const e = (lon[i] - lon0) * R_EARTH_M_PER_DEG * cosLat, n = (lat[i] - lat0) * R_EARTH_M_PER_DEG;
    if (ft.length && e === fe[fe.length - 1] && n === fn[fn.length - 1]) continue;
    ft.push(t[i]); fe.push(e); fn.push(n);
  }
  // a 5-point median takes out single bad fixes
  const m5 = (a) => a.map((_, i) => med(a.slice(Math.max(0, i - 2), i + 3)));
  const se = m5(fe), sn = m5(fn);
  const east = new Float64Array(t.length), north = new Float64Array(t.length);
  let k = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] <= ft[0]) { east[i] = t[i] < tLift ? 0 : se[0]; north[i] = t[i] < tLift ? 0 : sn[0]; continue; }
    while (k < ft.length - 2 && ft[k + 1] < t[i]) k++;
    if (t[i] >= ft[ft.length - 1]) { east[i] = se[se.length - 1]; north[i] = sn[sn.length - 1]; continue; }
    const a = (t[i] - ft[k]) / (ft[k + 1] - ft[k] || 1);
    east[i] = se[k] + (se[k + 1] - se[k]) * a; north[i] = sn[k] + (sn[k + 1] - sn[k]) * a;
  }
  // on the pad it hasn't moved
  for (let i = 0; i < t.length && t[i] < tLift; i++) { east[i] = 0; north[i] = 0; }
  return { east, north, lat0, lon0, fixes: ft.length };
}
