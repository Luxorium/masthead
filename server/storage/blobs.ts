// Image files of one conversation: `<conversation>/blobs/<sha256>.<ext>`, named by the hash of their
// bytes so the same image is stored once. They go when the conversation's folder goes.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { renameRetry } from './atomic.js';
import { join } from 'node:path';
import { EXT, TYPE_OF_EXT, sniffImage, type ImageType } from './images.js';

/** How an item refers to a stored image. */
export interface BlobRef {
  blob: string;
  mediaType: ImageType;
  w: number;
  h: number;
  bytes: number;
}

export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 30 * 1024 * 1024;
/** Per conversation: generous for screenshots over a long run, small enough not to fill a disk unseen. */
export const MAX_CONVERSATION_BLOB_BYTES = 500 * 1024 * 1024;
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 40_000_000;

export type BlobErrorCode = 'too_large' | 'invalid' | 'not_found';
export class BlobError extends Error {
  constructor(
    readonly code: BlobErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

export class BlobStore {
  /** `root` is the conversations folder; each conversation keeps its own `blobs/`. */
  constructor(private root: string) {}

  private dir(convId: string): string {
    if (!SAFE_ID.test(convId)) throw new BlobError('invalid', 'Bad conversation id.');
    return join(this.root, convId, 'blobs');
  }

  /** Checks and stores image bytes. The type comes from the bytes; a declared type must agree. */
  put(convId: string, bytes: Uint8Array, declared?: string): BlobRef {
    if (bytes.length === 0) throw new BlobError('invalid', 'The image is empty.');
    if (bytes.length > MAX_BLOB_BYTES) throw new BlobError('too_large', 'An image may be at most 5 MB.');
    const info = sniffImage(bytes);
    if (!info) throw new BlobError('invalid', 'Only PNG, JPEG, GIF and WebP images can be stored.');
    if (declared && declared !== info.mediaType) throw new BlobError('invalid', `The image says it is ${declared} but its contents are ${info.mediaType}.`);
    if (info.w > MAX_SIDE || info.h > MAX_SIDE || info.w * info.h > MAX_PIXELS) throw new BlobError('too_large', 'The image is too large (at most 8192 pixels a side, 40 megapixels).');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const dir = this.dir(convId);
    const file = join(dir, `${hash}.${EXT[info.mediaType]}`);
    if (!existsSync(file)) {
      if (this.total(convId) + bytes.length > MAX_CONVERSATION_BLOB_BYTES) throw new BlobError('too_large', 'This conversation has reached its 500 MB of images.');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${hash}.${randomBytes(4).toString('hex')}.tmp`);
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameRetry(tmp, file);
    }
    return { blob: hash, mediaType: info.mediaType, w: info.w, h: info.h, bytes: bytes.length };
  }

  /** The file of a stored blob and its type, or null. Only names Masthead wrote are ever looked up. */
  find(convId: string, hash: string): { file: string; mediaType: ImageType } | null {
    if (!SAFE_ID.test(convId) || !HASH.test(hash)) return null;
    const dir = this.dir(convId);
    for (const [ext, type] of Object.entries(TYPE_OF_EXT)) {
      const file = join(dir, `${hash}.${ext}`);
      try {
        if (statSync(file).isFile()) return { file, mediaType: type };
      } catch {
        // not this extension
      }
    }
    return null;
  }

  private names(convId: string): string[] {
    try {
      return readdirSync(this.dir(convId)).filter((n) => /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(n));
    } catch {
      return [];
    }
  }

  total(convId: string): number {
    let n = 0;
    for (const name of this.names(convId)) {
      try {
        n += statSync(join(this.dir(convId), name)).size;
      } catch {
        // removed meanwhile
      }
    }
    return n;
  }

  /** Removes blobs no item refers to any more. Returns how many were removed. */
  collect(convId: string, referenced: Iterable<string>): number {
    const keep = new Set(referenced);
    let removed = 0;
    for (const name of this.names(convId)) {
      if (keep.has(name.slice(0, 64))) continue;
      try {
        unlinkSync(join(this.dir(convId), name));
        removed++;
      } catch {
        // gone already
      }
    }
    return removed;
  }
}

/** Every blob hash an item refers to: the person's attachments and tool-result images. */
export function blobsOf(item: unknown): string[] {
  const images = (item as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) return [];
  return images.map((r) => (r as BlobRef | null)?.blob).filter((h): h is string => typeof h === 'string' && HASH.test(h));
}
