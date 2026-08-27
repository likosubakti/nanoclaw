#!/usr/bin/env node
/**
 * Renders the application icon to PNG at every size Linux desktops ask for.
 *
 * Deliberately dependency-free: build machines rarely have ImageMagick or
 * librsvg, and shipping a rasteriser we control means `npm run icons` produces
 * identical bytes everywhere. The mark is three overlapping discs — one per
 * backend (GLM, Claude, Codex) — over a rounded dark tile.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const SUPERSAMPLE = 4;

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

/** Encodes an RGBA byte buffer as a PNG (colour type 6, no interlacing). */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- drawing ---- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance from a point to a rounded rectangle, negative inside. */
function roundedRectSdf(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - (halfW - radius);
  const qy = Math.abs(py) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Renders one square frame at `size` pixels using SUPERSAMPLE x SUPERSAMPLE
 * box-filtered sampling, and returns an RGBA buffer.
 */
function render(size) {
  const ss = size >= 64 ? SUPERSAMPLE : SUPERSAMPLE * 2; // small icons need more
  const hi = size * ss;
  const acc = new Float64Array(size * size * 4);

  const tile = { halfW: hi * 0.5, halfH: hi * 0.5, radius: hi * 0.215 };

  // Three discs on a triangle around the centre, one per backend.
  const discs = [
    { angle: -Math.PI / 2, color: [0x38, 0xbd, 0xf8] }, // GLM      — sky
    { angle: Math.PI / 6, color: [0xf9, 0x73, 0x16] }, // Claude   — ember
    { angle: (5 * Math.PI) / 6, color: [0xa7, 0x8b, 0xfa] }, // Codex — violet
  ];
  const orbit = hi * 0.135;
  const discRadius = hi * 0.235;

  for (let y = 0; y < hi; y++) {
    const oy = Math.floor(y / ss);
    for (let x = 0; x < hi; x++) {
      const ox = Math.floor(x / ss);
      const px = x + 0.5 - hi / 2;
      const py = y + 0.5 - hi / 2;

      // Tile coverage (1px feather).
      const d = roundedRectSdf(px, py, tile.halfW, tile.halfH, tile.radius);
      const tileAlpha = clamp01(0.5 - d / ss);
      if (tileAlpha <= 0) continue;

      // Vertical gradient backdrop.
      const t = clamp01((py + hi / 2) / hi);
      let r = mix(0x14, 0x07, t);
      let g = mix(0x1d, 0x0b, t);
      let b = mix(0x2e, 0x14, t);

      // Discs, blended with a screen operator so the overlaps glow.
      for (const disc of discs) {
        const cx = Math.cos(disc.angle) * orbit;
        const cy = Math.sin(disc.angle) * orbit;
        const dist = Math.hypot(px - cx, py - cy);
        const cov = clamp01((discRadius - dist) / (ss * 1.2)) * 0.82;
        if (cov <= 0) continue;
        r = 255 - ((255 - r) * (255 - disc.color[0] * cov)) / 255;
        g = 255 - ((255 - g) * (255 - disc.color[1] * cov)) / 255;
        b = 255 - ((255 - b) * (255 - disc.color[2] * cov)) / 255;
      }

      // Hairline rim so the tile reads on light and dark panels alike.
      const rim = clamp01(1 - Math.abs(d + ss * 0.9) / (ss * 0.9)) * 0.22;
      r = mix(r, 255, rim);
      g = mix(g, 255, rim);
      b = mix(b, 255, rim);

      const i = (oy * size + ox) * 4;
      acc[i] += r * tileAlpha;
      acc[i + 1] += g * tileAlpha;
      acc[i + 2] += b * tileAlpha;
      acc[i + 3] += 255 * tileAlpha;
    }
  }

  const samples = ss * ss;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const alpha = acc[i * 4 + 3] / samples;
    out[i * 4 + 3] = Math.round(clamp01(alpha / 255) * 255);
    // Un-premultiply so edge pixels keep their colour instead of darkening.
    const scale = alpha > 0.0001 ? 255 / alpha : 0;
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = Math.round(clamp01((acc[i * 4 + c] / samples) * scale * (1 / 255)) * 255);
    }
  }
  return out;
}

export async function generateIcons() {
  const dir = path.join(root, 'resources/icons');
  await mkdir(dir, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(render(size), size, size);
    await writeFile(path.join(dir, `${size}x${size}.png`), png);
  }
  // electron-builder and most desktop tooling look for a canonical icon.png.
  await writeFile(path.join(dir, 'icon.png'), encodePng(render(512), 512, 512));
  console.log(`[icons] wrote ${SIZES.length + 1} PNGs to resources/icons/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await generateIcons();
}
