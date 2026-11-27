// The background service for this platform: `serviceFor(process.platform)`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { launchdService } from './launchd.js';
import { systemdService } from './systemd.js';
import { taskSchedulerService } from './taskscheduler.js';
import type { Deps, ServiceManager } from './types.js';

export type { Deps, InstallOptions, RunResult, ServiceFs, ServiceManager, ServiceStatus } from './types.js';
export { ServiceError } from './types.js';

/** The real system. Only `serviceFor` without deps uses it; tests always inject their own. */
export function systemDeps(): Deps {
  return {
    run(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
    },
    fs: {
      writeFile: (p, data) => writeFileSync(p, data),
      mkdir: (p) => void mkdirSync(p, { recursive: true }),
      rm: (p) => rmSync(p, { force: true }),
      exists: (p) => existsSync(p),
    },
    home: homedir(),
    env: process.env,
  };
}

/** The service manager for a platform, or null where Masthead has none (it then runs only in the foreground). */
export function serviceFor(platform: NodeJS.Platform, deps?: Deps): ServiceManager | null {
  const d = deps ?? systemDeps();
  switch (platform) {
    case 'linux':
      return systemdService(d);
    case 'darwin':
      return launchdService(d);
    case 'win32':
      return taskSchedulerService(d);
    default:
      return null;
  }
}
