/**
 * The order of Codex model families by capability, as the person asked for the generated Codex team:
 * lead on Astra, then Sol, then Terra, then Luna. Codex's own data has no capability rank (its
 * catalogue `priority` is only the picker order), so this small table is data, not logic: a family
 * that is not listed keeps the catalogue's own order, after the listed ones.
 */
import type { ModelInfo } from '../types.js';

export const CODEX_FAMILY_ORDER = ['astra', 'sol', 'terra', 'luna'];

/** "gpt-6.2-astra" -> { family: 'astra', version: [6, 2] }; null for an id of another shape. */
export function parseCodexModel(id: string): { family: string; version: number[] } | null {
  const m = /^[a-z]+-(\d+(?:\.\d+)*)-([a-z][a-z0-9]*)$/i.exec(id);
  if (!m) return null;
  return { family: m[2]!.toLowerCase(), version: m[1]!.split('.').map(Number) };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The models for a generated team, most capable first: for each known family the newest version the
 * account offers, in CODEX_FAMILY_ORDER; then the newest of each unknown family in the catalogue's
 * order (`order`, else list order). Models whose id has no family shape count as their own family.
 */
export function codexTeamModels(models: ModelInfo[]): ModelInfo[] {
  const best = new Map<string, { m: ModelInfo; version: number[]; index: number }>();
  models.forEach((m, index) => {
    const p = parseCodexModel(m.id);
    const family = p?.family ?? `id:${m.id}`;
    const version = p?.version ?? [];
    const cur = best.get(family);
    if (!cur || newer(version, cur.version)) best.set(family, { m, version, index: cur ? Math.min(cur.index, index) : index });
  });
  const known = CODEX_FAMILY_ORDER.flatMap((f) => (best.has(f) ? [best.get(f)!.m] : []));
  const rest = [...best.entries()]
    .filter(([f]) => !CODEX_FAMILY_ORDER.includes(f))
    .map(([, v]) => v)
    .sort((a, b) => (a.m.order ?? Infinity) - (b.m.order ?? Infinity) || a.index - b.index)
    .map((v) => v.m);
  return [...known, ...rest];
}
