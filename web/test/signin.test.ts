import { beforeEach, describe, expect, it } from 'vitest';
import { KEY_STORAGE, dropCandidate, keepCandidate, resetSignin, takeKey } from '../src/lib/signin.ts';

describe('sign-in key', () => {
  beforeEach(() => {
    resetSignin();
    localStorage.clear();
    history.replaceState(null, '', '/');
  });

  it('takes a key from the fragment as a candidate and cleans the address', () => {
    history.replaceState(null, '', '/#key=abc');
    expect(takeKey()).toEqual({ key: 'abc', untried: true });
    expect(location.href).not.toContain('key=');
    expect(localStorage.getItem(KEY_STORAGE)).toBeNull();
  });

  it('keeps the rest of the fragment', () => {
    history.replaceState(null, '', '/?key=q#/c/conv1');
    expect(takeKey().key).toBe('q');
    expect(location.hash).toBe('#/c/conv1');
  });

  it('stores a candidate only once accepted', () => {
    history.replaceState(null, '', '/#key=new');
    takeKey();
    keepCandidate();
    expect(localStorage.getItem(KEY_STORAGE)).toBe('new');
    expect(takeKey()).toEqual({ key: 'new', untried: false });
  });

  it('falls back to the stored key when a candidate is dropped', () => {
    localStorage.setItem(KEY_STORAGE, 'good');
    history.replaceState(null, '', '/#key=junk');
    expect(takeKey().key).toBe('junk');
    dropCandidate();
    expect(takeKey()).toEqual({ key: 'good', untried: false });
  });
});
