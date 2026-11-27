// Plain logic behind the team settings: what makes a team valid, which teams can be used now, and
// how levels are added or copied. No Svelte here, so it is tested on its own.
import { MAX_PER_TIER, MAX_TIERS, PALETTE, type Effort, type PaletteColour, type TeamProfile, type TierSpec } from '../../../../shared/protocol.ts';
import { ST } from './text.ts';
import type { BackendEntry, BackendModel } from './types.ts';

export const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh'];

export function backendOf(backends: BackendEntry[], id: string): BackendEntry | undefined {
  return backends.find((b) => b.id === id);
}

export function modelOf(backends: BackendEntry[], backend: string, model: string): BackendModel | undefined {
  return backendOf(backends, backend)?.models.find((m) => m.id === model);
}

/** A team can start now when the program of its levels is ready. Unknown programs (no report yet) count as not ready. */
export function usable(p: TeamProfile, backends: BackendEntry[]): boolean {
  const ids = new Set(p.tiers.map((t) => t.backend));
  return p.tiers.length > 0 && [...ids].every((id) => backendOf(backends, id)?.available === true);
}

export function usableProfiles(profiles: TeamProfile[], backends: BackendEntry[]): TeamProfile[] {
  return profiles.filter((p) => usable(p, backends));
}

/** Every problem with a team, in plain words, in the order a person would fix them. [] = fine. */
export function problems(p: TeamProfile, all: TeamProfile[], backends: BackendEntry[]): string[] {
  const out: string[] = [];
  const name = p.label.trim();
  if (!name) out.push(ST.problems.noName);
  else if (all.some((o) => o.id !== p.id && o.label.trim().toLowerCase() === name.toLowerCase())) out.push(ST.problems.nameTaken);
  if (p.tiers.length === 0) out.push(ST.problems.noLevels);
  if (p.tiers.length > MAX_TIERS) out.push(ST.problems.tooMany(MAX_TIERS));
  const programs = new Set(p.tiers.map((t) => t.backend));
  if (programs.size > 1) out.push(ST.problems.oneProgram);
  p.tiers.forEach((t, i) => {
    const n = i + 1;
    if (!t.model) return void out.push(ST.problems.noModel(n));
    const b = backendOf(backends, t.backend);
    // Only judge models against a program that reported its list.
    if (b?.available && b.models.length > 0) {
      const m = b.models.find((x) => x.id === t.model);
      if (!m) out.push(ST.problems.modelGone(n, t.label || t.model));
      else if (m.efforts.length > 0 && !m.efforts.includes(t.effort)) out.push(ST.problems.thinkingNotOffered(n));
    }
    if (i > 0 && (!Number.isInteger(t.max) || t.max < 0 || t.max > MAX_PER_TIER)) out.push(ST.problems.helpersRange(n, MAX_PER_TIER));
    if (i > 0 && t.max === 0 && i < p.tiers.length - 1) out.push(ST.problems.helpersZero(n));
  });
  for (const id of programs) {
    const b = backendOf(backends, id);
    if (b && !b.available) out.push(ST.problems.programNotReady(b.label));
  }
  return out;
}

/** The longest thinking time a model offers that is not above `want`. */
export function fitEffort(m: BackendModel | undefined, want: Effort): Effort {
  if (!m || m.efforts.length === 0) return want;
  for (let i = EFFORT_ORDER.indexOf(want); i >= 0; i--) if (m.efforts.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i]!;
  return m.efforts[0]!;
}

/** The first palette colour the team does not use yet. */
export function freeColour(p: TeamProfile): PaletteColour {
  return PALETTE.find((c) => !p.tiers.some((t) => t.colour === c)) ?? PALETTE[p.tiers.length % PALETTE.length]!;
}

/** A new last level: the same program as the level above, its smallest-listed model after the one above. */
export function addLevel(p: TeamProfile, backends: BackendEntry[]): TeamProfile {
  if (p.tiers.length >= MAX_TIERS) return p;
  const above = p.tiers[p.tiers.length - 1];
  const backend = above?.backend ?? backends.find((b) => b.available)?.id ?? 'claude-code';
  const list = backendOf(backends, backend)?.models ?? [];
  const at = above ? list.findIndex((m) => m.id === above.model) : -1;
  const m = list[Math.min(list.length - 1, at + 1)] ?? list[0];
  const tier: TierSpec = {
    id: `${p.id}:${p.tiers.length}`,
    label: m?.label ?? '',
    backend,
    model: m?.id ?? '',
    effort: fitEffort(m, 'medium'),
    max: p.tiers.length === 0 ? 1 : 2,
    lean: p.tiers.length > 0,
    colour: freeColour(p),
  };
  return { ...p, tiers: [...p.tiers, tier] };
}

export function removeLevel(p: TeamProfile, index: number): TeamProfile {
  if (index <= 0 || index >= p.tiers.length) return p; // the main assistant stays
  return { ...p, tiers: p.tiers.filter((_, i) => i !== index) };
}

/** A slug id for a person's own team that no other team has. */
export function newProfileId(label: string, all: TeamProfile[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'team';
  let id = base;
  for (let i = 2; all.some((p) => p.id === id); i++) id = `${base}-${i}`;
  return id;
}

/** A copy of a team that the person owns (not built in), with its own id and level ids. */
export function copyOf(p: TeamProfile, all: TeamProfile[]): TeamProfile {
  let label = ST.teams.copyOf(p.label);
  for (let i = 2; all.some((o) => o.label === label); i++) label = `${ST.teams.copyOf(p.label)} ${i}`;
  const id = newProfileId(label, all);
  return { id, label, builtIn: false, tiers: p.tiers.map((t, i) => ({ ...t, id: `${id}:${i}` })) };
}

/** Level `index` set to another model: the label follows the model unless the person named it, and the thinking time is fitted. */
export function withModel(t: TierSpec, m: BackendModel | undefined, previous: BackendModel | undefined): TierSpec {
  const named = t.label && previous && t.label !== previous.label;
  return { ...t, model: m?.id ?? '', label: named ? t.label : (m?.label ?? t.label), effort: fitEffort(m, t.effort) };
}
