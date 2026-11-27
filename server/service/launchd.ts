// A per-user launchd agent. UNVERIFIED without a Mac: the plist keys follow launchd.plist(5) and the
// `launchctl bootstrap/bootout/print` forms follow launchctl(1); the `print` output parsed by
// `launchdPortFrom` and `state = running` is from documentation and examples, not a real run.
import { join } from 'node:path/posix';
import { DEFAULT_PORT } from '../paths.js';
import { NODE_FLAGS, checkValue, dataDirNote, must, portOf, serviceEnv, xmlEscape } from './common.js';
import type { Deps, InstallOptions, ServiceManager, ServiceStatus } from './types.js';
import { ServiceError } from './types.js';

export const LABEL = 'io.github.luxorium.masthead';

export function plistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function logPath(home: string): string {
  return join(home, 'Library', 'Logs', 'Masthead', 'masthead.log');
}

const str = (s: string) => `<string>${xmlEscape(s)}</string>`;

export function plistContent(o: InstallOptions, home: string): string {
  // A login session's launchd PATH is only /usr/bin:/bin:/usr/sbin:/sbin; Homebrew lives in
  // /opt/homebrew/bin (Apple silicon) or /usr/local/bin (Intel).
  const env = serviceEnv(o, [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  checkValue('node path', o.node);
  checkValue('main.js path', o.mainJs);
  checkValue('home folder', home);
  const args = [o.node, ...NODE_FLAGS, o.mainJs, 'serve'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    ${str(a)}`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    ${str(v)}`).join('\n')}
  </dict>
  <key>StandardOutPath</key>
  ${str(logPath(home))}
  <key>StandardErrorPath</key>
  ${str(logPath(home))}
</dict>
</plist>
`;
}

/** The port from `launchctl print` output (its `environment = { MASTHEAD_PORT => N }` block), else the default. */
export function launchdPortFrom(print: string): number {
  return portOf(/^\s*MASTHEAD_PORT => (\d+)\s*$/m.exec(print)?.[1]) ?? DEFAULT_PORT;
}

/** The variables in the `environment = { K => V }` block of `launchctl print` output. */
export function launchdEnvFrom(print: string): Record<string, string> {
  const block = /^\s*environment = \{\n([\s\S]*?)^\s*\}/m.exec(print)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/^\s*(\S+) => (.*)$/gm)) out[m[1]!] = m[2]!.trim();
  return out;
}

export function launchdService(deps: Deps): ServiceManager {
  const domain = () => {
    const uid = deps.uid ?? process.getuid?.();
    if (uid === undefined) throw new ServiceError('Cannot tell the user id for launchctl.');
    return `gui/${uid}`;
  };
  const print = () => deps.run('launchctl', ['print', `${domain()}/${LABEL}`]);
  return {
    kind: 'launchd',
    async install(o) {
      const file = plistPath(deps.home);
      const content = plistContent(o, deps.home);
      const target = `${domain()}/${LABEL}`;
      deps.fs.mkdir(join(file, '..'));
      deps.fs.mkdir(join(logPath(deps.home), '..'));
      deps.fs.writeFile(file, content);
      // An agent that is already loaded keeps its old definition until it is booted out; fails harmlessly when none is.
      deps.run('launchctl', ['bootout', target]);
      try {
        must(deps.run, 'launchctl', ['bootstrap', domain(), file]);
      } catch (e) {
        // Leave nothing half-installed.
        deps.run('launchctl', ['bootout', target]);
        deps.fs.rm(file);
        throw e;
      }
      return [`Wrote ${file}`, 'Masthead is running as a launchd agent and will start when you log in.', `Logs: ${logPath(deps.home)}`];
    },
    async uninstall() {
      const file = plistPath(deps.home);
      const has = deps.fs.exists(file);
      if (!has && print().status !== 0) return ['Nothing was installed.'];
      deps.run('launchctl', ['bootout', `${domain()}/${LABEL}`]);
      deps.fs.rm(file);
      return ['Stopped the launchd agent.', ...(has ? [`Removed ${file}`] : [])];
    },
    async status(): Promise<ServiceStatus> {
      const r = print();
      if (r.status !== 0) return { installed: false, running: false, port: null, detail: 'Not installed (not loaded in launchd).' };
      const state = /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim();
      const port = launchdPortFrom(r.stdout);
      const { dataDir, note } = dataDirNote('darwin', launchdEnvFrom(r.stdout), deps.env, deps.home);
      return { installed: true, running: state === undefined ? null : state === 'running', port, dataDir, detail: `${LABEL} ${state ?? 'state unknown'}, port ${port}, ${note}` };
    },
    serves(port) {
      const r = print();
      return r.status === 0 && launchdPortFrom(r.stdout) === port;
    },
  };
}
