// Regenerate the full Krypto Mirror logo/icon set from one baked design.
//
// The mark is the "3D K": two Ks the same way round — one blue, one red —
// pulled apart on a diagonal (a true red/blue anaglyph / 3D-glasses), on a pale
// rounded tile. Each channel is translucent, so the overlap merges to a deep
// core with red and blue fringes. See scratchpad mirror-k-3d.html for the look.
//
// Pure Node, NO external deps: we rasterize the vector design ourselves with
// supersampling and encode PNG via zlib, then pack .ico and .icns by hand.
// This replaces the old make-ico.mjs (which needed jimp + png-to-ico, neither
// installed). Run after the logo changes: `npm run make-logo`.
//
// Outputs:
//   resources/krypt.png            1024x1024 master (dock / non-win window icon)
//   resources/krypt.ico            16,24,32,48,64,128,256 (win + NSIS)
//   resources/krypt.icns           ic07..ic14 (mac)
//   resources/icons/<n>x<n>.png    16,24,32,48,64,128,256,512,1024 (linux)
//   public/krypt.png               512 web favicon (index.html ./krypt.png)
//   resources/krypt.svg            vector master (source of truth)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const RES = path.join(root, 'resources');
const ICONS = path.join(RES, 'icons');
const PUBLIC = path.join(root, 'public');

// ---------------------------------------------------------------- design ----
// Everything is defined in a 100x100 tile space, then scaled to N px.
const TILE_R = 24;            // tile corner radius
const PAD = 14, SCALE = 0.72; // K-space -> tile-space: p' = PAD + SCALE*p
const OFF = 6;                // diagonal offset between the two channels (K-space)
const KW = 13;                // K stroke width (K-space)
const ALPHA = 0.82;           // per-channel opacity

const BLUE = [59, 115, 247];  // #3B73F7  blue channel (front)
const RED  = [230, 57, 70];   // #E63946  red channel  (back)
const G0 = [255, 255, 255];   // tile gradient top-left  #ffffff
const G1 = [234, 240, 251];   // tile gradient bot-right #eaf0fb

// K letterform in K-space: stem + two arms (round caps/joins).
const K_SEGS = [
  [26, 14, 26, 86], // stem
  [26, 50, 72, 14], // upper arm
  [26, 50, 72, 86], // lower arm
];

// Map a K-space point through a channel's transform into tile-space.
// Both Ks keep normal orientation; they differ only by opposite diagonal shifts.
// Red: offset (+OFF,+OFF).  Blue: offset (-OFF,-OFF).  Then outer PAD/SCALE.
function redPt(x, y) { return [PAD + SCALE * (x + OFF), PAD + SCALE * (y + OFF)]; }
function bluePt(x, y) { return [PAD + SCALE * (x - OFF), PAD + SCALE * (y - OFF)]; }

function channelSegs(mapPt) {
  return K_SEGS.map(([ax, ay, bx, by]) => {
    const [Ax, Ay] = mapPt(ax, ay);
    const [Bx, By] = mapPt(bx, by);
    return [Ax, Ay, Bx, By];
  });
}
const RED_SEGS = channelSegs(redPt);
const BLUE_SEGS = channelSegs(bluePt);
const STROKE_R = SCALE * KW / 2; // stroke radius in tile-space

// ------------------------------------------------------------- geometry ----
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1e-9;
  let t = (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * vx, cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}
function inCapsules(px, py, segs, r) {
  for (const s of segs) if (segDist(px, py, s[0], s[1], s[2], s[3]) <= r) return true;
  return false;
}
// signed distance to rounded rect centred in [0,100]^2, corner radius rr
function roundRectInside(px, py, rr) {
  const h = 50, bx = h - rr, by = h - rr;
  const dx = Math.abs(px - h) - bx, dy = Math.abs(py - h) - by;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - rr <= 0;
}
function gradient(px, py) {
  let t = (px + py) / 200; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [G0[0] + (G1[0] - G0[0]) * t, G0[1] + (G1[1] - G0[1]) * t, G0[2] + (G1[2] - G0[2]) * t];
}
function over(src, a, dst) {
  return [src[0] * a + dst[0] * (1 - a), src[1] * a + dst[1] * (1 - a), src[2] * a + dst[2] * (1 - a)];
}

