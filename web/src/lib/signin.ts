// Signing this browser in: the key from the address or from storage, and whether the server is up.
// No Svelte state here, so it can be tested on its own.

export const KEY_STORAGE = 'masthead.key';

/**
 * The sign-in key. `masthead` opens the page with `?key=…`; it is kept in this browser and taken out
 * of the address bar so it is not left in history or bookmarks.
 */
let pageKey: string | null = null;
/**
 * A key that came in the address and has not yet been accepted by the server. It replaces the stored
 * key only once a socket opened with it, so a link to `…/#key=junk` cannot sign a browser out.
 */
let candidate: string | null = null;

/**
 * The key to connect with, and whether it is an untried candidate. `masthead` opens the page with
 * the key in the fragment (`#key=…`), which is never sent to the server or kept in its logs; `?key=`
 * from older launchers still works. Either way it is taken out of the address bar at once.
 */
export function takeKey(): { key: string | null; untried: boolean } {
  const url = new URL(location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const fromUrl = hash.get('key') || url.searchParams.get('key');
  if (fromUrl) {
    candidate = fromUrl;
    url.searchParams.delete('key');
    // URLSearchParams would re-encode a route such as `/c/<id>`; keep the rest of the hash as written.
    const rest = url.hash.slice(1).split('&').filter((part) => part && !part.startsWith('key=')).join('&');
    history.replaceState(history.state, '', url.pathname + url.search + (rest ? `#${rest}` : ''));
  }
  if (candidate) return { key: candidate, untried: true };
  return { key: storedKey(), untried: false };
}

/** The stored key, read again each time: another tab may have been signed in with a newer key. */
export function storedKey(): string | null {
  try {
    pageKey = localStorage.getItem(KEY_STORAGE) ?? pageKey;
  } catch {
    // Keep the key this page already had.
  }
  return pageKey;
}

/** Whether the Masthead server answers at all (it needs no key). */
export async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/** The server accepted the candidate: it becomes the stored key. */
export function keepCandidate(): void {
  if (!candidate) return;
  pageKey = candidate;
  try {
    localStorage.setItem(KEY_STORAGE, candidate);
  } catch {
    // Storage refused (private mode): the key still works for this page load.
  }
  candidate = null;
}

export function idFromHash(): string | null {
  const m = /^#\/c\/([A-Za-z0-9_-]+)$/.exec(location.hash);
  return m ? m[1]! : null;
}


/** Whether a key from the address is waiting to be tried. */
export function hasCandidate(): boolean {
  return candidate !== null;
}

/** Forgets a refused candidate key. */
export function dropCandidate(): void {
  candidate = null;
}

/** For tests: forget everything this module remembers. */
export function resetSignin(): void {
  pageKey = null;
  candidate = null;
}

// ---- remote devices (Tailscale access, served over https) ----

const DEVICE_STORAGE = 'masthead.device';

/** The page runs on a remote device: golf's remote listener is https, the local page is plain http. */
export function isRemoteDevice(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

export function deviceToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_STORAGE);
  } catch {
    return null;
  }
}

export function saveDeviceToken(token: string): void {
  try {
    localStorage.setItem(DEVICE_STORAGE, token);
  } catch {
    // Private mode: the token works for this page load only.
  }
}

export function forgetDeviceToken(): void {
  try {
    localStorage.removeItem(DEVICE_STORAGE);
  } catch {
    // Nothing stored.
  }
}
