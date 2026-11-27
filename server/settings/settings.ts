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
    keepAwake: true,
    autoCompact: true,
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
  if (typeof r.backend === 'string') {
    if (BACKEND_ID.test(r.backend)) {
      t.backend = r.backend;
      delete t.unusable;
    } else {
      // Kept as found (never silently swapped for Claude Code with, say, a Codex model id); the tier cannot start.
      t.backend = r.backend.slice(0, 80);
      t.unusable = `"${t.backend}" is not a valid agent program name.`;
    }
  }
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
  if (typeof r.keepAwake === 'boolean') d.keepAwake = r.keepAwake;
  if (typeof d.keepAwake !== 'boolean') d.keepAwake = true; // settings made before the field existed
  if (typeof r.autoCompact === 'boolean') d.autoCompact = r.autoCompact;
  if (typeof d.autoCompact !== 'boolean') d.autoCompact = true;
  d.maxRunMinutes = clampInt(r.maxRunMinutes, 0, 24 * 60, d.maxRunMinutes);
  if (absoluteFolder(r.defaultCwd)) d.defaultCwd = r.defaultCwd;
  return withCompat(d);
}

/** The settings format this Masthead writes. */
export const SETTINGS_FORMAT = 2;

/**
 * A sibling copy written on every save that Masthead 0.1.x never touches, so going back to 0.1.x and
 * returning does not lose the teams (0.1.x rewrites `settings.json` without them).
 */
export function v2CopyOf(file: string): string {
  return file.endsWith('.json') ? `${file.slice(0, -5)}.v2.json` : `${file}.v2`;
}

/** Settings files this process must not write, with the reason shown to the person. */
const readOnly = new Map<string, string>();

/** Why `file` is not being saved (settings from a newer Masthead), or undefined. */
export function settingsProblem(file: string = SETTINGS_FILE): string | undefined {
  return readOnly.get(file);
}

/** What Masthead 0.1.x could have changed in its settings file (it knew nothing of profiles). */
const V1_FIELDS = ['tiers', 'leanSubagents', 'leanOpus', 'permissionMode', 'autoEffort', 'collapseReports', 'maxRunMinutes', 'defaultCwd'] as const;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the settings file.
 * - A 0.1.x file (no `version`) is copied to `<file>.v1.bak` once and migrated in memory. If a v2 copy
 *   exists (`v2CopyOf`), the person went back to 0.1.x and returned: the copy's teams and 0.2.0-only
 *   fields are kept, and only what 0.1.x could change is taken from the file.
 * - An unreadable file is copied to `<file>.unreadable-<time>` before anything can overwrite it.
 * - A file from a newer Masthead (version above SETTINGS_FORMAT) is never written by this one: the
 *   app runs on defaults in memory and `settingsProblem()` says why.
 */
export function loadSettings(file: string = SETTINGS_FILE): Settings {
  readOnly.delete(file);
  if (!existsSync(file)) return defaultSettings();
  const raw = readJson(file);
  if (!raw) {
    try {
      copyFileSync(file, `${file}.unreadable-${Date.now()}`);
    } catch {
      // nothing more to save
    }
    return defaultSettings();
  }
  if (typeof raw.version === 'number' && raw.version > SETTINGS_FORMAT) {
    readOnly.set(file, `These settings are from a newer Masthead (format ${raw.version}). This version will not change them; it runs on its defaults until you update.`);
    return defaultSettings();
  }
  if (raw.version === undefined) {
    const bak = `${file}.v1.bak`;
    try {
      if (!existsSync(bak)) copyFileSync(file, bak);
    } catch {
      // the migration still runs in memory
    }
    const copy = readJson(v2CopyOf(file));
    if (copy && copy.version === SETTINGS_FORMAT) {
      const older: Record<string, unknown> = {};
      for (const k of V1_FIELDS) if (k in raw) older[k] = raw[k];
      return sanitizeSettings(older, sanitizeSettings(copy));
    }
  }
  return sanitizeSettings(raw);
}

/** Writes the settings and their v2 copy; does nothing for a file from a newer Masthead. */
export function saveSettings(s: Settings, file: string = SETTINGS_FILE): void {
  if (readOnly.has(file)) return;
  const text = JSON.stringify(s, null, 2) + '\n';
  writeFileAtomic(file, text);
  writeFileAtomic(v2CopyOf(file), text);
}

/** How many of `convProfiles` (each conversation's profile id) use profile `id`. */
export function chatsUsing(id: string, convProfiles: Iterable<string | undefined>): number {
  let n = 0;
  for (const p of convProfiles) if ((p ?? CLAUDE_PROFILE) === id) n++;
  return n;
}

/**
 * The settings without profile `id`. The built-in claude profile cannot be deleted. Returns the
 * settings unchanged when there is nothing to delete. Callers refuse first while chats use it
 * (`chatsUsing`), unless the person confirmed.
 */
export function deleteProfile(s: Settings, id: string): Settings {
  if (id === CLAUDE_PROFILE || !s.profiles.some((p) => p.id === id)) return s;
  return sanitizeSettings({ profiles: s.profiles.filter((p) => p.id !== id) }, s);
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
  // A tier no profile has any more (its profile was deleted or shrank): conversations still on it run
  // on their copy of its tiers. The first tier (`<profile>:0`) is a lead and is never limited.
  if (/:0$/.test(tier)) return Infinity;
  return teamCopies.get(tier)?.max ?? 0;
}

/** Tiers from conversations' copies of their team (ConversationMeta.team), by tier id. */
const teamCopies = new Map<string, TierSpec>();

/** Records a conversation's copy of its team, for tierLimit() once the profile itself is gone. */
export function rememberTeam(tiers: readonly TierSpec[]): void {
  for (const t of tiers) teamCopies.set(t.id, t);
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

/**
 * The settings with built-in profile `id` back to its defaults: `claude` from `claudeProfile()`, others
 * from `generated` (e.g. Codex from the registry). Unknown or user profiles: unchanged.
 */
export function resetProfile(s: Settings, id: string, generated: TeamProfile[] = []): Settings {
  const fresh = id === CLAUDE_PROFILE ? claudeProfile() : generated.find((g) => g.id === id);
  if (!fresh || !s.profiles.some((p) => p.id === id && p.builtIn)) return s;
  const out = sanitizeSettings({ profiles: s.profiles.map((p) => (p.id === id ? fresh : p)) }, { ...s, profiles: s.profiles.filter((p) => p.id !== id) });
  const p = out.profiles.find((x) => x.id === id);
  if (p) p.builtIn = true;
  return out;
}
