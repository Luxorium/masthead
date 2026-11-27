import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_PROFILE,
  EFFORTS,
  MAX_PER_TIER,
  MAX_TIERS,
  PALETTE,
  PERMISSION_CHOICES,
  TIERS,
  VERSION,
  modelLabel,
  type Effort,
  type PaletteColour,
  type Settings,
  type TeamProfile,
  type Tier,
  type TierSpec,
} from '../../shared/protocol.js';
import { HOME, SETTINGS_FILE } from '../paths.js';
import { writeFileAtomic } from '../storage/atomic.js';

const MODEL_ID = /^[A-Za-z0-9._\-\[\]:]{1,80}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const BACKEND_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** The built-in Claude profile with today's defaults. Its tier ids are the 0.1.x tiers. */
export function claudeProfile(): TeamProfile {
  const t = (id: Tier, model: string, effort: Effort, max: number, lean: boolean, colour: PaletteColour): TierSpec => ({
    id,
    label: modelLabel(model),
    backend: 'claude-code',
    model,
    effort,
    max,
    lean,
    colour,
  });
  return {
    id: CLAUDE_PROFILE,
    label: 'Claude',
    builtIn: true,
    tiers: [
      t('lead', 'claude-fable-5-2', 'xhigh', 1, false, 'amber'),
      t('opus', 'claude-opus-5-5', 'xhigh', 3, true, 'violet'),
      t('sonnet', 'claude-sonnet-5-5', 'high', 4, true, 'blue'),
      t('haiku', 'claude-haiku-5-5', 'medium', 4, true, 'teal'),
    ],
  };
}

export function defaultSettings(): Settings {
  return withCompat({
    version: 2,
    profiles: [claudeProfile()],
    defaultProfile: CLAUDE_PROFILE,
    tiers: {} as Settings['tiers'],
    permissionMode: 'inherit',
    autoEffort: true,
    leanSubagents: true,
    leanOpus: true,
    collapseReports: false,
    maxRunMinutes: 0,
    defaultCwd: HOME,
  });
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.trunc(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Whether `p` is an absolute folder path on this system (`C:\\x` on Windows, `/x` elsewhere). */
export function absoluteFolder(p: unknown, paths: Pick<typeof path, 'isAbsolute'> = path): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= 4096 && paths.isAbsolute(p);
}

function claude(s: Settings): TeamProfile {
  return s.profiles.find((p) => p.id === CLAUDE_PROFILE)!;
}

/** Recomputes the compatibility fields (`tiers`, `leanSubagents`, `leanOpus`) from the claude profile. */
function withCompat(s: Settings): Settings {
  const c = claude(s);
  const by = (id: Tier) => c.tiers.find((t) => t.id === id)!;
  s.tiers = Object.fromEntries(TIERS.map((id) => [id, { model: by(id).model, effort: by(id).effort, max: by(id).max }])) as Settings['tiers'];
  s.leanSubagents = by('sonnet').lean && by('haiku').lean;
  s.leanOpus = by('opus').lean;
  return s;
}

/** One tier from untrusted input over `base` (its id and position are decided by the caller). */
function parseTier(raw: unknown, base: TierSpec, first: boolean): TierSpec {
  const t = { ...base };
  if (!raw || typeof raw !== 'object') return t;
  const r = raw as Record<string, unknown>;
  if (typeof r.model === 'string' && MODEL_ID.test(r.model)) {
    if (t.label === modelLabel(t.model)) t.label = modelLabel(r.model);
    t.model = r.model;
  }
  if (typeof r.label === 'string' && r.label.trim()) t.label = r.label.trim().slice(0, 40);
  if (typeof r.backend === 'string' && BACKEND_ID.test(r.backend)) t.backend = r.backend;
  if (EFFORTS.includes(r.effort as Effort)) t.effort = r.effort as Effort;
  if (!first) t.max = clampInt(r.max, 0, MAX_PER_TIER, t.max);
  if (typeof r.lean === 'boolean') t.lean = r.lean;
  if (PALETTE.includes(r.colour as PaletteColour)) t.colour = r.colour as PaletteColour;
  return t;
}

/**
 * The profile list from untrusted input. The claude profile keeps its four tiers and their ids (only
 * their settings change); other profiles get 1..MAX_TIERS tiers with ids `<profile>:<index>`.
 * Malformed or duplicate profiles are dropped; the claude profile is always present.
 */
function parseProfiles(raw: unknown[], prev: TeamProfile[]): TeamProfile[] {
  const out: TeamProfile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!PROFILE_ID.test(id) || seen.has(id)) continue;
    const before = prev.find((p) => p.id === id) ?? (id === CLAUDE_PROFILE ? claudeProfile() : undefined);
    const tiersIn = Array.isArray(r.tiers) ? r.tiers : [];
    let tiers: TierSpec[];
    if (id === CLAUDE_PROFILE) {
      const base = before!.tiers;
      tiers = base.map((b, i) => parseTier(tiersIn[i], b, i === 0));
    } else {
      if (tiersIn.length < 1 || tiersIn.length > MAX_TIERS) continue;
      tiers = tiersIn.map((t, i) => {
        const fallback: TierSpec = before?.tiers[i] ?? {
          id: '',
          label: '',
          backend: 'claude-code',
          model: '',
          effort: 'medium',
          max: i === 0 ? 1 : 2,
          lean: i > 0,
          colour: PALETTE[i % PALETTE.length]!,
        };
        const tier = parseTier(t, { ...fallback, id: `${id}:${i}` }, i === 0);
        if (!tier.label) tier.label = modelLabel(tier.model);
        return tier;
      });
      if (tiers.some((t) => !t.model)) continue;
    }
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 40) : (before?.label ?? id);
    const descIn = typeof r.description === 'string' ? r.description.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
    const description = descIn || before?.description;
    out.push({ id, label, ...(description ? { description } : {}), builtIn: id === CLAUDE_PROFILE || (before?.builtIn ?? false), tiers });
    seen.add(id);
  }
  if (!seen.has(CLAUDE_PROFILE)) out.unshift(prev.find((p) => p.id === CLAUDE_PROFILE) ?? claudeProfile());
  return out;
}

