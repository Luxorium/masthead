import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/protocol.ts';
import { fmtTokens, shortPath, shortReason, statusWords } from '../src/lib/words.ts';

const agent = (over: Partial<AgentInfo>): AgentInfo => ({
  id: 'a1', convId: 'c1', name: 'bravo', tier: 'opus', parentId: 'l', title: '', task: '', status: 'running',
  model: 'claude-opus-5-5', effort: 'low', createdAt: 0,
  usage: { context: 0, contextMax: 1, output: 0, costUsd: 0, turns: 0 }, ...over,
});

describe('words', () => {
  it('formats token counts', () => {
    expect(fmtTokens(850)).toBe('850');
    expect(fmtTokens(1234)).toBe('1.2k');
    expect(fmtTokens(12_345)).toBe('12k');
    expect(fmtTokens(1_250_000)).toBe('1.25M');
  });
  it('shortens the home folder', () => {
    expect(shortPath('/home/x/p', '/home/x')).toBe('~/p');
    expect(shortPath('/home/xy', '/home/x')).toBe('/home/xy');
  });
  it('names known stop reasons plainly', () => {
    expect(shortReason('Stopped by the person.')).toBe('by you');
    expect(shortReason('Stopped after 30 minutes: the run-time limit set by the person.')).toBe('run-time limit');
    expect(shortReason('Stopped by "alpha-ii".')).toBe('by Alpha II');
    expect(shortReason('"bravo" ended before this agent finished.')).toBe('Bravo ended first');
    expect(shortReason('x'.repeat(80))).toHaveLength(60);
  });
  it('words each status', () => {
    expect(statusWords(agent({ activity: 'Reading a.ts' }))).toBe('Reading a.ts');
    expect(statusWords(agent({ status: 'waiting', waitingFor: 'alpha' }))).toBe('Waiting for an answer from Alpha');
    expect(statusWords(agent({ status: 'stopped', error: 'Stopped by the person.' }))).toBe('Stopped · by you');
    expect(statusWords(agent({ status: 'queued' }))).toBe('Queued');
    expect(statusWords(agent({ pausedUntil: Date.now() + 1e6 }))).toMatch(/^Paused until .* · usage limit$/);
  });
});
