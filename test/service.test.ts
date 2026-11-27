// The background service per platform, with every system call faked: nothing here runs systemctl,
// launchctl or schtasks or writes outside the fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkValue, cleanPath } from '../server/service/common.ts';
import { ServiceError, serviceFor, type Deps, type RunResult } from '../server/service/index.ts';
import { LABEL, launchdEnvFrom, launchdPortFrom, plistContent } from '../server/service/launchd.ts';
import { execQuote, unitContent, unitEnvFrom, unitPortFrom, unitQuote } from '../server/service/systemd.ts';
import { parseTaskQuery, taskAction, taskXml, utf16le, winQuote } from '../server/service/taskscheduler.ts';

type Call = [string, ...string[]];

function fake(results: (cmd: string, args: readonly string[]) => Partial<RunResult> = () => ({}), extra: Partial<Deps> = {}) {
  const calls: Call[] = [];
  const files = new Map<string, string | Uint8Array>();
  const ops: string[] = [];
  const deps: Deps = {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '', ...results(cmd, args) };
    },
    fs: {
      writeFile: (p, d) => void (files.set(p, d), ops.push(`write ${p}`)),
      mkdir: (p) => void ops.push(`mkdir ${p}`),
      rm: (p) => void (files.delete(p), ops.push(`rm ${p}`)),
      exists: (p) => files.has(p),
    },
    home: '/home/a b',
    env: {},
    ...extra,
  };
  return { deps, calls, files, ops };
}

const odd = '/opt/we ird/%x/$y/"q"/a&b<c>/node';
const base = { node: '/usr/bin/node', mainJs: '/lib/masthead/dist/server/main.js', env: { PATH: '/usr/bin:bin::/usr/bin:/x' } };

test('service: PATH is cleaned like scripts/path.sh', () => {
  assert.equal(cleanPath(['/a', '/b:.:bin::/a', undefined, null, '/c:/b']), '/a:/b:/c');
  assert.equal(cleanPath([]), '');
});

test('systemd: words are quoted as install.sh does', () => {
  assert.equal(unitQuote('a b'), '"a b"');
  assert.equal(unitQuote('a"b\\c%d$e'), '"a\\"b\\\\c%%d$e"');
  assert.equal(execQuote('a"b\\c%d$e'), '"a\\"b\\\\c%%d$$e"');
});

test('systemd: the unit matches the install.sh template', () => {
  const unit = unitContent({ ...base, node: odd, claudePath: '/home/a b/.local/bin/claude', port: 7720, env: { PATH: '/usr/bin:rel:/usr/bin', XDG_CONFIG_HOME: '/c fg', XDG_DATA_HOME: '/d%' } }, '/home/a b');
  assert.equal(
    unit,
    `[Unit]
Description=Masthead: a local app for a tiered team of Claude agents
After=network-online.target

[Service]
ExecStart="/opt/we ird/%%x/$$y/\\"q\\"/a&b<c>/node" --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED "/lib/masthead/dist/server/main.js" serve
Environment="PATH=/opt/we ird/%%x/$y/\\"q\\"/a&b<c>:/home/a b/.local/bin:/usr/bin:/usr/local/bin:/bin"
Environment="MASTHEAD_CLAUDE=/home/a b/.local/bin/claude"
Environment="XDG_CONFIG_HOME=/c fg"
Environment="XDG_DATA_HOME=/d%%"
Environment="MASTHEAD_PORT=7720"
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
`,
  );
  const plain = unitContent({ ...base, port: 7717 }, '/h');
  assert.doesNotMatch(plain, /MASTHEAD_PORT|MASTHEAD_CLAUDE|XDG_/, 'the default port, no claude and no XDG add nothing');
  assert.match(plain, /^Environment="PATH=\/usr\/bin:\/x:\/h\/.local\/bin:\/usr\/local\/bin:\/bin"$/m);
});

const UNIT_FILE = '/home/a b/.config/systemd/user/masthead.service';

