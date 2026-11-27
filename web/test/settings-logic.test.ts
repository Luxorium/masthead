import { describe, expect, it } from 'vitest';
import { addLevel, copyOf, fitEffort, problems, removeLevel, usableProfiles, withModel } from '../src/lib/settings/logic.ts';
import { readBackends } from '../src/lib/settings/types.ts';
import { backends, claude, codex } from './settings-fixtures.ts';

describe('team settings logic', () => {
  it('usable teams are those whose program is ready', () => {
    expect(usableProfiles([claude(), codex()], backends()).map((p) => p.id)).toEqual(['claude', 'codex']);
    expect(usableProfiles([claude(), codex()], backends(false)).map((p) => p.id)).toEqual(['claude']);
  });

  it('problems are plain and specific', () => {
    const b = backends();
    expect(problems(claude(), [claude(), codex()], b)).toEqual([]);
    const p = claude();
    p.label = ' ';
    p.tiers[1]!.model = 'claude-gone';
    p.tiers.push({ ...p.tiers[1]!, id: 'x', model: 'claude-haiku-5-5', label: 'Haiku 5.5', effort: 'xhigh', max: 0 });
    p.tiers[1]!.max = 0;
    const out = problems(p, [p], b);
    expect(out[0]).toBe('Give the team a name.');
    expect(out.some((x) => /Level 2 uses .* no longer offers/.test(x))).toBe(true);
    expect(out.some((x) => /level 3 does not offer that thinking time/.test(x))).toBe(true);
    expect(out.some((x) => /Level 2 has 0 helpers at a time/.test(x))).toBe(true);
    const named = claude();
    named.label = 'codex';
    expect(problems(named, [named, codex()], b)).toContain('Another team already has this name.');
  });

  it('never uses the banned words in problems', () => {
    const p = claude();
    p.tiers.push({ ...codex().tiers[0]!, id: 'y' });
    for (const text of problems(p, [p], backends(false))) expect(text).not.toMatch(/\b(tier|lead|effort|sub-agent)\b/i);
  });

  it('adds, removes and copies levels', () => {
    const b = backends();
    const p = addLevel(claude(), b);
    expect(p.tiers).toHaveLength(3);
    expect(p.tiers[2]!.model).toBe('claude-haiku-5-5');
    expect(p.tiers[2]!.effort).toBe('medium');
    expect(new Set(p.tiers.map((t) => t.colour)).size).toBe(3);
    expect(removeLevel(p, 0).tiers).toHaveLength(3);
    expect(removeLevel(p, 2).tiers).toHaveLength(2);
    let full = claude();
    for (let i = 0; i < 6; i++) full = addLevel(full, b);
    expect(full.tiers).toHaveLength(5);
    const c = copyOf(claude(), [claude()]);
    expect(c.builtIn).toBe(false);
    expect(c.label).toBe('Claude (copy)');
    expect(c.tiers.map((t) => t.id)).toEqual([`${c.id}:0`, `${c.id}:1`]);
  });

  it('a new model fits the thinking time and carries its name unless renamed', () => {
    const [b] = backends();
    const haiku = b!.models[2]!;
    expect(fitEffort(haiku, 'xhigh')).toBe('high');
    const t = claude().tiers[1]!;
    expect(withModel(t, haiku, b!.models[1]).label).toBe('Haiku 5.5');
    expect(withModel({ ...t, label: 'Reviewer' }, haiku, b!.models[1]).label).toBe('Reviewer');
  });

  it('reads a malformed backends report safely', () => {
    expect(readBackends(null)).toEqual([]);
    expect(readBackends([{ id: 'x', models: [{ id: 'm' }, null] }])[0]).toMatchObject({ id: 'x', available: false, models: [{ id: 'm', label: 'm', efforts: [] }] });
  });
});
