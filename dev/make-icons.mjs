#!/usr/bin/env node
/**
 * Draw the extension's toolbar icons.
 *
 * Chrome wants PNGs at several sizes and will not take an SVG for a toolbar
 * action, so the marks are generated rather than hand-drawn — no binary blobs
 * in the repository that nobody can edit, and no image library to install. The
 * shape is described in code, rendered at 4x and downsampled, which is what
 * keeps the 16px version from turning into mush.
 *
 *   node dev/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "spirekeeper_v2/extension/icons");
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor

// The Symbiote's palette, so the toolbar button and the panel match.
const BG = [27, 29, 34];       // #1b1d22
const MARK = [200, 135, 59];   // #c8873b

/**
 * Is this point inside the mark?
 *
 * A crenellated keep. Two earlier attempts drew a tower with a pitched roof;
 * at icon size a wide roof reads as a house and a narrow one with overhanging
 * eaves reads as an arrow. Battlements have no such ambiguity — the notched
 * top says "castle" immediately, survives 16 pixels, and is the half of the
 * name that is actually a building.
 *
 * Drawn in normalised 0..1 space so one description serves every size.
 */
function inMark(x, y) {
  const LEFT = 0.24;
  const RIGHT = 0.76;
  const TOP = 0.26;
  const BOTTOM = 0.82;

  if (x < LEFT || x > RIGHT || y < TOP || y > BOTTOM) return false;

  // Battlements: three merlons with two gaps cut between them. Sized so the
  // gaps stay open at 16px, where anything narrower fills in and the top edge
  // flattens back into a plain rectangle.
  if (y < TOP + 0.14) {
    const MERLONS = [
      [0.24, 0.365],
      [0.4375, 0.5625],
      [0.635, 0.76],
    ];
    return MERLONS.some(([a, b]) => x >= a && x <= b);
  }

  // A gate, open at the base, arched by cutting the corners of its top.
  const gateHalf = 0.1;
  if (y > 0.54 && Math.abs(x - 0.5) < gateHalf) {
    const t = (y - 0.54) / 0.1;          // 0 at the springing line, 1 below it
    const arch = Math.min(1, t);
    if (Math.abs(x - 0.5) <= gateHalf * (0.35 + 0.65 * arch)) return false;
  }

  return true;
}

/** Rounded-square background, the shape Chrome expects of a toolbar icon. */
function inBackground(x, y) {
  const r = 0.16;
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return Math.hypot(dx, dy) <= r;
}

function render(size) {
  const px = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let mark = 0;

      // Supersample: count how many sub-pixels land inside each shape, which
      // gives coverage-based alpha instead of a staircase edge.
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (inBackground(u, v)) bg++;
          if (inMark(u, v)) mark++;
        }
      }

      const total = SS * SS;
      const bgA = bg / total;
      const markA = (mark / total) * bgA; // the mark never spills past the tile

      // Composite mark over background, then the whole thing over transparency.
      const alpha = bgA;
      const blend = (c1, c2) => Math.round(c1 * (1 - markA) + c2 * markA);
      const i = (y * size + x) * 4;
      px[i] = blend(BG[0], MARK[0]);
      px[i + 1] = blend(BG[1], MARK[1]);
      px[i + 2] = blend(BG[2], MARK[2]);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// --- a minimal PNG writer ---------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type; 0 means "none", which is
  // fine for images this small and keeps the writer trivial.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const png = toPng(size, render(size));
  writeFileSync(resolve(OUT, `icon-${size}.png`), png);
  console.log(`  icon-${size}.png  ${png.length} bytes`);
}
console.log(`written to spirekeeper_v2/extension/icons/`);
