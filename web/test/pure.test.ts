import { describe, expect, it } from 'vitest';
import type { RateLimitNotice, Settings } from '../../shared/protocol.ts';
import { limitKey, settingsPatch, worstLimit } from '../src/lib/state/pure.ts';

const base = (): Settings =>
  ({
    tiers: {
      lead: { model: 'm', effort: 'low', max: 1 },
      opus: { model: 'm', effort: 'low', max: 3 },
      sonnet: { model: 'm', effort: 'low', max: 4 },
      haiku: { model: 'm', effort: 'low', max: 4 },
    },
    permissionMode: 'inherit', autoEffort: true, leanSubagents: true, leanOpus: true, collapseReports: false,
    maxRunMinutes: 0, defaultCwd: '/home/x',
  }) as Settings;

describe('settingsPatch', () => {
  it('sends only what changed', () => {
    const a = base();
    const b = structuredClone(a);
    b.collapseReports = true;
    b.tiers.opus.max = 5;
    expect(settingsPatch(a, b)).toEqual({ collapseReports: true, tiers: { opus: { max: 5 } } });
  });
  it('is empty when nothing changed', () => {
    expect(settingsPatch(base(), base())).toEqual({});
  });
});

describe('usage banner', () => {
  const n = (type: string, status: RateLimitNotice['status'], resetsAt?: number): RateLimitNotice => ({ type, status, resetsAt });
  it('picks the worst window', () => {
    expect(worstLimit({ a: n('a', 'allowed'), b: n('b', 'allowed_warning') })?.type).toBe('b');
    expect(worstLimit({ a: n('a', 'rejected'), b: n('b', 'allowed_warning') })?.type).toBe('a');
    expect(worstLimit({ a: n('a', 'allowed') })).toBeNull();
  });
  it('keys a notice by window, status and reset', () => {
    expect(limitKey(n('a', 'rejected', 5))).not.toBe(limitKey(n('a', 'rejected', 6)));
  });
});
