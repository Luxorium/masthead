// A systemd user unit, the same one scripts/install.sh writes.
import { join } from 'node:path/posix';
import { DEFAULT_PORT } from '../paths.js';
import { NODE_FLAGS, must, portOf, serviceEnv } from './common.js';
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

export function unitPath(deps: Pick<Deps, 'home' | 'env'>): string {
  return join(deps.env.XDG_CONFIG_HOME || join(deps.home, '.config'), 'systemd', 'user', UNIT);
}

export function unitContent(o: InstallOptions, home: string): string {
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

export function systemdService(deps: Deps): ServiceManager {
  const sc = (...args: string[]) => ['--user', ...args];
  const show = () => deps.run('systemctl', sc('show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Environment', UNIT));
  return {
    kind: 'systemd',
    async install(o) {
      if (deps.run('systemctl', sc('show-environment')).status !== 0) {
        throw new ServiceError('systemd user services are not available here; start Masthead with: masthead');
      }
      const file = unitPath(deps);
      deps.fs.mkdir(join(file, '..'));
      deps.fs.writeFile(file, unitContent(o, deps.home));
      must(deps.run, 'systemctl', sc('daemon-reload'));
      must(deps.run, 'systemctl', sc('enable', '--quiet', UNIT));
      must(deps.run, 'systemctl', sc('restart', UNIT));
      return [`Wrote ${file}`, 'Masthead is running as a user service and will start when you log in.'];
    },
    async uninstall() {
      const file = unitPath(deps);
      // Fails when the unit is not loaded; removing the file is what matters.
      deps.run('systemctl', sc('disable', '--now', UNIT));
      deps.fs.rm(file);
      deps.run('systemctl', sc('daemon-reload'));
      return ['Stopped and disabled the user service.', `Removed ${file}`];
    },
    async status(): Promise<ServiceStatus> {
      const r = show();
      if (r.status !== 0) return { installed: false, running: null, port: null, detail: `systemctl failed: ${(r.stderr || r.stdout).trim() || r.status}` };
      const port = unitPortFrom(r.stdout);
      const active = /^ActiveState=(.*)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown';
      if (port === null) return { installed: false, running: false, port: null, detail: 'Not installed.' };
      return { installed: true, running: active === 'active' || active === 'reloading', port, detail: `${UNIT} ${active}, port ${port}` };
    },
    serves(port) {
      const r = show();
      return r.status === 0 && unitPortFrom(r.stdout) === port;
    },
  };
}
