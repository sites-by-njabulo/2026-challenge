'use strict';
/* Draws the home-screen icons with plain Node (no packages): a dark square with the green lamp, the same mark as the app's brand.
   Writes public/icons/icon-192.png, icon-512.png and apple-touch-icon.png (180). Run: node scripts/make-icons.js
   The artwork fills the whole square and keeps everything inside the middle 72%, so it also works as a maskable icon. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const INK = [0x15, 0x17, 0x1a];
const LAMP = [0x0a, 0x7d, 0x5a];
const HALO = [0x1f, 0x3a, 0x33]; // the lamp glow on a dark background

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8 bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size) {
  const cx = size / 2, cy = size / 2;
  const rLamp = size * 0.2, rHalo = size * 0.33;
  const SS = 4; // 4x4 samples per pixel for smooth edges
  return png(size, (x, y) => {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const d = Math.hypot(x + (sx + 0.5) / SS - cx, y + (sy + 0.5) / SS - cy);
      const c = d <= rLamp ? LAMP : d <= rHalo ? HALO : INK;
      acc = acc.map((v, i) => v + c[i]);
    }
    return acc.map((v) => Math.round(v / (SS * SS)));
  });
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(out, name), draw(size));
  console.log('wrote public/icons/' + name);
}
