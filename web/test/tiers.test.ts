import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { Settings, TeamProfile } from '../../shared/protocol.ts';
import TierControls from '../src/lib/team/TierControls.svelte';
import { store } from '../src/lib/store.svelte.ts';
import { profileById, tierClass } from '../src/lib/tiers.ts';

const duo: TeamProfile = {
  id: 'duo', label: 'Duo', builtIn: false,
  tiers: [
    { id: 'duo:1', label: 'Big', backend: 'b', model: 'm1', effort: 'low', max: 1, lean: false, colour: 'rose' },
    { id: 'duo:2', label: 'Small', backend: 'b', model: 'm2', effort: 'medium', max: 3, lean: true, colour: 'green' },
  ],
};
const settings = { profiles: [duo], defaultProfile: 'duo', autoEffort: true, tiers: {} } as unknown as Settings;

describe('tiers from data', () => {
  it('takes the colour from the profile, with 0.1.x names as a fallback', () => {
    expect(tierClass(settings, 'duo:2')).toBe('pal-green');
    expect(tierClass(settings, 'sonnet')).toBe('pal-blue');
    expect(tierClass(settings, 'gone:9')).toBe('pal-slate');
    expect(profileById(settings, 'nope')?.id).toBe('duo');
  });

  it('shows one box per level of the chat\'s profile, named by its label', () => {
    store.settings = settings;
    store.convId = null;
    render(TierControls);
    expect(screen.getByText('Big')).toBeTruthy();
    expect(screen.getByLabelText('More Small helpers')).toBeTruthy();
    expect(screen.queryByLabelText('More Big helpers')).toBeNull();
  });
});
