import { execFileSync } from 'node:child_process';
import { VERSION } from '../../../shared/protocol.js';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { HOME } from '../../paths.js';

/** What a running Claude Code session sets about itself. Settings a person exports on purpose are not in here. */
const SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_WORKER_EPOCH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENVIRONMENT_KIND',
  'CLAUDE_CODE_EXECPATH',
]);

export interface ClaudeInfo {
  path: string | null;
  version: string | null;
  error?: string;
}

/** Finds the Claude Code the person installed. Masthead runs that program as it is and never touches its login. */
export function findClaude(): ClaudeInfo {
  const candidates: string[] = [];
  if (process.env.MASTHEAD_CLAUDE) candidates.push(process.env.MASTHEAD_CLAUDE);
  for (const dir of (process.env.PATH || '').split(delimiter)) if (dir) candidates.push(join(dir, 'claude'));
  candidates.push(join(HOME, '.local', 'bin', 'claude'), join(HOME, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude');
  const path = candidates.find((c) => existsSync(c)) ?? null;
  if (!path) {
    return { path: null, version: null, error: 'Claude Code was not found. Install it and sign in with `claude`, then restart Masthead.' };
  }
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000, env: agentEnv() });
    return { path, version: out.trim().split('\n')[0] ?? null };
  } catch (e) {
    return { path, version: null, error: `Could not run ${path}: ${(e as Error).message}` };
  }
}

/**
 * Environment for the Claude Code processes Masthead starts. Variables that an enclosing Claude Code
 * session sets about itself are removed so a server launched from inside one still starts clean ones.
 * Credentials (ANTHROPIC_API_KEY and the like) are passed through untouched.
 */
export function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SESSION_VARS.has(k) || k.startsWith('CLAUDE_CODE_BRIDGE_')) continue;
    env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `masthead/${VERSION}`;
  return env;
}