test('systemd: install writes ~/.config/systemd/user (not the shell XDG_CONFIG_HOME), checks with cat, enables, restarts', async () => {
  const f = fake((_c, a) => (a[1] === 'cat' ? { stdout: `# ${UNIT_FILE}\n[Unit]\n` } : {}), { env: { XDG_CONFIG_HOME: '/cfg' } });
  const svc = serviceFor('linux', f.deps)!;
  assert.equal(svc.kind, 'systemd');
  const lines = await svc.install(base);
  assert.ok(lines.length > 0);
  assert.ok(f.files.has(UNIT_FILE));
  assert.deepEqual(f.ops, ['mkdir /home/a b/.config/systemd/user', `write ${UNIT_FILE}`]);
  assert.deepEqual(f.calls, [
    ['systemctl', '--user', 'show-environment'],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'cat', 'masthead.service'],
    ['systemctl', '--user', 'enable', '--quiet', 'masthead.service'],
    ['systemctl', '--user', 'restart', 'masthead.service'],
  ]);
});

test('systemd: a unit systemd cannot find, or reads from elsewhere, is rolled back', async () => {
  const lost = fake((_c, a) => (a[1] === 'cat' ? { status: 1, stderr: 'No files found for masthead.service.' } : {}));
  await assert.rejects(serviceFor('linux', lost.deps)!.install(base), (e: Error) => e instanceof ServiceError && e.message.includes(UNIT_FILE) && /search path/.test(e.message));
  assert.equal(lost.files.size, 0, 'the written unit is removed');
  assert.ok(!lost.calls.some((c) => c[2] === 'enable'));
  assert.deepEqual(lost.calls.slice(-2), [['systemctl', '--user', 'disable', '--now', 'masthead.service'], ['systemctl', '--user', 'daemon-reload']]);
  const other = fake((_c, a) => (a[1] === 'cat' ? { stdout: '# /x/systemd/user/masthead.service\n' } : {}));
  await assert.rejects(serviceFor('linux', other.deps)!.install(base), /reads masthead.service from \/x\/systemd\/user/);
  assert.equal(other.files.size, 0);
});

test('systemd: install refuses without user services, and fails loudly when systemctl fails', async () => {
  const none = fake((_c, a) => (a[1] === 'show-environment' ? { status: 1 } : {}));
  await assert.rejects(serviceFor('linux', none.deps)!.install(base), /not available/);
  assert.equal(none.files.size, 0, 'nothing written');
  const bad = fake((_c, a) => (a[1] === 'restart' ? { status: 1, stderr: 'boom' } : {}));
  await assert.rejects(serviceFor('linux', bad.deps)!.install(base), /restart.*boom/);
  assert.equal(bad.files.size, 0, 'a failed restart rolls the unit back');
  assert.deepEqual(bad.ops.slice(-1), [`rm ${UNIT_FILE}`]);
  const reload = fake((_c, a) => (a[1] === 'daemon-reload' && reload.files.size ? { status: 1, stderr: 'nope' } : {}));
  await assert.rejects(serviceFor('linux', reload.deps)!.install(base), /daemon-reload.*nope/);
  assert.equal(reload.files.size, 0);
});

