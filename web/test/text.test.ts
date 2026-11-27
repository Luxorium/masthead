import { describe, expect, it } from 'vitest';
import { T, friendlyError } from '../src/lib/text.ts';

/** Every string in T, with functions called on sample arguments. */
function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'function') return [String((node as (...a: unknown[]) => unknown)('Bravo', 'Alpha'))];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === 'object') return Object.values(node).flatMap(strings);
  return [];
}

describe('page text', () => {
  it('uses no team jargon (model names are fine: levels are called by model name)', () => {
    const bad = strings(T).filter((s) => /\b(tiers?|sub-?agents?|lead|effort)\b/i.test(s));
    expect(bad).toEqual([]);
  });
  it('rewrites known server errors with a next step', () => {
    expect(friendlyError('The message is too long.')).toMatch(/file in the folder/);
    expect(friendlyError('That conversation no longer exists.')).toMatch(/new one/);
    expect(friendlyError('Something unexpected')).toBe('Something unexpected');
  });
});
