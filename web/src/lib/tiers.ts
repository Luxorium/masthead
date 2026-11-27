// Tiers as data (0.2.0 team profiles): an agent's `tier` is a tier id; its label, model and colour come
// from the profile in the settings. Nothing here knows Claude's model names.
import { CLAUDE_PROFILE, PALETTE, findTier, type PaletteColour, type Settings, type TeamProfile, type TierSpec } from '../../../shared/protocol.ts';

/** Colours for 0.1.x tier ids, in case a profile is gone; new ids always find their profile. */
const LEGACY: Record<string, PaletteColour> = { lead: 'amber', opus: 'violet', sonnet: 'blue', haiku: 'teal' };

export function tierSpec(settings: Settings | null, tier: string): TierSpec | undefined {
  return settings?.profiles ? findTier(settings, tier) : undefined;
}

/** The class that sets --tier for an agent's tier: `pal-<colour>` from its profile. */
export function tierClass(settings: Settings | null, tier: string): string {
  const colour = tierSpec(settings, tier)?.colour ?? LEGACY[tier] ?? 'slate';
  return `pal-${PALETTE.includes(colour) ? colour : 'slate'}`;
}

/** A profile by id, falling back to the built-in Claude profile. */
export function profileById(settings: Settings | null, id: string | undefined): TeamProfile | undefined {
  const all = settings?.profiles ?? [];
  return all.find((p) => p.id === id) ?? all.find((p) => p.id === CLAUDE_PROFILE) ?? all[0];
}
