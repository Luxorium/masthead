// What the server sends about the agent programs it found (state.backends and the `backends` reply).
import type { Effort } from '../../../../shared/protocol.ts';

export interface BackendModel {
  id: string;
  label: string;
  efforts: Effort[];
  contextWindow?: number;
  default?: boolean;
  description?: string;
}

export interface BackendEntry {
  id: string;
  label: string;
  available: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean | null;
  minVersion?: string;
  error?: string;
  warning?: string;
  models: BackendModel[];
}

/** Reads store.backends defensively: anything malformed is left out. */
export function readBackends(raw: unknown): BackendEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BackendEntry[] = [];
  for (const b of raw as Array<Record<string, unknown>>) {
    if (!b || typeof b.id !== 'string') continue;
    const models = Array.isArray(b.models)
      ? (b.models as Array<Record<string, unknown>>)
          .filter((m) => m && typeof m.id === 'string')
          .map((m) => ({
            id: m.id as string,
            label: typeof m.label === 'string' && m.label ? m.label : (m.id as string),
            efforts: Array.isArray(m.efforts) ? (m.efforts as Effort[]) : [],
            ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
            ...(m.default === true ? { default: true } : {}),
            ...(typeof m.description === 'string' ? { description: m.description } : {}),
          }))
      : [];
    out.push({
      id: b.id,
      label: typeof b.label === 'string' ? b.label : b.id,
      available: b.available === true,
      path: typeof b.path === 'string' ? b.path : null,
      version: typeof b.version === 'string' ? b.version : null,
      signedIn: typeof b.signedIn === 'boolean' ? b.signedIn : null,
      ...(typeof b.minVersion === 'string' ? { minVersion: b.minVersion } : {}),
      ...(typeof b.error === 'string' && b.error ? { error: b.error } : {}),
      ...(typeof b.warning === 'string' && b.warning ? { warning: b.warning } : {}),
      models,
    });
  }
  return out;
}
