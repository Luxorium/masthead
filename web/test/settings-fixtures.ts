// Shared data for the settings component tests: a Claude and a Codex team and the backends report.
import type { Settings, TeamProfile } from '../../shared/protocol.ts';
import type { BackendEntry } from '../src/lib/settings/types.ts';

export const claude = (): TeamProfile => ({
  id: 'claude', label: 'Claude', builtIn: true,
  tiers: [
    { id: 'lead', label: 'Fable 5.2', backend: 'claude-code', model: 'claude-fable-5-2', effort: 'xhigh', max: 1, lean: false, colour: 'amber' },
    { id: 'opus', label: 'Opus 5.5', backend: 'claude-code', model: 'claude-opus-5-5', effort: 'xhigh', max: 3, lean: true, colour: 'violet' },
  ],
});

export const codex = (): TeamProfile => ({
  id: 'codex', label: 'Codex', builtIn: true, description: "Built from the installed Codex's model list.",
  tiers: [
    { id: 'codex:0', label: 'GPT-6.2-Astra', backend: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh', max: 1, lean: false, colour: 'amber' },
    { id: 'codex:1', label: 'GPT-6-Luna', backend: 'codex', model: 'gpt-6-luna', effort: 'high', max: 3, lean: true, colour: 'violet' },
  ],
});

export function backends(codexReady = true): BackendEntry[] {
  return [
    { id: 'claude-code', label: 'Claude Code', available: true, path: '/usr/bin/claude', version: '2.1.331', signedIn: true, models: [
      { id: 'claude-fable-5-2', label: 'Fable 5.2', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: ['low', 'medium', 'high'] },
    ] },
    { id: 'codex', label: 'Codex', available: codexReady, path: codexReady ? '/usr/bin/codex' : null, version: codexReady ? '0.172.0' : null, signedIn: codexReady ? true : null, models: codexReady ? [
      { id: 'gpt-6.2-astra', label: 'GPT-6.2-Astra', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: ['low', 'medium', 'high'] },
    ] : [], ...(codexReady ? {} : { error: 'Codex was not found.' }) },
  ];
}

export function settings(profiles: TeamProfile[] = [claude(), codex()], defaultProfile = 'claude'): Settings {
  return { version: 2, profiles, defaultProfile, permissionMode: 'inherit', autoEffort: true, collapseReports: true, maxRunMinutes: 0, defaultCwd: '/home/x' } as unknown as Settings;
}
