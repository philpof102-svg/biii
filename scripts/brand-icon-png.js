#!/usr/bin/env node
'use strict';
// Rasterise the BIII brand SVGs to PNG, with no dependency outside node core.
//
// WHY THIS EXISTS AS A SCRIPT, and not as a one-off binary dropped in web/brand/:
// an icon that ships as bytes nobody can re-derive is a fact with no source. The SVGs are the
// source of truth; this reads their geometry OUT OF THE FILE rather than restating it, so a colour
// or a bar position changed in the SVG shows up in the next PNG. Re-run it, do not hand-edit a PNG.
//
// BOUND ON WHAT THIS CAN RENDER: <rect> only, with optional rx/ry, flat #rrggbb fills, painted in
// document order. That covers biii-icon.svg and biii-icon-maskable.svg completely -- it does NOT
// cover the wordmark, the lockup or the OG card, which use <path> and <text>. Those throw here
// rather than rendering wrong: see the unsupported-element check below.
//
//   node scripts/brand-icon-png.js                 -> the default matrix, into web/brand/
//   node scripts/brand-icon-png.js <svg> <size>    -> one file, printed to stdout as a path

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- SVG (the narrow subset above)

function parseAttrs(s) {
  const out = {};
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function parseSvg(src) {
  const svgTag = /<svg\b([^>]*)>/.exec(src);
  if (!svgTag) throw new Error('no <svg> element');
  const vb = String(parseAttrs(svgTag[1]).viewBox || '').trim().split(/\s+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) throw new Error('no usable viewBox');

  // Anything with a fill that is NOT a rect would be dropped silently, and a silently dropped shape
  // is exactly how a wrong icon ships looking fine. Refuse instead.
  const unsupported = /<(path|circle|ellipse|polygon|polyline|line|text|image|use)\b/.exec(src);
  if (unsupported) {
    throw new Error('this rasteriser only handles <rect>; found <' + unsupported[1] + '>. '
      + 'Render that file with a real SVG engine, not with this script.');
  }

  const rects = [];
  const re = /<rect\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const a = parseAttrs(m[1]);
    const rx = a.rx != null ? Number(a.rx) : (a.ry != null ? Number(a.ry) : 0);
    const ry = a.ry != null ? Number(a.ry) : rx;
    rects.push({
      x: Number(a.x || 0), y: Number(a.y || 0),
      w: Number(a.width || 0), h: Number(a.height || 0),
      rx, ry, fill: parseColor(a.fill || '#000000'),
    });
  }
  if (rects.length === 0) throw new Error('no <rect> found');
  return { vx: vb[0], vy: vb[1], vw: vb[2], vh: vb[3], rects };
}

function parseColor(s) {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(String(s).trim());
  if (!hex) throw new Error('only #rrggbb fills are supported, got: ' + s);
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A point is inside a rounded rect when it is inside the box AND, in a corner quadrant, inside the
// corner ellipse. rx/ry clamp to half the side, which is what makes rx = w/2 a stadium end cap --
// that is exactly the shape of the three BIII bars, so this clamp is load-bearing, not defensive.
function inside(px, py, r) {
  if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) return false;
  const rx = Math.min(r.rx, r.w / 2);
  const ry = Math.min(r.ry, r.h / 2);
  if (!(rx > 0) || !(ry > 0)) return true;
  let cx = null;
  if (px < r.x + rx) cx = r.x + rx;
  else if (px > r.x + r.w - rx) cx = r.x + r.w - rx;
  let cy = null;
  if (py < r.y + ry) cy = r.y + ry;
  else if (py > r.y + r.h - ry) cy = r.y + r.h - ry;
  if (cx === null || cy === null) return true;
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

// ---------------------------------------------------------------- raster

// Averaging sRGB bytes directly is wrong: sRGB is a gamma-encoded scale, so the mean of two encoded
// values is not the value of the mean light. On a dark-background icon that shows up as edges that
// read too dark. We average in LINEAR light and re-encode, which is what a real renderer does.
const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const toSrgb = (l) => {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

function raster(doc, size, ss) {
  const px = Buffer.alloc(size * size * 4);
  const lin = doc.rects.map((r) => r.fill.map(toLinear));
  const step = 1 / ss;
  const half = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      let lr = 0;
      let lg = 0;
      let lb = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = doc.vx + ((x + half + sx * step) / size) * doc.vw;
          const uy = doc.vy + ((y + half + sy * step) / size) * doc.vh;
          let hit = -1;
          for (let i = doc.rects.length - 1; i >= 0; i--) {
            if (inside(ux, uy, doc.rects[i])) { hit = i; break; }
          }
          if (hit >= 0) {
            covered++;
            lr += lin[hit][0];
            lg += lin[hit][1];
            lb += lin[hit][2];
          }
        }
      }
      const o = (y * size + x) * 4;
      const total = ss * ss;
      if (covered === 0) { px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0; continue; }
      px[o] = toSrgb(lr / covered);
      px[o + 1] = toSrgb(lg / covered);
      px[o + 2] = toSrgb(lb / covered);
      px[o + 3] = Math.round((covered / total) * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------- PNG container

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none. Flat colour fields deflate fine unfiltered.
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- driver

function render(svgPath, size, outPath, ss) {
  const doc = parseSvg(fs.readFileSync(svgPath, 'utf8'));
  const png = encodePng(raster(doc, size, ss || 4), size);
  fs.writeFileSync(outPath, png);
  return { outPath, bytes: png.length, rects: doc.rects.length };
}

const BRAND = path.join(__dirname, '..', 'web', 'brand');
const MATRIX = [
  ['biii-icon-maskable.svg', [1024, 512, 192]],
  ['biii-icon.svg', [1024, 512, 180, 32]],
];

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 2) {
    const size = Number(argv[1]);
    if (!Number.isInteger(size) || size < 1) throw new Error('size must be a positive integer');
    const out = argv[0].replace(/\.svg$/, '') + '-' + size + '.png';
    const r = render(argv[0], size, out);
    console.log(r.outPath + '  ' + r.bytes + ' bytes');
  } else {
    for (const [name, sizes] of MATRIX) {
      for (const size of sizes) {
        const out = path.join(BRAND, name.replace(/\.svg$/, '') + '-' + size + '.png');
        const r = render(path.join(BRAND, name), size, out);
        console.log(String(size).padStart(5) + 'px  ' + String(r.bytes).padStart(7) + ' bytes  '
          + path.basename(r.outPath));
      }
    }
  }
}

module.exports = { render, parseSvg, raster, encodePng, inside };
