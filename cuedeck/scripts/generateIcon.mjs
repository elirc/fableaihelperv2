// Generates the project-owned placeholder icon: a deep-ink rounded square
// with a teal waveform mark, written as PNG and PNG-in-ICO (Vista+ format).
// Run: node scripts/generateIcon.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZE = 256;

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---- draw ------------------------------------------------------------------
const px = new Uint8Array(SIZE * SIZE * 4);
const bg = [0x0b, 0x10, 0x20]; // --canvas
const card = [0x17, 0x21, 0x3a]; // --surface-2
const accent = [0x35, 0xd0, 0xba]; // --accent

const bars = [
  // waveform bars: [xCenter fraction, height fraction]
  [0.22, 0.22],
  [0.32, 0.42],
  [0.42, 0.66],
  [0.52, 0.5],
  [0.62, 0.74],
  [0.72, 0.36],
  [0.82, 0.2],
];
const radius = 44;

function inRoundedSquare(x, y) {
  const min = 8;
  const max = SIZE - 9;
  if (x < min || x > max || y < min || y > max) return false;
  const cx = Math.max(min + radius, Math.min(max - radius, x));
  const cy = Math.max(min + radius, Math.min(max - radius, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 || (x >= min + radius && x <= max - radius) || (y >= min + radius && y <= max - radius);
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    if (!inRoundedSquare(x, y)) {
      px[i + 3] = 0; // transparent corner
      continue;
    }
    // vertical card gradient
    const t = y / SIZE;
    let r = bg[0] + (card[0] - bg[0]) * t;
    let g = bg[1] + (card[1] - bg[1]) * t;
    let b = bg[2] + (card[2] - bg[2]) * t;
    for (const [fx, fh] of bars) {
      const barX = fx * SIZE;
      const barHalf = 9;
      const barTop = SIZE / 2 - (fh * SIZE) / 2;
      const barBottom = SIZE / 2 + (fh * SIZE) / 2;
      if (Math.abs(x - barX) <= barHalf && y >= barTop && y <= barBottom) {
        [r, g, b] = accent;
      }
    }
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
}

// ---- encode PNG -------------------------------------------------------------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ---- wrap in ICO -------------------------------------------------------------
const ico = Buffer.alloc(6 + 16 + png.length);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // count
ico[6] = 0; // width 256 -> 0
ico[7] = 0; // height 256 -> 0
ico.writeUInt16LE(1, 12); // planes
ico.writeUInt16LE(32, 14); // bpp
ico.writeUInt32LE(png.length, 8 + 6);
ico.writeUInt32LE(6 + 16, 12 + 6);
png.copy(ico, 6 + 16);

mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.png', png);
writeFileSync('assets/icon.ico', ico);
console.warn('wrote assets/icon.png and assets/icon.ico');
