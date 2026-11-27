// A per-user Task Scheduler task that starts Masthead at logon.
//
// UNVERIFIED without a Windows machine: the XML follows the Task Scheduler 1.2 schema
// (learn.microsoft.com "Task Scheduler Schema"), schtasks options follow its documentation, and the
// `/Query /FO LIST /V` field names parsed below are the English ones (other display languages
// translate them, so `status` then reports running as unknown). Whether `conhost.exe --headless`
// keeps the console window hidden on every supported Windows 10/11 build is also untested.
//
// Environment: a task cannot set environment variables, and wrapping the command in
// `cmd.exe /d /c "set A=..&& ..."` breaks on `%`, `^`, `&` and quotes in paths and would show a cmd
// window. So the task passes only what is essential, the port, as `--port N` (the server reads it
// like MASTHEAD_PORT), and otherwise inherits the person's own logon environment: PATH there is the
// one Claude Code's installer updates, so `claude` is found without MASTHEAD_CLAUDE. MASTHEAD_CLAUDE
// and XDG_* are not carried over; `install` says so when they would have been, so the person can set
// them as user environment variables.
import { join } from 'node:path/win32';
import { tmpdir } from 'node:os';
import { DEFAULT_PORT } from '../paths.js';
import { NODE_FLAGS, checkValue, must, portOf, xmlEscape } from './common.js';
import type { Deps, InstallOptions, ServiceManager, ServiceStatus } from './types.js';

export const TASK = 'Masthead';

/** One argument for a Windows command line, as CommandLineToArgvW and node.exe parse it. */
export function winQuote(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

/** The task's program and arguments. conhost --headless runs node.exe without a visible console window. */
export function taskAction(o: InstallOptions): { command: string; args: string[] } {
  const args = ['--headless', o.node, ...NODE_FLAGS, o.mainJs, 'serve'];
  if (o.port !== undefined && o.port !== DEFAULT_PORT) args.push('--port', String(o.port));
  return { command: 'conhost.exe', args };
}

/** The current user as Task Scheduler names it, DOMAIN\user. */
export function taskUser(env: Record<string, string | undefined>): string {
  const user = env.USERNAME ?? 'user';
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

export function taskXml(o: InstallOptions, user: string): string {
  checkValue('node path', o.node);
  checkValue('main.js path', o.mainJs);
  checkValue('user name', user);
  const { command, args } = taskAction(o);
  const u = xmlEscape(user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Masthead: a local app for a tiered team of Claude agents</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${u}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args.map(winQuote).join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks /XML wants UTF-16 with a byte order mark. */
export function utf16le(text: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/** Field values from `schtasks /Query /FO LIST /V` (English field names). */
export function parseTaskQuery(out: string): { status: string | null; port: number } {
  const status = /^Status:\s*(.+)$/m.exec(out)?.[1]?.trim() ?? null;
  const run = /^Task To Run:\s*(.+)$/m.exec(out)?.[1] ?? '';
  return { status, port: portOf(/(?:^|\s)--port\s+"?(\d+)"?(?:\s|$)/.exec(run)?.[1]) ?? DEFAULT_PORT };
}

export function taskSchedulerService(deps: Deps): ServiceManager {
  const query = () => deps.run('schtasks', ['/Query', '/TN', TASK, '/FO', 'LIST', '/V']);
  return {
    kind: 'taskscheduler',
    async install(o) {
      const xml = utf16le(taskXml(o, taskUser(deps.env)));
      const file = join(deps.tmpdir ?? tmpdir(), `masthead-task-${process.pid}.xml`);
      deps.fs.writeFile(file, xml);
      // /Create /F replaces the definition but leaves a running copy on the old one; ends harmlessly when none runs.
      deps.run('schtasks', ['/End', '/TN', TASK]);
      try {
        must(deps.run, 'schtasks', ['/Create', '/TN', TASK, '/XML', file, '/F']);
        must(deps.run, 'schtasks', ['/Run', '/TN', TASK]);
      } catch (e) {
        // Leave nothing half-installed.
        deps.run('schtasks', ['/Delete', '/TN', TASK, '/F']);
        throw e;
      } finally {
        deps.fs.rm(file);
      }
      const lines = [`Created the scheduled task "${TASK}" (runs at logon, no admin rights).`, 'It starts Masthead when you log in.'];
      // An explicit MASTHEAD_CLAUDE, MASTHEAD_*_DIR or XDG_* in this shell would be lost; claudePath alone is not, PATH finds claude.
      const lost = ['MASTHEAD_CLAUDE', 'MASTHEAD_DATA_DIR', 'MASTHEAD_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].filter((k) => o.env[k]);
      if (lost.length) lines.push(`Note: the task uses your logon environment, not ${lost.join(', ')} from this shell. Set them with \`setx\` if Masthead needs them.`);
      return lines;
    },
    async uninstall() {
      deps.run('schtasks', ['/End', '/TN', TASK]);
      const del = deps.run('schtasks', ['/Delete', '/TN', TASK, '/F']);
      if (del.status === 0) return [`Stopped and deleted the scheduled task "${TASK}".`];
      // The task does not exist (any display language: the query fails too), so there is nothing to undo.
      const q = del.status === null ? del : query();
      if (q.status !== 0 && q.status !== null) return ['Nothing was installed.'];
      must(() => del, 'schtasks', ['/Delete', '/TN', TASK, '/F']);
      return [];
    },
    async status(): Promise<ServiceStatus> {
      const r = query();
      if (r.status !== 0) return { installed: false, running: false, port: null, detail: 'Not installed.' };
      const { status, port } = parseTaskQuery(r.stdout);
      return { installed: true, running: status === null ? null : status === 'Running', port, detail: `Task "${TASK}" ${status ?? 'status unknown'}, port ${port}` };
    },
    serves(port) {
      const r = query();
      return r.status === 0 && parseTaskQuery(r.stdout).port === port;
    },
  };
}
