// Draws a picture with text: each terminal cell shows a Unicode quadrant block and two colors, covering 2×2
// pixels. It works in any terminal and over SSH, where the kitty graphics protocol does not reach.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function decodeBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? (LOOKUP[code] ?? -1) : -1;
    if (value < 0) continue;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    parts.push(
      (ALPHABET[(n >> 18) & 63] ?? "") +
        (ALPHABET[(n >> 12) & 63] ?? "") +
        (b === undefined ? "=" : (ALPHABET[(n >> 6) & 63] ?? "")) +
        (c === undefined ? "=" : (ALPHABET[n & 63] ?? ""))
    );
  }
  return parts.join("");
}

/** A picture as colors `0xRRGGBB`, read by pixel. */
export type Pixels = { width: number; height: number; at: (x: number, y: number) => number };

/** Reads an uncompressed 24- or 32-bit BMP, as ImageMagick (`bmp3:`) and sips write them. */
export function readBmp(bytes: Uint8Array): Pixels | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(10, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  if (width <= 0 || rawHeight === 0 || (bpp !== 24 && bpp !== 32)) return null;
  const height = Math.abs(rawHeight);
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const step = bpp / 8;
  const at = (x: number, y: number) => {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    const row = rawHeight < 0 ? cy : height - 1 - cy;
    const i = offset + row * stride + cx * step;
    return ((bytes[i + 2] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i] ?? 0);
  };
  return { width, height, at };
}

// The quadrant block for each set of lit quarters: bit 0 top left, 1 top right, 2 bottom left, 3 bottom right.
const QUADRANTS = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588];

const red = (c: number) => (c >> 16) & 0xff;
const green = (c: number) => (c >> 8) & 0xff;
const blue = (c: number) => c & 0xff;

/**
 * The cells of a `Raster` `columns` wide and `rows` tall, from a picture of `columns * 2` by `rows * 2`
 * pixels: each cell takes the quadrant pattern and the two colors closest to its four pixels.
 */
export function quadrantCells(picture: Pixels, columns: number, rows: number): string {
  const out = new Uint8Array(columns * rows * 12);
  const view = new DataView(out.buffer);
  const quad = [0, 0, 0, 0];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      quad[0] = picture.at(col * 2, row * 2);
      quad[1] = picture.at(col * 2 + 1, row * 2);
      quad[2] = picture.at(col * 2, row * 2 + 1);
      quad[3] = picture.at(col * 2 + 1, row * 2 + 1);
      let bestMask = 15;
      let bestFg = 0;
      let bestBg = 0;
      let bestError = Infinity;
      for (let mask = 1; mask <= 15; mask += 1) {
        let litR = 0, litG = 0, litB = 0, darkR = 0, darkG = 0, darkB = 0, lit = 0;
        for (let q = 0; q < 4; q += 1) {
          const c = quad[q] ?? 0;
          if ((mask >> q) & 1) {
            litR += red(c); litG += green(c); litB += blue(c); lit += 1;
          } else {
            darkR += red(c); darkG += green(c); darkB += blue(c);
          }
        }
        const dark = 4 - lit;
        const fg = [Math.round(litR / lit), Math.round(litG / lit), Math.round(litB / lit)];
        const bg = dark ? [Math.round(darkR / dark), Math.round(darkG / dark), Math.round(darkB / dark)] : fg;
        let error = 0;
        for (let q = 0; q < 4; q += 1) {
          const c = quad[q] ?? 0;
          const target = (mask >> q) & 1 ? fg : bg;
          error += (red(c) - (target[0] ?? 0)) ** 2 + (green(c) - (target[1] ?? 0)) ** 2 + (blue(c) - (target[2] ?? 0)) ** 2;
        }
        if (error < bestError) {
          bestError = error;
          bestMask = mask;
          bestFg = ((fg[0] ?? 0) << 16) | ((fg[1] ?? 0) << 8) | (fg[2] ?? 0);
          bestBg = ((bg[0] ?? 0) << 16) | ((bg[1] ?? 0) << 8) | (bg[2] ?? 0);
        }
      }
      const i = (row * columns + col) * 12;
      view.setUint32(i, QUADRANTS[bestMask] ?? 0x2588, true);
      view.setUint32(i + 4, bestFg, true);
      view.setUint32(i + 8, bestBg, true);
    }
  }
  return encodeBase64(out);
}
