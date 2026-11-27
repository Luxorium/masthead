import { execFileSync } from 'node:child_process';
import { VERSION } from '../../../shared/protocol.js';
import { existsSync, readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
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

export interface FindDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists(path: string): boolean;
  read(path: string): string;
}

const realDeps = (): FindDeps => ({
  platform: process.platform,
  env: process.env,
  home: HOME,
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
});

/**
 * Where Claude Code may be, in order: $MASTHEAD_CLAUDE, each PATH folder, then the places its
 * installers use (a service's PATH is often short, launchd's especially). On Windows each name is
 * tried with the extensions in PATHEXT, `.exe` first.
 */
export function claudeCandidates(d: Pick<FindDeps, 'platform' | 'env' | 'home'>): string[] {
  const win = d.platform === 'win32';
  const p = win ? win32 : posix;
  const env = (name: string) => (win ? Object.entries(d.env).find(([k]) => k.toUpperCase() === name)?.[1] : d.env[name]);
  const dirs = (env('PATH') ?? '').split(win ? ';' : ':').filter((x) => x && p.isAbsolute(x));
  if (win) {
    dirs.push(p.join(d.home, '.local', 'bin'), p.join(env('APPDATA') || p.join(d.home, 'AppData', 'Roaming'), 'npm'));
  } else {
    dirs.push(p.join(d.home, '.local', 'bin'), p.join(d.home, '.claude', 'local'), p.join(d.home, '.npm-global', 'bin'), p.join(d.home, '.bun', 'bin'));
    if (d.platform === 'darwin') dirs.push('/opt/homebrew/bin');
    dirs.push('/usr/local/bin', '/usr/bin');
  }
  const exts = win
    ? ['.exe', ...(env('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter((e) => e && e !== '.exe')]
    : [''];
  const out: string[] = [];
  const override = env('MASTHEAD_CLAUDE');
  if (override) out.push(override);
  for (const dir of dirs) for (const ext of exts) out.push(p.join(dir, `claude${ext}`));
  return [...new Set(out)];
}

/**
 * The Agent SDK starts Claude Code without a shell, so on Windows a `.cmd` or `.bat` shim cannot be
 * run (Node refuses them without a shell). npm's shims name the real target relative to themselves
 * ("%dp0%\node_modules\...\claude.exe" or a .js file); that target is what Masthead runs.
 */
export function resolveShim(shim: string, text: string): string | null {
  // Only the target that the arguments (%*) follow, as npm's read-cmd-shim does: a shim for a .js file
  // also names "%dp0%\node.exe" (the node it prefers), which is not Claude Code.
  const m = /"%(?:~dp0|dp0%)\\?([^"]+?\.(?:exe|js|cjs|mjs))"\s+%\*/i.exec(text);
  return m ? win32.join(win32.dirname(shim), m[1]!) : null;
}

/** The program to run for Claude Code, or null: the first candidate that exists and can be started without a shell. */
export function locateClaude(d: FindDeps): string | null {
  for (const c of claudeCandidates(d)) {
    if (!d.exists(c)) continue;
    if (d.platform !== 'win32') return c;
    const ext = win32.extname(c).toLowerCase();
    if (ext === '.exe' || ext === '.js' || ext === '.cjs' || ext === '.mjs') return c;
    if (ext === '.cmd' || ext === '.bat') {
      let target: string | null = null;
      try {
        target = resolveShim(c, d.read(c));
      } catch {
        target = null;
      }
      if (target && d.exists(target)) return target;
    }
    // Anything else on Windows (npm's extension-less sh shim, .ps1) cannot be started directly.
  }
  return null;
}

/** Finds the Claude Code the person installed. Masthead runs that program as it is and never touches its login. */
export function findClaude(deps: FindDeps = realDeps()): ClaudeInfo {
  const path = locateClaude(deps);
  if (!path) {
    return { path: null, version: null, error: 'Claude Code was not found. Install it and sign in with `claude`, then restart Masthead.' };
  }
  try {
    // A .js entry (from an npm shim) runs with this Node, as the SDK does.
    const [cmd, args] = /\.(c|m)?js$/i.test(path) ? [process.execPath, [path, '--version']] : [path, ['--version']];
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000, env: agentEnv(), windowsHide: true });
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
  // Names are case-insensitive on Windows, so compare them in upper case.
  for (const [k, v] of Object.entries(process.env)) {
    const name = process.platform === 'win32' ? k.toUpperCase() : k;
    if (SESSION_VARS.has(name) || name.startsWith('CLAUDE_CODE_BRIDGE_')) continue;
    env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `masthead/${VERSION}`;
  return env;
}


