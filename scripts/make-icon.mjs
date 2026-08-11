#!/usr/bin/env node
/**
 * Generates build/icon.ico with no image dependencies.
 *
 * Without an icon, electron-builder ships the default Electron logo — which for a
 * Japanese end user looks like they downloaded the wrong program.
 *
 * Design: dark rounded tile, three rising bars (the analytics), one pink heart
 * (the likes/ハートミー the app is really about).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZES = [256, 128, 64, 48, 32, 16];

const BG = [15, 17, 22, 255];
const TILE = [27, 31, 42, 255];
const TEAL = [41, 214, 196, 255];
const TEAL_D = [26, 141, 130, 255];
const PINK = [255, 92, 138, 255];

function render(S) {
  const px = new Uint8Array(S * S * 4);
  const put = (x, y, c, a = 1) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const sa = (c[3] / 255) * a;
    for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - sa) + c[k] * sa);
    px[i + 3] = Math.round(px[i + 3] + (255 - px[i + 3]) * sa);
  };

  const r = S * 0.22;
  const pad = S * 0.04;
  // Rounded tile with a soft edge so small sizes do not alias badly.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = Math.min(Math.max(x, pad + r), S - pad - r);
      const cy = Math.min(Math.max(y, pad + r), S - pad - r);
      const d = Math.hypot(x - cx, y - cy);
      const a = d <= r ? 1 : d >= r + 1.2 ? 0 : 1 - (d - r) / 1.2;
      if (a > 0) {
        put(x, y, BG, a);
        put(x, y, TILE, a * 0.85);
      }
    }
  }

  // Three bars, rising left to right.
  const bw = S * 0.13;
  const gap = S * 0.07;
  const baseY = S * 0.76;
  const x0 = S * 0.2;
  const heights = [0.22, 0.34, 0.46];
  heights.forEach((h, i) => {
    const bx = x0 + i * (bw + gap);
    const by = baseY - S * h;
    const col = i === 2 ? TEAL : TEAL_D;
    for (let y = by; y < baseY; y++) {
      for (let x = bx; x < bx + bw; x++) {
        // round the top corners
        const ry = Math.min(bw / 2, S * 0.03);
        let a = 1;
        if (y < by + ry) {
          const cx = Math.min(Math.max(x, bx + ry), bx + bw - ry);
          const d = Math.hypot(x - cx, y - (by + ry));
          a = d <= ry ? 1 : d >= ry + 1 ? 0 : 1 - (d - ry);
        }
        if (a > 0) put(Math.round(x), Math.round(y), col, a);
      }
    }
  });

  // Heart, upper right.
  const hs = S * 0.24;
  const hx = S * 0.66;
  const hy = S * 0.3;
  for (let y = -hs; y <= hs; y++) {
    for (let x = -hs; x <= hs; x++) {
      const u = x / hs;
      const v = -y / hs;
      // classic implicit heart curve
      const t = u * u + (v - Math.sqrt(Math.abs(u))) ** 2;
      if (t <= 1.0) put(Math.round(hx + x), Math.round(hy + y), PINK, t > 0.92 ? (1 - t) / 0.08 : 1);
    }
  }

  return px;
}

// ── minimal PNG encoder ─────────────────────────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(S, px) {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO container (PNG payloads, supported since Vista) ─────────────────────
const images = SIZES.map((S) => ({ S, buf: png(S, render(S)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const dir = [];
for (const im of images) {
  const e = Buffer.alloc(16);
  e[0] = im.S >= 256 ? 0 : im.S;
  e[1] = im.S >= 256 ? 0 : im.S;
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(im.buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += im.buf.length;
  dir.push(e);
}

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.ico', Buffer.concat([header, ...dir, ...images.map((i) => i.buf)]));
console.log(`build/icon.ico (${SIZES.join(', ')}) — ${(offset / 1024).toFixed(1)} KB`);
