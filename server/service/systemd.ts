// A systemd user unit, the same one scripts/install.sh writes.
import { join } from 'node:path/posix';
import { DEFAULT_PORT } from '../paths.js';
import { NODE_FLAGS, checkValue, dataDirNote, must, portOf, serviceEnv } from './common.js';
import type { Deps, InstallOptions, ServiceManager, ServiceStatus } from './types.js';
import { ServiceError } from './types.js';

export const UNIT = 'masthead.service';

/** One systemd unit word: backslash and double quote escaped, % doubled (install.sh `unit_quote`). */
export function unitQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** A word on an Exec line also needs $ doubled (install.sh `exec_quote`). */
export function execQuote(s: string): string {
  return unitQuote(s.replace(/\$/g, '$$$$'));
}

/**
 * ~/.config/systemd/user/masthead.service. Not $XDG_CONFIG_HOME from this shell: systemd's user
 * manager searches $XDG_CONFIG_HOME/systemd/user only when its own environment has that variable,
 * while ~/.config/systemd/user is always searched. `install` checks with `systemctl --user cat`.
 */
export function unitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', UNIT);
}

/** Where earlier installs (scripts/install.sh) may have put the unit: $XDG_CONFIG_HOME/systemd/user when set. */
function legacyUnitPath(deps: Pick<Deps, 'home' | 'env'>): string | null {
  const x = deps.env.XDG_CONFIG_HOME;
  const p = x ? join(x, 'systemd', 'user', UNIT) : null;
  return p && p !== unitPath(deps.home) ? p : null;
}

export function unitContent(o: InstallOptions, home: string): string {
  checkValue('node path', o.node);
  checkValue('main.js path', o.mainJs);
  const env = serviceEnv(o, [join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'])
    .map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`)
    .join('\n');
  return `[Unit]
Description=Masthead: a local app for a tiered team of Claude agents
After=network-online.target

[Service]
ExecStart=${execQuote(o.node)} ${NODE_FLAGS.join(' ')} ${execQuote(o.mainJs)} serve
${env}
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
}

/** The port of a loaded unit from `systemctl --user show` output: MASTHEAD_PORT, else the default; null when not loaded. */
export function unitPortFrom(show: string): number | null {
  if (/^LoadState=(.*)$/m.exec(show)?.[1]?.trim() !== 'loaded') return null;
  const env = /^Environment=(.*)$/m.exec(show)?.[1] ?? '';
  return portOf(/(?:^|[\s"])MASTHEAD_PORT=(\d+)/.exec(env)?.[1]) ?? DEFAULT_PORT;
}

/** The variables of the `Environment=` line of `systemctl --user show` (words, "quoted" with backslash escapes). */
export function unitEnvFrom(show: string): Record<string, string> {
  const line = /^Environment=(.*)$/m.exec(show)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const word = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!;
    const eq = word.indexOf('=');
    if (eq > 0) out[word.slice(0, eq)] = word.slice(eq + 1);
  }
  return out;
}

export function systemdService(deps: Deps): ServiceManager {
  const sc = (...args: string[]) => ['--user', ...args];
  const show = () => deps.run('systemctl', sc('show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Environment', UNIT));
  return {
    kind: 'systemd',
    async install(o) {
      if (deps.run('systemctl', sc('show-environment')).status !== 0) {
        throw new ServiceError('systemd user services are not available here; start Masthead with: masthead');
      }
      const file = unitPath(deps.home);
      const content = unitContent(o, deps.home);
      deps.fs.mkdir(join(file, '..'));
      deps.fs.writeFile(file, content);
      try {
        must(deps.run, 'systemctl', sc('daemon-reload'));
        const cat = deps.run('systemctl', sc('cat', UNIT));
        if (cat.status !== 0) {
          throw new ServiceError(`systemd did not find ${UNIT} after it was written to ${file}; that folder is not on its user unit search path (see: systemd-analyze --user unit-paths).`);
        }
        const used = /^# (\/.*)$/m.exec(cat.stdout)?.[1]?.trim();
        if (used && used !== file) {
          throw new ServiceError(`systemd reads ${UNIT} from ${used}, not from ${file} where Masthead wrote it. Remove ${used} (or run: masthead service uninstall) and try again.`);
        }
        must(deps.run, 'systemctl', sc('enable', '--quiet', UNIT));
        must(deps.run, 'systemctl', sc('restart', UNIT));
      } catch (e) {
        // Leave nothing half-installed.
        deps.run('systemctl', sc('disable', '--now', UNIT));
        deps.fs.rm(file);
        deps.run('systemctl', sc('daemon-reload'));
        throw e;
      }
      return [`Wrote ${file}`, 'Installed Masthead as a user service; it starts when you log in.'];
    },
    async uninstall() {
      const files = [unitPath(deps.home), legacyUnitPath(deps)].filter((f): f is string => f !== null && deps.fs.exists(f));
      if (!files.length && unitPortFrom(show().stdout) === null) return ['Nothing was installed.'];
      // Fails when the unit is not loaded; removing the file is what matters.
      deps.run('systemctl', sc('disable', '--now', UNIT));
      for (const f of files) deps.fs.rm(f);
      deps.run('systemctl', sc('daemon-reload'));
      return ['Stopped and disabled the user service.', ...files.map((f) => `Removed ${f}`)];
    },
    async status(): Promise<ServiceStatus> {
      const r = show();
      if (r.status !== 0) return { installed: false, running: null, port: null, detail: `systemctl failed: ${(r.stderr || r.stdout).trim() || r.status}` };
      const port = unitPortFrom(r.stdout);
      const active = /^ActiveState=(.*)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown';
      if (port === null) return { installed: false, running: false, port: null, detail: 'Not installed.' };
      const { dataDir, note } = dataDirNote('linux', unitEnvFrom(r.stdout), deps.env, deps.home);
      return { installed: true, running: active === 'active' || active === 'reloading', port, dataDir, detail: `${UNIT} ${active}, port ${port}, ${note}` };
    },
    serves(port) {
      const r = show();
      return r.status === 0 && unitPortFrom(r.stdout) === port;
    },
  };
}
