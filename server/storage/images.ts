// Decides an image's type from its bytes and reads its size from the header. No native library:
// only the few header fields needed. Anything that is not clearly PNG, JPEG, GIF or WebP is refused.

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const TYPE_OF_EXT: Record<string, ImageType> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface ImageInfo {
  mediaType: ImageType;
  w: number;
  h: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function png(b: Uint8Array): ImageInfo | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== 'IHDR') return null;
  return { mediaType: 'image/png', w: u32be(b, 16), h: u32be(b, 20) };
}

function gif(b: Uint8Array): ImageInfo | null {
  if (b.length < 10 || (ascii(b, 0, 6) !== 'GIF87a' && ascii(b, 0, 6) !== 'GIF89a')) return null;
  return { mediaType: 'image/gif', w: u16le(b, 6), h: u16le(b, 8) };
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mediaType: 'image/webp', w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!;
    return { mediaType: 'image/webp', w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8X') return { mediaType: 'image/webp', w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
  return null;
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // Start-of-frame markers carry the size; C4 (huffman), C8 and CC (arithmetic tables) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mediaType: 'image/jpeg', h: u16be(b, i + 5), w: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** The image's type and size from its bytes, or null if it is not one of the four accepted types. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const info = png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
  if (!info || info.w < 1 || info.h < 1) return null;
  return info;
}
