# server/service

**Role:** the background service that starts Masthead when the person logs in (`masthead service install|uninstall|status`), one implementation per platform, plus `awake.ts`, which keeps the computer from idling to sleep while agents work. Everything that touches the system goes through a `Deps` object, so the files written and the command sequences are tested without running `systemctl`, `launchctl` or `schtasks` (`test/service.test.ts`, `test/awake.test.ts`, `test/awake-app.test.ts`). How the person uses it is on [Command-line launcher](Command-Line-Launcher.md#service); the caller is `serviceCommand()` in [server/main.ts](Source-Main.md#servicecommandp).

> Checked against the 0.2.0 source on branch `next` (2026-11-27). The behaviour described here is read from the code, not verified by running. The launchd and Task Scheduler code says in its own header that it is **unverified** without a Mac or a Windows machine.

| File | What |
|---|---|
| `types.ts` | The shared types and `ServiceError`. |
| `index.ts` | `serviceFor(platform)` and the real `systemDeps()`. |
| `common.ts` | Helpers: `NODE_FLAGS`, `cleanPath`, `serviceEnv`, `portOf`, `must`, `xmlEscape`. |
| `systemd.ts` | Linux: a systemd user unit. |
| `launchd.ts` | macOS: a per-user launchd agent. |
| `taskscheduler.ts` | Windows: a per-user scheduled task. |
| `awake.ts` | Keeping the computer awake while agents work. |

## types.ts

| Name | What |
|---|---|
| `InstallOptions` | `node` (absolute path of the Node binary, `process.execPath`), `mainJs` (absolute path of `dist/server/main.js`), `port?` (omitted or 7717 means the default), `env` (where `PATH` and `XDG_*` come from, normally `process.env`), `claudePath?` (the Claude Code found by the caller). |
| `ServiceStatus` | `installed`, `running` (`boolean` or `null` when it cannot be told), `port` (when installed), `detail`. |
| `ServiceManager` | `kind` (`'systemd' \| 'launchd' \| 'taskscheduler'`), `install(o)` (writes the service, (re)starts it, returns lines to print; throws on failure), `uninstall()`, `status()`, `serves(port)` (whether the installed service serves that port). |
| `RunResult` | `{ status, stdout, stderr }`; `status` is null when the command could not start. |
| `ServiceFs` | `writeFile`, `mkdir` (recursive, no error when it exists), `rm` (no error when missing). |
| `Deps` | `run(cmd, args)` (spawnSync-like, never throws for a non-zero exit), `fs`, `home`, `env`, `uid?` (launchd only), `tmpdir?` (Task Scheduler only). |
| `ServiceError` | A failure to report to the person; `main.ts` prints its message and exits 1. |

## index.ts

- `systemDeps()`: the real system. `run` is `spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })` with `status` null when `spawnSync` reports an error (and that error's message as `stderr` when there is none); `fs` uses `writeFileSync`, `mkdirSync(..., { recursive: true })`, `rmSync(..., { force: true })`; `home` is `os.homedir()`; `env` is `process.env`.
- `serviceFor(platform, deps?)`: `linux` → `systemdService`, `darwin` → `launchdService`, `win32` → `taskSchedulerService`, anything else → null (Masthead then runs only in the foreground). Without `deps` it uses `systemDeps()`.

`main.ts` calls `serviceFor(process.platform)` for `masthead service` and for the `Service` check of `masthead doctor`. The launcher's own "does the unit serve this port" test (`unitServes()` in `main.ts`) does not use `serves()`; it runs `systemctl` itself and is Linux only.

## common.ts

| Name | What |
|---|---|
| `NODE_FLAGS` | `['--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED']`, the warning the installed command and unit both silence. |
| `cleanPath(parts)` | Joins colon-separated pieces into one `PATH`, keeping only absolute entries (starting with `/`) and dropping repeats, in order (the same as `clean_path` in `scripts/path.sh`). A relative entry would be looked up from wherever the service runs. |
| `serviceEnv(o, tail)` | The variables a POSIX service gets: `PATH` = `cleanPath([folder of node, folder of claude, o.env.PATH, ...tail])`; `MASTHEAD_CLAUDE` when `claudePath` is set; `XDG_CONFIG_HOME` and `XDG_DATA_HOME` when set; `MASTHEAD_PORT` when the port is given and not 7717. `MASTHEAD_CONFIG_DIR` and `MASTHEAD_DATA_DIR` are **not** passed on. |
| `portOf(raw)` | A port from text (digits only, 1024–65535), else null. |
| `must(run, cmd, args)` | Runs a command that must succeed. On a non-zero or null status it throws `ServiceError('<cmd> <args> failed: <why>')`, where `why` is stderr, else stdout, else `it could not be started` or `exit code <n>`. |
| `xmlEscape(s)` | Escapes `& < > " '` for XML. |

## systemd.ts

Linux. The same unit that `scripts/install.sh` writes ([Installing](Source-Install-Scripts.md)).

**File:** `unitPath()` = `$XDG_CONFIG_HOME/systemd/user/masthead.service`, else `~/.config/systemd/user/masthead.service`. `unitContent(o, home)`:

```ini
[Unit]
Description=Masthead: a local app for a tiered team of Claude agents
After=network-online.target

[Service]
ExecStart="<node>" --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED "<main.js>" serve
Environment="PATH=..."            # one line per serviceEnv() variable
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
```

`PATH` gets `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` after the node, claude and current `PATH` entries. Words are quoted with `unitQuote()` (backslash and `"` escaped, `%` doubled; install.sh `unit_quote`); `ExecStart` words also double `$` (`execQuote()`).

| Action | Commands (all `systemctl --user …`) |
|---|---|
| `install` | `show-environment` (a failure throws `systemd user services are not available here; start Masthead with: masthead`), write the file, `daemon-reload`, `enable --quiet masthead.service`, `restart masthead.service` (the last three through `must`). Returns `Wrote <file>` and `Masthead is running as a user service and will start when you log in.` |
| `uninstall` | `disable --now masthead.service` (its failure is ignored: removing the file is what matters), remove the file, `daemon-reload` (not checked). |
| `status` | `show -p LoadState -p ActiveState -p Environment masthead.service`. A failing `systemctl` gives `installed: false, running: null` with `systemctl failed: …`. `LoadState` other than `loaded`: `Not installed.`. Otherwise installed, running when `ActiveState` is `active` or `reloading`, port from `unitPortFrom()`, detail `masthead.service <state>, port <n>`. |
| `serves(port)` | The same `show`, and `unitPortFrom()` equals `port`. |

`unitPortFrom(show)` here is like the one in [server/cli.ts](Source-Cli.md#unitportfromshowoutput): null when not `loaded`, else `MASTHEAD_PORT` from `Environment=` if valid (`portOf`), else 7717.

## launchd.ts

macOS. **Unverified without a Mac** (file header): the plist keys follow `launchd.plist(5)`, the `launchctl bootstrap/bootout/print` forms follow `launchctl(1)`, and the `print` output it parses is from documentation, not a real run.

- Label `LABEL` = `io.github.luxorium.masthead`.
- File: `plistPath()` = `~/Library/LaunchAgents/io.github.luxorium.masthead.plist`.
- Log: `logPath()` = `~/Library/Logs/Masthead/masthead.log`, used for both stdout and stderr.
- `plistContent(o, home)`: `ProgramArguments` = node, `NODE_FLAGS`, main.js, `serve`; `RunAtLoad` true; `KeepAlive` = `{ SuccessfulExit: false }` (restart only after a failed exit); `EnvironmentVariables` from `serviceEnv()` with `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` at the end of `PATH` (a login session's launchd `PATH` is only the system folders; Homebrew lives in `/opt/homebrew/bin` or `/usr/local/bin`). Every string is XML-escaped.
- Domain: `gui/<uid>`, with `uid` from `deps.uid` or `process.getuid()`; no uid throws `Cannot tell the user id for launchctl.`

| Action | What it does |
|---|---|
| `install` | Makes the LaunchAgents and log folders, writes the plist, `launchctl bootout gui/<uid>/<label>` (failure ignored: an agent already loaded keeps its old definition until booted out), `launchctl bootstrap gui/<uid> <file>` (must succeed). Returns `Wrote <file>`, the running message and `Logs: <log>`. |
| `uninstall` | `bootout` (not checked), removes the plist. |
| `status` | `launchctl print gui/<uid>/<label>`. Non-zero: not installed. Otherwise running when a `state = running` line is found, `null` when there is no `state =` line; port from `launchdPortFrom()` (a `MASTHEAD_PORT => N` line, else 7717). |
| `serves(port)` | The same `print`, and the port matches. |

## taskscheduler.ts

Windows. **Unverified without a Windows machine** (file header): the XML follows the Task Scheduler 1.2 schema, the `schtasks` options follow its documentation, and the `/Query /FO LIST /V` field names parsed are the English ones. On a Windows in another display language `status` reports running as unknown. Whether `conhost.exe --headless` keeps the console hidden on every supported Windows 10/11 build is also untested.

- Task name `TASK` = `Masthead`.
- `taskAction(o)`: runs `conhost.exe --headless <node> --disable-warning=… <main.js> serve`, with `--port N` added when the port is not 7717. `conhost --headless` runs Node with no visible console window.
- **Environment:** a task cannot set environment variables, and wrapping the command in `cmd.exe /c "set …"` breaks on `%`, `^`, `&` and quotes and shows a window (file header). So only the port is passed; otherwise the task inherits the person's logon environment, where `PATH` is the one Claude Code's installer updates. `MASTHEAD_CLAUDE`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are not carried over; `install` adds a note naming any of them set in the current shell and suggests `setx`.
- `winQuote(arg)`: quotes one argument the way `CommandLineToArgvW` and `node.exe` parse it (backslashes before a `"` doubled).
- `taskUser(env)`: `USERDOMAIN\USERNAME`, or just `USERNAME` (default `user`).
- `taskXml(o, user)`: UTF-16 task XML with a `LogonTrigger` for that user, principal `InteractiveToken` with `LeastPrivilege` (no admin rights), `MultipleInstancesPolicy` `IgnoreNew`, runs on battery, `Hidden`, no time limit (`PT0S`), priority 7, `RestartOnFailure` every minute up to 3 times, and the `Exec` action from `taskAction()`.
- `utf16le(text)`: the XML as UTF-16LE with a byte order mark, as `schtasks /XML` wants.

| Action | Commands |
|---|---|
| `install` | Writes the XML to `<tmpdir>/masthead-task-<pid>.xml`; `schtasks /End /TN Masthead` (failure ignored: `/Create /F` would leave a running copy on the old definition); `schtasks /Create /TN Masthead /XML <file> /F` (must succeed; the file is removed whatever happens); `schtasks /Run /TN Masthead` (must succeed). |
| `uninstall` | `schtasks /End /TN Masthead` (not checked), then `schtasks /Delete /TN Masthead /F` (must succeed). |
| `status` | `schtasks /Query /TN Masthead /FO LIST /V`. Non-zero: not installed. Otherwise `parseTaskQuery()` reads `Status:` (running when it is `Running`, null when missing) and the port from `--port N` in `Task To Run:` (else 7717). |
| `serves(port)` | The same query, and the port matches. |

## Keep awake (awake.ts)

Keeps the computer from **idling** to sleep while any agent is working. Only idle sleep is held off: closing the lid, the power button or choosing Sleep still work, and the screen may still turn off (file header).

### What is held, per platform

`awakeCommand(platform, pid)` returns the child process that holds it, or null where there is none:

| Platform | Command | How it ends |
|---|---|---|
| Linux | `systemd-inhibit --what=idle --who=Masthead "--why=Agents are working" --mode=block cat` | `cat` ends when Masthead closes its stdin |
| macOS | `caffeinate -i -w <server pid>` | ends when the server process is gone |
| Windows | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>`: calls `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` and exits 3 if that returns 0, then reads stdin to the end | ends when Masthead closes its stdin |
| other | none | |

Each one therefore ends by itself when the server exits, even if it crashes (file header; not verified by running). On Windows `ES_SYSTEM_REQUIRED` does not keep the display on and does not block an explicit sleep. The child is spawned with stdin piped, stdout and stderr ignored, and `windowsHide: true`.

### The Awake class

- `set(working)`: with `true`, cancels a pending release and starts the hold if it is not already wanted. With `false`, if a hold is wanted it schedules the release after `RELEASE_AFTER_MS` (**5 seconds**), so short gaps between work do not flap it. Repeated calls are harmless. The release timer is `unref`'d.
- `stop()`: releases at once and cancels any timer.
- Release closes the child's stdin and then kills it.
- `status()`: `holding`, `unavailable` (with the last error) or `off`.
- Errors are recorded, not thrown: no command for the platform (`Keeping the computer awake is not supported on <platform>.`), a spawn that throws or emits `error` (`Could not start <cmd>: …`), or the child exiting while still wanted (`<cmd> ended (exit <code>); the computer may sleep while agents work.`, for example no logind or a policy refusal). A failed hold is not retried until work starts again, so a missing tool costs one attempt per busy period. Masthead carries on without it; `masthead doctor` reports whether the tool is on `PATH` ([server/doctor.ts](Source-Doctor.md)).

### How the app uses it

- `runServer()` in [server/main.ts](Source-Main.md) creates `new App({ remote, awake: new Awake() })`. The `awake` option is any object with `set(working)` and `stop()`; tests pass a fake.
- `App.keepAwake()` in `server/app/app.ts` calls `awake.set(settings.keepAwake !== false && workingCount() > 0)`, where `workingCount()` is the number of busy conversations. It runs when a conversation's busy state changes (`agentChanged()`), when a conversation is deleted, and when settings change. So turning the setting off releases the hold after the same 5-second delay, not at once.
- `App.shutdown()` calls `awake.stop()` first.
- The setting `keepAwake` defaults to true, and settings saved before the field existed get true (`server/settings/settings.ts`). The page shows it as "Keep this computer awake while helpers are working" ([Configuration and settings](Configuration-and-Settings.md)).

### The sleep notice

Separately, `server/core/conversation.ts` notices when the computer **did** sleep: an awake-time clock read every 15 seconds sees a gap larger than its step (60 s) and calls `Conversation.wokeFromSleep(from, to)` on every conversation. A conversation that is busy adds an info notice to its lead's transcript: `This computer was asleep from <time> to <time>; work carried on afterwards.` The time asleep never counts as running time ([Agent life cycle](Agent-Life-Cycle.md)).

## Related pages

[Command-line launcher](Command-Line-Launcher.md#service) · [server/main.ts](Source-Main.md) · [server/doctor.ts](Source-Doctor.md) · [server/paths.ts](Source-Paths.md) · [Installing](Source-Install-Scripts.md) · [Configuration and settings](Configuration-and-Settings.md) · [Security model](Security-Model.md) · [Platforms](Platforms.md) · [Tests](Source-Tests.md)
