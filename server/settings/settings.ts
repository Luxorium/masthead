import { existsSync, readFileSync } from 'node:fs';
import {
  EFFORTS,
  MAX_PER_TIER,
  PERMISSION_CHOICES,
  TIERS,
  VERSION,
  type Effort,
  type Settings,
} from '../../shared/protocol.js';
import { HOME, SETTINGS_FILE } from '../paths.js';
import { writeFileAtomic } from '../storage/atomic.js';

export function defaultSettings(): Settings {
  return {
    tiers: {
      lead: { model: 'claude-fable-5-2', effort: 'xhigh', max: 1 },
      opus: { model: 'claude-opus-5-5', effort: 'xhigh', max: 3 },
      sonnet: { model: 'claude-sonnet-5-5', effort: 'high', max: 4 },
      haiku: { model: 'claude-haiku-5-5', effort: 'medium', max: 4 },
    },
    permissionMode: 'inherit',
    autoEffort: true,
    leanSubagents: true,
    leanOpus: true,
    collapseReports: false,
    maxRunMinutes: 0,
    defaultCwd: HOME,
  };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.trunc(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Returns valid settings whatever was passed in. Fields that are missing, unknown or malformed keep
 * their value from `base` (the defaults unless given), so a partial update changes only what it names.
 */
export function sanitizeSettings(raw: unknown, base: Settings = defaultSettings()): Settings {
  const d = structuredClone(base);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const tiersIn = (r.tiers && typeof r.tiers === 'object' ? r.tiers : {}) as Record<string, unknown>;
  for (const tier of TIERS) {
    const t = tiersIn[tier];
    if (!t || typeof t !== 'object') continue;
    const tt = t as Record<string, unknown>;
    if (typeof tt.model === 'string' && /^[A-Za-z0-9._\-\[\]:]{1,80}$/.test(tt.model)) d.tiers[tier].model = tt.model;
    if (EFFORTS.includes(tt.effort as Effort)) d.tiers[tier].effort = tt.effort as Effort;
    if (tier !== 'lead') d.tiers[tier].max = clampInt(tt.max, 0, MAX_PER_TIER, d.tiers[tier].max);
  }
  if (PERMISSION_CHOICES.includes(r.permissionMode as Settings['permissionMode'])) {
    d.permissionMode = r.permissionMode as Settings['permissionMode'];
  }
  if (typeof r.autoEffort === 'boolean') d.autoEffort = r.autoEffort;
  if (typeof r.leanSubagents === 'boolean') d.leanSubagents = r.leanSubagents;
  if (typeof r.leanOpus === 'boolean') d.leanOpus = r.leanOpus;
  if (typeof r.collapseReports === 'boolean') d.collapseReports = r.collapseReports;
  d.maxRunMinutes = clampInt(r.maxRunMinutes, 0, 24 * 60, d.maxRunMinutes);
  if (typeof r.defaultCwd === 'string' && r.defaultCwd.startsWith('/')) d.defaultCwd = r.defaultCwd;
  return d;
}

export function loadSettings(file: string = SETTINGS_FILE): Settings {
  try {
    return sanitizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return defaultSettings();
  }
}


export function saveSettings(s: Settings, file: string = SETTINGS_FILE): void {
  writeFileAtomic(file, JSON.stringify(s, null, 2) + '\n');
}

