// Pictures in the page: where a stored image is fetched from, uploading one, and shrinking large
// photos before upload. The server stores images per conversation (core.md 6.2): PNG, JPEG, GIF, WebP,
// at most 5 MB and 8192 px a side, the type checked from the file itself.
import type { BlobRef, ImageAttachment } from '../../../shared/protocol.ts';
import { deviceToken, isRemoteDevice, storedKey } from './signin.ts';

/** What the server accepts for one image. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Photos bigger than this, or with a longer side than LONG_EDGE, are shrunk in the browser first. */
const SHRINK_OVER_BYTES = 2 * 1024 * 1024;
const LONG_EDGE = 2560;
/** The largest file the page will try to shrink; anything bigger is refused at once. */
export const MAX_PICK_BYTES = 40 * 1024 * 1024;

/** The address of a stored image. `token` is the socket's blob token from `state`. */
export function blobUrl(convId: string, ref: BlobRef, token: string | null): string {
  return `/blob/${encodeURIComponent(convId)}/${ref.blob}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
}

/** Uploads one image to a conversation and returns how the server stored it. */
export async function uploadImage(convId: string, data: Blob, mediaType: ImageAttachment['mediaType']): Promise<BlobRef> {
  const res = await fetch(`/blob?conv=${encodeURIComponent(convId)}`, {
    method: 'POST',
    // The local page proves itself with its key; a remote device with its approved token.
    headers: { 'content-type': mediaType, ...(isRemoteDevice() ? { 'x-masthead-device': deviceToken() ?? '' } : { 'x-masthead-key': storedKey() ?? '' }) },
    body: data,
  });
  const body = (await res.json().catch(() => ({}))) as BlobRef & { message?: string };
  if (!res.ok) throw new Error(body.message || `The picture could not be uploaded (${res.status}).`);
  return body;
}

/**
 * Shrinks a large photo so its longer side is at most 2560 px and it fits the server's 5 MB, keeping
 * PNG for pictures with transparency (screenshots) and JPEG otherwise. GIFs are left alone (they may
 * move). Returns the original when it is already small enough or the browser cannot decode it.
 */
export async function shrinkIfLarge(file: File): Promise<{ blob: Blob; mediaType: ImageAttachment['mediaType'] }> {
  const type = file.type as ImageAttachment['mediaType'];
  if (type === 'image/gif' || typeof createImageBitmap !== 'function') return { blob: file, mediaType: type };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, mediaType: type };
  }
  const long = Math.max(bitmap.width, bitmap.height);
  if (file.size <= SHRINK_OVER_BYTES && long <= LONG_EDGE) {
    bitmap.close();
    return { blob: file, mediaType: type };
  }
  const scale = Math.min(1, LONG_EDGE / long);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return { blob: file, mediaType: type };
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const keepPng = type === 'image/png' && file.size <= MAX_UPLOAD_BYTES * 2;
  const out = keepPng ? await canvas.convertToBlob({ type: 'image/png' }) : await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  if (keepPng && out.size > MAX_UPLOAD_BYTES) return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }), mediaType: 'image/jpeg' };
  return { blob: out, mediaType: keepPng ? 'image/png' : 'image/jpeg' };
}

/** A Blob as base64 without the data: prefix (for the first message of a new chat). */
export function toBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