// ------------------------------------------------------------- raster -------
function render(N) {
  const S = N <= 48 ? 6 : 4;          // supersamples per axis
  const f = N / 100;                   // tile-space -> px
  const r = STROKE_R * f;
  const red = RED_SEGS.map((s) => s.map((v) => v * f));
  const blue = BLUE_SEGS.map((s) => s.map((v) => v * f));
  const rr = TILE_R * f;
  const buf = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let aAcc = 0, rAcc = 0, gAcc = 0, bAcc = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
          // tile-space coords for rect/gradient tests
          const tx = px / f, ty = py / f;
          if (!roundRectInside(tx, ty, TILE_R)) continue; // transparent sample
          let col = gradient(tx, ty);
          if (inCapsules(px, py, red, r)) col = over(RED, ALPHA, col);
          if (inCapsules(px, py, blue, r)) col = over(BLUE, ALPHA, col);
          aAcc += 1; rAcc += col[0]; gAcc += col[1]; bAcc += col[2];
        }
      }
      const tot = S * S;
      const o = (y * N + x) * 4;
      const alpha = aAcc / tot;
      if (aAcc > 0) {
        buf[o] = Math.round(rAcc / aAcc);
        buf[o + 1] = Math.round(gAcc / aAcc);
        buf[o + 2] = Math.round(bAcc / aAcc);
        buf[o + 3] = Math.round(alpha * 255);
      } // else fully transparent (zeros)
    }
  }
  return buf; // RGBA
}

// ------------------------------------------------------------- PNG enc ------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(rgba, N) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  // filter 0 per scanline
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------- ICO enc ------
function encodeIco(entries) { // entries: [{size, png}]
  const count = entries.length;
  const dir = Buffer.alloc(6 + 16 * count);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach((e, i) => {
    const b = 6 + 16 * i;
    dir[b] = e.size >= 256 ? 0 : e.size;      // width
    dir[b + 1] = e.size >= 256 ? 0 : e.size;  // height
    dir[b + 2] = 0; dir[b + 3] = 0;           // colors, reserved
    dir.writeUInt16LE(1, b + 4);              // planes
    dir.writeUInt16LE(32, b + 6);             // bitcount
    dir.writeUInt32LE(e.png.length, b + 8);   // bytes in res
    dir.writeUInt32LE(offset, b + 12);        // offset
    offset += e.png.length;
    blobs.push(e.png);
  });
  return Buffer.concat([dir, ...blobs]);
}

// ------------------------------------------------------------- ICNS enc -----
function icnsElement(type, png) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([head, png]);
}
function encodeIcns(map) { // map: {type: png}
  const els = Object.entries(map).map(([t, png]) => icnsElement(t, png));
  const body = Buffer.concat(els);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------- SVG master ---
function svgMaster() {
  const seg = (s) => `<path d="M${s[0].toFixed(2)} ${s[1].toFixed(2)} L${s[2].toFixed(2)} ${s[3].toFixed(2)}"/>`;
  const chan = (segs, color) =>
    `<g fill="none" stroke="${color}" stroke-opacity="${ALPHA}" stroke-width="${(SCALE * KW).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${segs.map(seg).join('')}</g>`;
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">
  <defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${hex(G0)}"/><stop offset="1" stop-color="${hex(G1)}"/>
  </linearGradient></defs>
  <rect width="100" height="100" rx="${TILE_R}" fill="url(#t)"/>
  ${chan(RED_SEGS, hex(RED))}
  ${chan(BLUE_SEGS, hex(BLUE))}
</svg>
`;
}

// ------------------------------------------------------------- run ----------
fs.mkdirSync(ICONS, { recursive: true });
fs.mkdirSync(PUBLIC, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = {};
for (const n of SIZES) {
  pngs[n] = encodePng(render(n), n);
  fs.writeFileSync(path.join(ICONS, `${n}x${n}.png`), pngs[n]);
  console.log(`  icons/${n}x${n}.png  (${pngs[n].length} bytes)`);
}

// master + dock/window icon (1024), web favicon (512)
fs.writeFileSync(path.join(RES, 'krypt.png'), pngs[1024]);
fs.writeFileSync(path.join(PUBLIC, 'krypt.png'), pngs[512]);
fs.writeFileSync(path.join(RES, 'krypt.svg'), svgMaster());
console.log('  resources/krypt.png (1024), public/krypt.png (512), resources/krypt.svg');

// .ico — Windows + NSIS
const ico = encodeIco([16, 24, 32, 48, 64, 128, 256].map((n) => ({ size: n, png: pngs[n] })));
fs.writeFileSync(path.join(RES, 'krypt.ico'), ico);
console.log(`  resources/krypt.ico (${ico.length} bytes)`);

// .icns — macOS (PNG-based element types)
const icns = encodeIcns({
  ic07: pngs[128],  ic08: pngs[256],  ic09: pngs[512],  ic10: pngs[1024],
  ic11: pngs[32],   ic12: pngs[64],   ic13: pngs[256],  ic14: pngs[512],
});
fs.writeFileSync(path.join(RES, 'krypt.icns'), icns);
console.log(`  resources/krypt.icns (${icns.length} bytes)`);

console.log('[make-logo] done.');
