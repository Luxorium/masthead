// Pure helpers for the store, tested on their own.
import type { RateLimitNotice, Settings, SettingsPatch, Tier, TierSettings } from '../../../../shared/protocol.ts';

/** The fields of `next` that differ from `before`, tier fields one by one. */
export function settingsPatch(before: Settings, next: Settings): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(next) as (keyof Settings)[]) {
    if (k === 'tiers') continue;
    if (next[k] !== before[k]) patch[k] = next[k];
  }
  const tiers: Record<string, Record<string, unknown>> = {};
  for (const tier of Object.keys(next.tiers) as Tier[]) {
    for (const f of Object.keys(next.tiers[tier]) as (keyof TierSettings)[]) {
      if (next.tiers[tier][f] !== before.tiers[tier]?.[f]) (tiers[tier] ??= {})[f] = next.tiers[tier][f];
    }
  }
  if (Object.keys(tiers).length) patch.tiers = tiers;
  return patch as SettingsPatch;
}

/** What identifies a usage notice for dismissing the banner: a change in any of these shows it again. */
export function limitKey(n: RateLimitNotice): string {
  return `${n.type ?? ''}|${n.status}|${n.resetsAt ?? ''}`;
}


/** The worst usage window known: any rejected, else any warning, else none. */
export function worstLimit(usage: Record<string, RateLimitNotice>): RateLimitNotice | null {
  const all = Object.values(usage);
  return all.find((n) => n.status === 'rejected') ?? all.find((n) => n.status === 'allowed_warning') ?? null;
}
