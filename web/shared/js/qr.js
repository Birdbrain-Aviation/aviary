// Minimal QR code encoder (byte mode, versions 1–10, error correction L or M)
// following the structure of Project Nayuki's reference implementation (MIT).
// Used by Owl to put the rocket's landing position on a phone in one scan.

const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ECC = { L: { bits: 1, ec: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18], blocks: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4] },
              M: { bits: 0, ec: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] } };
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
export function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
export function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
  return r;
}
export function formatBits(level, mask) {
  const data = (ECC[level].bits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function encodeQR(text, level = "M") {
  const bytes = Array.from(new TextEncoder().encode(text));
  const E = ECC[level];
  let ver = 0, dataCw = 0;
  for (let v = 1; v <= 10; v++) {
    const dc = TOTAL[v] - E.ec[v] * E.blocks[v];
    const need = 4 + (v <= 9 ? 8 : 16) + 8 * bytes.length;
    if (need <= dc * 8) { ver = v; dataCw = dc; break; }
  }
  if (!ver) throw new Error("Text too long for a small QR code");
  // bit stream
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCw * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let p = 0xec; data.length < dataCw; p ^= 0xec ^ 0x11) data.push(p);

  // error correction + interleave
  const nb = E.blocks[ver], ecl = E.ec[ver], raw = TOTAL[ver];
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecl);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });

  // matrix
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy; if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[ver], na = al.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask) => {
    const b = formatBits(level, mask), g = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, g(i));
    set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, g(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, g(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const c = ((vb >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, c); set(b, a, c); }
  }
  // data
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && bi < cw.length * 8) { mod[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
    }
  }
  const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x]; };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const s = penalty(mod, size);
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return { size, modules: mod, version: ver, mask: best };
}

function penalty(m, n) {
  let s = 0;
  for (let pass = 0; pass < 2; pass++) for (let a = 0; a < n; a++) {
    let run = 1;
    for (let b = 1; b < n; b++) {
      const cur = pass ? m[b][a] : m[a][b], prev = pass ? m[b - 1][a] : m[a][b - 1];
      if (cur === prev) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1;
    }
    for (let b = 0; b + 10 < n; b++) {
      const g = (k) => (pass ? m[b + k][a] : m[a][b + k]) ? 1 : 0;
      const p = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(g).join("");
      if (p === "10111010000" || p === "00001011101") s += 40;
    }
  }
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3; }
  let dark = 0; for (const row of m) for (const c of row) if (c) dark++;
  s += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
  return s;
}

// Draw onto a canvas with a 4-module quiet zone.
export function drawQR(canvas, text, level = "M") {
  const q = encodeQR(text, level);
  const scale = Math.max(2, Math.floor(208 / (q.size + 8)));
  canvas.width = canvas.height = (q.size + 8) * scale;
  const c = canvas.getContext("2d");
  c.fillStyle = "#fff"; c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = "#000";
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) c.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
  return q;
}