/** Applies `tiers` and the lean switches (the 0.1.x / compatibility shape) to the claude profile. */
function applyCompat(d: Settings, r: Record<string, unknown>, trusted: boolean): void {
  const c = claude(d);
  const tiersIn = (r.tiers && typeof r.tiers === 'object' ? r.tiers : {}) as Record<string, unknown>;
  c.tiers = c.tiers.map((t, i) => {
    const raw = tiersIn[t.id];
    // the lead's max is fixed at 1; a trusted base may carry anything there
    return parseTier(trusted && i === 0 && raw && typeof raw === 'object' ? { ...(raw as object), max: undefined } : raw, t, i === 0);
  });
  const lean = (id: Tier, v: unknown) => {
    if (typeof v === 'boolean') c.tiers.find((t) => t.id === id)!.lean = v;
  };
  // A trusted base always carries both switches (they mirror the profile); only change on a real difference.
  if (!trusted || r.leanSubagents !== (c.tiers[2]!.lean && c.tiers[3]!.lean)) {
    lean('sonnet', r.leanSubagents);
    lean('haiku', r.leanSubagents);
  }
  if (!trusted || r.leanOpus !== c.tiers[1]!.lean) lean('opus', r.leanOpus);
}

/**
 * Returns valid settings whatever was passed in. Fields that are missing, unknown or malformed keep
 * their value from `base` (the defaults unless given), so a partial update changes only what it names.
 *
 * Settings v2 keep tiers in `profiles`. Input without `profiles` (a 0.1.x file, or a patch from a page
 * that still sends `tiers` and the lean switches) is applied to the claude profile, which is how a
 * 0.1.x file is migrated. This is the one place settings are validated.
 */
export function sanitizeSettings(raw: unknown, base: Settings = defaultSettings()): Settings {
  const d = structuredClone(base);
  d.version = 2;
  if (!Array.isArray(d.profiles) || !d.profiles.some((p) => p.id === CLAUDE_PROFILE)) d.profiles = [claudeProfile(), ...(d.profiles ?? [])];
  // A base changed through its compatibility view (code that set `tiers` directly) wins over its profile.
  applyCompat(d, base as unknown as Record<string, unknown>, true);
  if (!raw || typeof raw !== 'object') return withCompat(d);
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.profiles)) {
    d.profiles = parseProfiles(r.profiles, d.profiles);
    // A whole settings object (profiles and the compatibility view): a view field that differs is a change.
    applyCompat(d, r, true);
  } else applyCompat(d, r, false);
  if (typeof r.defaultProfile === 'string' && d.profiles.some((p) => p.id === r.defaultProfile)) d.defaultProfile = r.defaultProfile;
  if (!d.profiles.some((p) => p.id === d.defaultProfile)) d.defaultProfile = CLAUDE_PROFILE;
  if (PERMISSION_CHOICES.includes(r.permissionMode as Settings['permissionMode'])) {
    d.permissionMode = r.permissionMode as Settings['permissionMode'];
  }
  if (typeof r.autoEffort === 'boolean') d.autoEffort = r.autoEffort;
  if (typeof r.collapseReports === 'boolean') d.collapseReports = r.collapseReports;
  d.maxRunMinutes = clampInt(r.maxRunMinutes, 0, 24 * 60, d.maxRunMinutes);
  if (absoluteFolder(r.defaultCwd)) d.defaultCwd = r.defaultCwd;
  return withCompat(d);
}

/**
 * Reads the settings file. A 0.1.x file (no `version`) is copied to `<file>.v1.bak` once, before
 * anything can overwrite it, and migrated in memory; the new format is written on the next save.
 */
export function loadSettings(file: string = SETTINGS_FILE): Settings {
  try {
    const text = readFileSync(file, 'utf8');
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw && typeof raw === 'object' && raw.version === undefined) {
      const bak = `${file}.v1.bak`;
      if (!existsSync(bak)) copyFileSync(file, bak);
    }
    return sanitizeSettings(raw);
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: Settings, file: string = SETTINGS_FILE): void {
  writeFileAtomic(file, JSON.stringify(s, null, 2) + '\n');
}


/**
 * The scheduler's limit for a tier: unlimited for the first tier of any profile (each conversation
 * always has its lead), the tier's `max` otherwise, and 0 for a tier no profile has any more.
 */
export function tierLimit(s: Settings, tier: string): number {
  for (const p of s.profiles) {
    const i = p.tiers.findIndex((t) => t.id === tier);
    if (i === 0) return Infinity;
    if (i > 0) return p.tiers[i]!.max;
  }
  return 0;
}

/**
 * Adds generated built-in profiles (e.g. Codex, from the installed CLI) that the settings do not hold
 * yet. A stored copy (the person edited it) wins and is kept as it is. Ids must follow
 * `<profile>:<index>` from 0; the result is validated like any other settings.
 */
export function withBuiltInProfiles(s: Settings, generated: TeamProfile[]): Settings {
  const extra = generated.filter((g) => !s.profiles.some((p) => p.id === g.id));
  if (!extra.length) return s;
  const out = sanitizeSettings({ profiles: [...s.profiles, ...extra] }, s);
  for (const g of extra) {
    const p = out.profiles.find((x) => x.id === g.id);
    if (p) p.builtIn = true;
  }
  return out;
}