test('systemd: uninstall disables, removes the unit (and an old $XDG_CONFIG_HOME one), reloads', async () => {
  const f = fake((_c, a) => (a[1] === 'disable' ? { status: 5 } : {}), { env: { XDG_CONFIG_HOME: '/cfg' } });
  f.files.set(UNIT_FILE, 'x');
  f.files.set('/cfg/systemd/user/masthead.service', 'x');
  const lines = await serviceFor('linux', f.deps)!.uninstall();
  assert.deepEqual(f.calls, [
    ['systemctl', '--user', 'disable', '--now', 'masthead.service'],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
  assert.deepEqual(f.ops, [`rm ${UNIT_FILE}`, 'rm /cfg/systemd/user/masthead.service']);
  assert.ok(lines.includes(`Removed ${UNIT_FILE}`));
});

test('systemd: uninstall with nothing installed is a no-op', async () => {
  const f = fake((_c, a) => (a[1] === 'show' ? { stdout: 'LoadState=not-found\n' } : {}));
  assert.deepEqual(await serviceFor('linux', f.deps)!.uninstall(), ['Nothing was installed.']);
  assert.ok(!f.calls.some((c) => c[2] === 'disable'));
  assert.deepEqual(f.ops, []);
});

test('systemd: status and serves read systemctl show', async () => {
  const show = ['systemctl', '--user', 'show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Environment', 'masthead.service'];
  let out = 'LoadState=loaded\nActiveState=active\nEnvironment="PATH=/home/a b/bin" MASTHEAD_PORT=7731\n';
  const f = fake(() => ({ stdout: out }));
  const svc = serviceFor('linux', f.deps)!;
  assert.deepEqual(await svc.status(), {
    installed: true,
    running: true,
    port: 7731,
    dataDir: '/home/a b/.local/share/masthead',
    detail: 'masthead.service active, port 7731, data /home/a b/.local/share/masthead',
  });
  assert.deepEqual(f.calls[0], show);
  assert.equal(svc.serves(7731), true);
  assert.equal(svc.serves(7717), false);
  out = 'LoadState=loaded\nActiveState=failed\nEnvironment=PATH=/usr/bin\n';
  assert.equal((await svc.status()).running, false);
  assert.equal(svc.serves(7717), true, 'no MASTHEAD_PORT means the default');
  out = 'LoadState=not-found\nActiveState=inactive\nEnvironment=\n';
  assert.equal((await svc.status()).installed, false);
  assert.equal(svc.serves(7717), false);
  const broken = serviceFor('linux', fake(() => ({ status: 1, stderr: 'no bus' })).deps)!;
  assert.deepEqual(await broken.status(), { installed: false, running: null, port: null, detail: 'systemctl failed: no bus' });
  assert.equal(broken.serves(7717), false);
});

test('systemd/launchd: MASTHEAD_*_DIR are passed on and status shows the data folder the service uses', async () => {
  const env = { PATH: '/usr/bin', MASTHEAD_DATA_DIR: '/srv/m data', MASTHEAD_CONFIG_DIR: '/etc/m' };
  const unit = unitContent({ ...base, env }, '/h');
  assert.match(unit, /^Environment="MASTHEAD_CONFIG_DIR=\/etc\/m"$/m);
  assert.match(unit, /^Environment="MASTHEAD_DATA_DIR=\/srv\/m data"$/m);
  const xml = plistContent({ ...base, env }, '/Users/a');
  assert.match(xml, /<key>MASTHEAD_DATA_DIR<\/key>\s*<string>\/srv\/m data<\/string>/);
  assert.match(xml, /<key>MASTHEAD_CONFIG_DIR<\/key>\s*<string>\/etc\/m<\/string>/);
  assert.deepEqual(unitEnvFrom('Environment="PATH=/a b" "MASTHEAD_DATA_DIR=/srv/m \\"d\\"" XDG_DATA_HOME=/x\n'), { PATH: '/a b', MASTHEAD_DATA_DIR: '/srv/m "d"', XDG_DATA_HOME: '/x' });
  const show = 'LoadState=loaded\nActiveState=active\nEnvironment="MASTHEAD_DATA_DIR=/srv/m data"\n';
  const same = await serviceFor('linux', fake(() => ({ stdout: show }), { env: { MASTHEAD_DATA_DIR: '/srv/m data' } }).deps)!.status();
  assert.equal(same.dataDir, '/srv/m data');
  assert.match(same.detail, /data \/srv\/m data$/);
  const differs = await serviceFor('linux', fake(() => ({ stdout: show })).deps)!.status();
  assert.match(differs.detail, /data \/srv\/m data \(this shell uses \/home\/a b\/.local\/share\/masthead\)/, 'a mismatch is visible');
  const print = `gui/501/${LABEL} = {\n\tstate = running\n\tenvironment = {\n\t\tXDG_DATA_HOME => /xd\n\t}\n\tinherited environment = {\n\t\tMASTHEAD_DATA_DIR => /no\n\t}\n}\n`;
  assert.deepEqual(launchdEnvFrom(print), { XDG_DATA_HOME: '/xd' });
  const mac = await serviceFor('darwin', fake(() => ({ stdout: print }), { uid: 501, home: '/Users/a' }).deps)!.status();
  assert.equal(mac.dataDir, '/xd/masthead');
});

test('service: a line break or NUL in any value is refused, naming the variable', async () => {
  assert.throws(() => checkValue('X', 'a\nb'), (e: Error) => e instanceof ServiceError && /^X contains a line break/.test(e.message));
  assert.throws(() => checkValue('X', 'a\rb'), ServiceError);
  assert.throws(() => checkValue('X', 'a\0b'), ServiceError);
  assert.equal(checkValue('X', 'a b'), 'a b');
  const evil = { ...base, env: { PATH: '/usr/bin:/x\nExecStartPre=/bin/evil' } };
  assert.throws(() => unitContent(evil, '/h'), /PATH contains a line break/);
  assert.throws(() => plistContent(evil, '/h'), /PATH contains a line break/);
  assert.throws(() => unitContent({ ...base, mainJs: '/m\n/main.js' }, '/h'), /main\.js path contains/);
  assert.throws(() => unitContent({ ...base, env: { MASTHEAD_DATA_DIR: '/d\r' } }, '/h'), /MASTHEAD_DATA_DIR contains/);
  assert.throws(() => taskXml({ ...base, node: 'C:\\n\node.exe' }, 'u'), /node path contains/);
  assert.throws(() => taskXml(base, 'PC\\a\0'), /user name contains/);
  const f = fake();
  await assert.rejects(serviceFor('linux', f.deps)!.install(evil), ServiceError);
  assert.equal(f.files.size, 0, 'nothing written');
  const w = fake(undefined, { tmpdir: 'T' });
  await assert.rejects(serviceFor('win32', w.deps)!.install({ ...base, mainJs: 'C:\\m\n.js' }), ServiceError);
  assert.deepEqual(w.ops, []);
  assert.deepEqual(w.calls, []);
});

test('systemd: the port parser matches the launcher one', () => {
  assert.equal(unitPortFrom(''), null);
  assert.equal(unitPortFrom('LoadState=loaded\nEnvironment=NOT_MASTHEAD_PORT=7732\n'), 7717);
  assert.equal(unitPortFrom('LoadState=loaded\nEnvironment=MASTHEAD_PORT=12\n'), 7717, 'a port the server would refuse');
});

test('launchd: the plist is escaped XML with the agreed keys', () => {
  const xml = plistContent({ ...base, node: odd, claudePath: '/c/claude', port: 7720, env: { PATH: '/usr/bin', XDG_DATA_HOME: "/d'" } }, '/Users/a&b');
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  assert.match(
    xml,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/we ird\/%x\/\$y\/&quot;q&quot;\/a&amp;b&lt;c&gt;\/node<\/string>\s*<string>--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED<\/string>\s*<string>\/lib\/masthead\/dist\/server\/main.js<\/string>\s*<string>serve<\/string>\s*<\/array>/,
  );
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/we ird\/%x\/\$y\/&quot;q&quot;\/a&amp;b&lt;c&gt;:\/c:\/usr\/bin:\/Users\/a&amp;b\/.local\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(xml, /<key>MASTHEAD_CLAUDE<\/key>\s*<string>\/c\/claude<\/string>/);
  assert.match(xml, /<key>XDG_DATA_HOME<\/key>\s*<string>\/d&apos;<\/string>/);
  assert.match(xml, /<key>MASTHEAD_PORT<\/key>\s*<string>7720<\/string>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/a&amp;b\/Library\/Logs\/Masthead\/masthead.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>/);
  assert.doesNotMatch(xml.replace(/&(amp|lt|gt|quot|apos);/g, ''), /&/, 'no bare ampersand');
});

test('launchd: install boots out the old agent (ignoring failure) then bootstraps; uninstall boots out', async () => {
  const f = fake((_c, a) => (a[0] === 'bootout' ? { status: 3 } : {}), { home: '/Users/a', uid: 501 });
  const svc = serviceFor('darwin', f.deps)!;
  assert.equal(svc.kind, 'launchd');
  await svc.install(base);
  const plist = `/Users/a/Library/LaunchAgents/${LABEL}.plist`;
  assert.ok(f.files.has(plist));
  assert.ok(f.ops.includes('mkdir /Users/a/Library/Logs/Masthead'));
  assert.deepEqual(f.calls, [
    ['launchctl', 'bootout', `gui/501/${LABEL}`],
    ['launchctl', 'bootstrap', 'gui/501', plist],
  ]);
  f.calls.length = 0;
  await svc.uninstall();
  assert.deepEqual(f.calls, [['launchctl', 'bootout', `gui/501/${LABEL}`]]);
  assert.ok(!f.files.has(plist));
  const bad = fake((_c, a) => (a[0] === 'bootstrap' ? { status: 5, stderr: 'Bootstrap failed: 5' } : {}), { uid: 501 });
  await assert.rejects(serviceFor('darwin', bad.deps)!.install(base), /Bootstrap failed/);
  assert.equal(bad.files.size, 0, 'a failed bootstrap removes the plist');
  assert.deepEqual(bad.calls.at(-1), ['launchctl', 'bootout', `gui/501/${LABEL}`]);
});

test('launchd: uninstall with nothing installed is a no-op', async () => {
  const f = fake((_c, a) => (a[0] === 'print' ? { status: 113 } : {}), { uid: 501 });
  assert.deepEqual(await serviceFor('darwin', f.deps)!.uninstall(), ['Nothing was installed.']);
  assert.deepEqual(f.calls, [['launchctl', 'print', `gui/501/${LABEL}`]]);
  assert.deepEqual(f.ops, []);
});

test('launchd: status and serves read launchctl print', async () => {
  const print = `gui/501/${LABEL} = {\n\tactive count = 1\n\tstate = running\n\tenvironment = {\n\t\tPATH => /usr/bin\n\t\tMASTHEAD_PORT => 7725\n\t}\n}\n`;
  const f = fake(() => ({ stdout: print }), { uid: 501 });
  const svc = serviceFor('darwin', f.deps)!;
  assert.deepEqual(await svc.status(), {
    installed: true,
    running: true,
    port: 7725,
    dataDir: '/home/a b/Library/Application Support/Masthead',
    detail: `${LABEL} running, port 7725, data /home/a b/Library/Application Support/Masthead`,
  });
  assert.deepEqual(f.calls[0], ['launchctl', 'print', `gui/501/${LABEL}`]);
  assert.equal(svc.serves(7725), true);
  assert.equal(svc.serves(7717), false);
  assert.equal(launchdPortFrom('state = waiting\n'), 7717);
  const gone = serviceFor('darwin', fake(() => ({ status: 113 }), { uid: 501 }).deps)!;
  assert.equal((await gone.status()).installed, false);
  assert.equal(gone.serves(7717), false);
});

test('taskscheduler: Windows arguments are quoted as node.exe parses them', () => {
  assert.equal(winQuote('plain'), 'plain');
  assert.equal(winQuote(''), '""');
  assert.equal(winQuote('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(winQuote('C:\\a b\\'), '"C:\\a b\\\\"', 'a trailing backslash before the closing quote is doubled');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(winQuote('a\\"b c'), '"a\\\\\\"b c"');
  assert.equal(winQuote('C:\\no\\spaces'), 'C:\\no\\spaces');
});

test('taskscheduler: the task XML runs node hidden at logon with least privilege', () => {
  const o = { node: 'C:\\Program Files\\nodejs\\node.exe', mainJs: 'C:\\Users\\A & B\\npm\\<m>\\main.js', port: 7720, env: {} };
  assert.deepEqual(taskAction(o).args.slice(-2), ['--port', '7720']);
  assert.ok(!taskAction({ ...o, port: 7717 }).args.includes('--port'));
  const xml = taskXml(o, 'PC\\A&B');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\A&amp;B<\/UserId>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/);
  assert.match(xml, /<Command>conhost.exe<\/Command>/);
  assert.ok(
    xml.includes(
      '<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED &quot;C:\\Users\\A &amp; B\\npm\\&lt;m&gt;\\main.js&quot; serve --port 7720</Arguments>',
    ),
    xml,
  );
  const bytes = utf16le('<a/>');
  assert.deepEqual([...bytes.slice(0, 4)], [0xff, 0xfe, 0x3c, 0x00], 'UTF-16LE with a byte order mark');
});

test('taskscheduler: install writes the XML to a temp file, creates and runs the task', async () => {
  const f = fake(undefined, { tmpdir: 'C:\\Temp', env: { USERDOMAIN: 'PC', USERNAME: 'a', XDG_DATA_HOME: 'D:\\d' } });
  const svc = serviceFor('win32', f.deps)!;
  assert.equal(svc.kind, 'taskscheduler');
  const lines = await svc.install({ node: 'C:\\n\\node.exe', mainJs: 'C:\\m\\main.js', env: { XDG_DATA_HOME: 'D:\\d' } });
  const tmp = `C:\\Temp\\masthead-task-${process.pid}.xml`;
  assert.deepEqual(f.calls, [
    ['schtasks', '/End', '/TN', 'Masthead'],
    ['schtasks', '/Create', '/TN', 'Masthead', '/XML', tmp, '/F'],
    ['schtasks', '/Run', '/TN', 'Masthead'],
  ]);
  assert.deepEqual(f.ops, [`write ${tmp}`, `rm ${tmp}`], 'the temp file is removed');
  assert.ok(lines.some((l) => /XDG_DATA_HOME/.test(l)), 'says which variables the task does not get');
  const bad = fake((_c, a) => (a[0] === '/Create' ? { status: 1, stderr: 'ERROR: access denied' } : {}), { tmpdir: 'T' });
  await assert.rejects(serviceFor('win32', bad.deps)!.install(base), /access denied/);
  assert.equal(bad.files.size, 0, 'temp file removed after a failure too');
  assert.ok(!bad.calls.some((c) => c[1] === '/Run'));
  assert.deepEqual(bad.calls.at(-1), ['schtasks', '/Delete', '/TN', 'Masthead', '/F']);
  const run = fake((_c, a) => (a[0] === '/Run' ? { status: 1, stderr: 'ERROR: cannot run' } : {}), { tmpdir: 'T' });
  await assert.rejects(serviceFor('win32', run.deps)!.install(base), /cannot run/);
  assert.deepEqual(run.calls.at(-1), ['schtasks', '/Delete', '/TN', 'Masthead', '/F'], 'a task that cannot run is deleted');
  assert.equal(run.files.size, 0);
});

test('taskscheduler: uninstall with no task is a no-op; other /Delete failures still throw', async () => {
  const missing = { status: 1, stderr: 'ERROR: The system cannot find the file specified.' };
  const none = fake((_c, a) => (a[0] === '/End' || a[0] === '/Delete' || a[0] === '/Query' ? missing : {}));
  assert.deepEqual(await serviceFor('win32', none.deps)!.uninstall(), ['Nothing was installed.']);
  const denied = fake((_c, a) => (a[0] === '/Delete' ? { status: 1, stderr: 'ERROR: Access is denied.' } : {}));
  await assert.rejects(serviceFor('win32', denied.deps)!.uninstall(), /Access is denied/);
});

test('taskscheduler: uninstall ends and deletes; status and serves read the query', async () => {
  const f = fake();
  await serviceFor('win32', f.deps)!.uninstall();
  assert.deepEqual(f.calls, [
    ['schtasks', '/End', '/TN', 'Masthead'],
    ['schtasks', '/Delete', '/TN', 'Masthead', '/F'],
  ]);
  const out = 'HostName: PC\r\nTaskName: \\Masthead\r\nStatus: Running\r\nTask To Run: conhost.exe --headless "C:\\n\\node.exe" C:\\m\\main.js serve --port 7726\r\n';
  const q = fake(() => ({ stdout: out }));
  const svc = serviceFor('win32', q.deps)!;
  assert.deepEqual(await svc.status(), { installed: true, running: true, port: 7726, detail: 'Task "Masthead" Running, port 7726' });
  assert.deepEqual(q.calls[0], ['schtasks', '/Query', '/TN', 'Masthead', '/FO', 'LIST', '/V']);
  assert.equal(svc.serves(7726), true);
  assert.equal(svc.serves(7717), false);
  assert.deepEqual(parseTaskQuery('Status: Ready\r\nTask To Run: conhost.exe --headless node.exe main.js serve\r\n'), { status: 'Ready', port: 7717 });
  assert.equal(parseTaskQuery('Statut: En cours\r\n').status, null, 'other display languages: unknown');
  const gone = serviceFor('win32', fake(() => ({ status: 1 })).deps)!;
  assert.equal((await gone.status()).installed, false);
});

test('service: other platforms have none', () => {
  assert.equal(serviceFor('freebsd', fake().deps), null);
});
