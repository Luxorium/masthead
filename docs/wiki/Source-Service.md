# server/service

**Role:** the background service that starts Masthead when the person logs in (`masthead service install|uninstall|status`), one implementation per platform, plus `awake.ts`, which keeps the computer from idling to sleep while agents work. Everything that touches the system goes through a `Deps` object, so the files written and the command sequences are tested without running `systemctl`, `launchctl` or `schtasks` (`test/service.test.ts`, `test/awake.test.ts`, `test/awake-app.test.ts`). How the person uses it is on [Command-line launcher](Command-Line-Launcher.md#service); the caller is `serviceCommand()` in [server/main.ts](Source-Main.md#servicecommandp).

> Checked against the 0.2.0 source on branch `next` (2026-11-27). The behaviour described here is read from the code, not verified by running. The launchd and Task Scheduler code says in its own header that it is **unverified** without a Mac or a Windows machine. The out-of-memory handling, scratch folders and usage probe (`laststop.ts`, `scratch.ts`, `usage.ts`, `OOMPolicy`/`ExecStopPost`) were checked against the uncommitted 0.2.1-beta.1 working tree on the same day; they are covered by `test/service-health.test.ts` with every system call faked, not by a real out-of-memory kill.

| File | What |
|---|---|
| `types.ts` | The shared types and `ServiceError`. |
| `index.ts` | `serviceFor(platform)` and the real `systemDeps()`. |
| `common.ts` | Helpers: `NODE_FLAGS`, `DIR_VARS`, `cleanPath`, `checkValue`, `serviceEnv`, `dataDirNote`, `portOf`, `must`, `xmlEscape`, `statusSummary`. |
| `systemd.ts` | Linux: a systemd user unit. |
| `launchd.ts` | macOS: a per-user launchd agent. |
| `taskscheduler.ts` | Windows: a per-user scheduled task. |
| `awake.ts` | Keeping the computer awake while agents work. |
| `laststop.ts` | Linux: why the service stopped last time (the `ExecStopPost` marker), and the out-of-memory restart notice. |
| `scratch.ts` | The private scratch folder per conversation that agents get as their temporary folder. |
| `usage.ts` | Linux: the running service's memory and child processes, and what `/tmp` is; for `masthead doctor`. |

## types.ts

| Name | What |
|---|---|
| `InstallOptions` | `node` (absolute path of the Node binary, `process.execPath`), `mainJs` (absolute path of `dist/server/main.js`), `port?` (omitted or 7717 means the default), `env` (where `PATH` and `XDG_*` come from, normally `process.env`), `claudePath?` (the Claude Code found by the caller). |
| `ServiceStatus` | `installed`, `running` (`boolean` or `null` when it cannot be told), `port` (when installed), `dataDir?` (the data folder the installed service uses, from its own environment; systemd and launchd only), `detail`, `outdated?` (set when the installed service file is older than what this Masthead would write, saying why in words; fixed by `masthead service install`; only systemd sets it). |
| `ServiceManager` | `kind` (`'systemd' \| 'launchd' \| 'taskscheduler'`), `install(o)` (writes the service, (re)starts it, returns lines to print; throws on failure), `uninstall()`, `status()`, `serves(port)` (whether the installed service serves that port). |
| `RunResult` | `{ status, stdout, stderr }`; `status` is null when the command could not start. |
| `ServiceFs` | `writeFile`, `mkdir` (recursive, no error when it exists), `rm` (no error when missing), `exists`. |
| `Deps` | `run(cmd, args)` (spawnSync-like, never throws for a non-zero exit), `fs`, `home`, `env`, `uid?` (launchd only), `tmpdir?` (Task Scheduler only). |
| `ServiceError` | A failure to report to the person; `main.ts` prints its message and exits 1. |

## index.ts

- `systemDeps()`: the real system. `run` is `spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })` with `status` null when `spawnSync` reports an error (and that error's message as `stderr` when there is none); `fs` uses `writeFileSync`, `mkdirSync(..., { recursive: true })`, `rmSync(..., { force: true })`, `existsSync`; `home` is `os.homedir()`; `env` is `process.env`. It sets neither `uid` nor `tmpdir`, so launchd falls back to `process.getuid()` and Task Scheduler to `os.tmpdir()`.
- It re-exports the types of `types.ts` and `ServiceError`.
- `serviceFor(platform, deps?)`: `linux` → `systemdService`, `darwin` → `launchdService`, `win32` → `taskSchedulerService`, anything else → null (Masthead then runs only in the foreground). Without `deps` it uses `systemDeps()`.

`main.ts` calls `serviceFor(process.platform)` for `masthead service` and for the `Service` check of `masthead doctor`. The launcher's own "does the unit serve this port" test (`unitServes()` in `main.ts`) does not use `serves()`; it runs `systemctl` itself and is Linux only.

## common.ts

| Name | What |
|---|---|
| `NODE_FLAGS` | `['--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED']`, the warning the installed command and unit both silence. |
| `cleanPath(parts)` | Joins colon-separated pieces into one `PATH`, keeping only absolute entries (starting with `/`) and dropping repeats, in order (the same as `clean_path` in `scripts/path.sh`). A relative entry would be looked up from wherever the service runs. |
| `serviceEnv(o, tail)` | The variables a POSIX service gets: `PATH` = `cleanPath([folder of node, folder of claude, o.env.PATH, ...tail])`; `MASTHEAD_CLAUDE` when `claudePath` is set; `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `MASTHEAD_CONFIG_DIR` and `MASTHEAD_DATA_DIR` when set (`DIR_VARS`); `MASTHEAD_PORT` when the port is given and not 7717. Every value goes through `checkValue`. |
| `checkValue(name, value)` | Throws `ServiceError('<name> contains a line break or NUL character, …')` when the value has `\n`, `\r` or NUL: in a unit, plist or task XML it would start a new directive. Every generator (`unitContent`, `plistContent`, `taskXml`) checks all its values (node and main.js paths, home, user name, every environment variable) before anything is written. |
| `dataDirNote(platform, serviceVars, shellEnv, home)` | The data folder the service uses (`appDirs()` from [server/paths.ts](Source-Paths.md) over the service's own `DIR_VARS`) and a `data <dir>` note for `status`, with `(this shell uses <dir>)` added when the current shell would use a different one. |
| `portOf(raw)` | A port from text (digits only, 1024–65535), else null. |
| `must(run, cmd, args)` | Runs a command that must succeed. On a non-zero or null status it throws `ServiceError('<cmd> <args> failed: <why>')`, where `why` is stderr, else stdout, else `it could not be started` or `exit code <n>`. |
| `xmlEscape(s)` | Escapes `& < > " '` for XML. |
| `DIR_VARS` | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `MASTHEAD_CONFIG_DIR`, `MASTHEAD_DATA_DIR`: the folder variables passed on to a POSIX service, in the order `paths.ts` reads them. |
| `statusSummary(kind, st, answers, port)` | The plain-words line `main.ts` prints for `masthead service status` and at the end of `service install`: `Not installed (<kind>).` or `Installed (<kind>).`, then whether Masthead answers on the port and whether the service or the person started it (a copy started by hand keeps the port, so the service's own copy cannot start), then the status `detail` in brackets. |

## systemd.ts

Linux. The same unit that `scripts/install.sh` writes ([Installing](Source-Install-Scripts.md)).

**File:** `unitPath(home)` = `~/.config/systemd/user/masthead.service`, always. Not the shell's `$XDG_CONFIG_HOME`: systemd's user manager searches `$XDG_CONFIG_HOME/systemd/user` only when its own environment has that variable, while `~/.config/systemd/user` is always on its search path. (`scripts/install.sh` also writes to `$HOME/.config/systemd/user`; earlier installs may have written under `$XDG_CONFIG_HOME`, so `uninstall` also removes a unit found there, `legacyUnitPath()`.) The unit name is `UNIT` = `masthead.service`. `unitContent(o, home)`:

```ini
[Unit]
Description=Masthead: a local app for a tiered team of Claude agents
After=network-online.target

[Service]
ExecStart="<node>" --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED "<main.js>" serve
Environment="PATH=..."            # one line per serviceEnv() variable
ExecStopPost=-/bin/sh -c "echo \"$$SERVICE_RESULT $$EXIT_CODE $$EXIT_STATUS $$(sed -n s/^oom_kill.//p /sys/fs/cgroup$$(sed -n s/^0:://p /proc/self/cgroup)/memory.events 2>/dev/null)\" > \"$$0\"" %t/masthead-last-stop
OOMPolicy=continue
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
```

`PATH` gets `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` after the node, claude and current `PATH` entries. Words are quoted with `unitQuote()` (backslash and `"` escaped, `%` doubled; install.sh `unit_quote`); `ExecStart` words also double `$` (`execQuote()`).

Two lines added in 0.2.1, both exported so `scripts/install.sh` can write the same text word for word (`systemd.ts:36-49`):

- **`OOM_POLICY`** = `OOMPolicy=continue`. When the kernel's out-of-memory killer picks a process in the unit (often one of an agent's browser processes), systemd's default policy (`stop`) would stop the whole service, every agent with it, and restart it. With `continue` only the killed process goes.
- **`STOP_POST`**: an `ExecStopPost=` line run after every stop. It writes `$SERVICE_RESULT $EXIT_CODE $EXIT_STATUS <oom kills>` to `%t/masthead-last-stop` (`%t` is `$XDG_RUNTIME_DIR`), where `<oom kills>` is the `oom_kill` count from the unit's `memory.events` (cgroup v2; the shell finds the cgroup from `/proc/self/cgroup`). `$$` is systemd's escape for a literal `$`. The leading `-` makes a failure harmless. It is needed because systemd resets the unit's `Result` when it starts again, so `systemctl show -p Result` cannot tell afterwards. The next start reads it ([laststop.ts](#laststopts)).

| Action | Commands (all `systemctl --user …`) |
|---|---|
| `install` | `show-environment` (a failure throws `systemd user services are not available here; start Masthead with: masthead`), build the unit (a bad value throws before anything is written), make the folder and write the file, `daemon-reload` (must succeed), `cat masthead.service` (non-zero: systemd did not find the unit, the folder is not on its search path; a `# <path>` header naming another file: systemd would run that one instead), `enable --quiet masthead.service`, `restart masthead.service`. Any failure after the write rolls back (`disable --now`, remove the file, `daemon-reload`, results ignored) and rethrows. Returns `Wrote <file>` and `Installed Masthead as a user service; it starts when you log in.` |
| `uninstall` | When neither `~/.config/systemd/user/masthead.service` nor one under the shell's `$XDG_CONFIG_HOME` exists and the unit is not loaded: returns `Nothing was installed.` and runs nothing else. Otherwise `disable --now masthead.service` (its failure is ignored: removing the file is what matters), remove the files found, `daemon-reload` (not checked). Returns `Stopped and disabled the user service.` and a `Removed <file>` line per file. |
| `status` | `show -p LoadState -p ActiveState -p Environment -p OOMPolicy -p ExecStopPost masthead.service`. A failing `systemctl` gives `installed: false, running: null` with `systemctl failed: …`. `LoadState` other than `loaded`: `installed: false, running: false`, `Not installed.`. Otherwise installed, running when `ActiveState` is `active` or `reloading`, port from `unitPortFrom()`, `dataDir` from the unit's `Environment=` (`unitEnvFrom()`), detail `masthead.service <state>, port <n>, data <dir>` plus `(this shell uses <dir>)` on a mismatch. A unit written before 0.2.1 keeps the default `OOMPolicy=stop` and has no stop marker until it is written again, so `outdated` is set to `it was written by an older Masthead (<reasons>)`, the reasons joined with `; `: `OOMPolicy=<value>: running out of memory stops every agent` when the `OOMPolicy=` line is present and not `continue`, and `no stop marker: a restart for lack of memory cannot be reported` when there is no `ExecStopPost=` line containing `masthead-last-stop` (systemctl prints no such line for a unit without one). `masthead doctor` shows it as a warning. |
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
| `install` | Builds the plist (a bad value throws before anything is written), makes the LaunchAgents and log folders, writes the plist, `launchctl bootout gui/<uid>/<label>` (failure ignored: an agent already loaded keeps its old definition until booted out), `launchctl bootstrap gui/<uid> <file>` (must succeed; on failure `bootout` again and remove the plist before rethrowing). Returns `Wrote <file>`, `Installed Masthead as a launchd agent; it starts when you log in.` and `Logs: <log>`. |
| `uninstall` | No plist and `print` fails: `Nothing was installed.` Otherwise `bootout` (not checked), removes the plist; returns `Stopped the launchd agent.` and `Removed <file>` when there was one. |
| `status` | `launchctl print gui/<uid>/<label>`. Non-zero: not installed (`Not installed (not loaded in launchd).`). Otherwise running when a `state = running` line is found, `null` when there is no `state =` line; port from `launchdPortFrom()` (a `MASTHEAD_PORT => N` line, else 7717); `dataDir` and the detail's `data <dir>` note from the `environment = { … }` block (`launchdEnvFrom()`; `inherited environment` is not read). |
| `serves(port)` | The same `print`, and the port matches. |

## taskscheduler.ts

Windows. **Unverified without a Windows machine** (file header): the XML follows the Task Scheduler 1.2 schema, the `schtasks` options follow its documentation, and the `/Query /FO LIST /V` field names parsed are the English ones. On a Windows in another display language `status` reports running as unknown. Whether `conhost.exe --headless` keeps the console hidden on every supported Windows 10/11 build is also untested.

- Task name `TASK` = `Masthead`.
- `taskAction(o)`: runs `conhost.exe --headless <node> --disable-warning=… <main.js> serve`, with `--port N` added when the port is not 7717. `conhost --headless` runs Node with no visible console window.
- **Environment:** a task cannot set environment variables, and wrapping the command in `cmd.exe /c "set …"` breaks on `%`, `^`, `&` and quotes and shows a window (file header). So only the port is passed; otherwise the task inherits the person's logon environment, where `PATH` is the one Claude Code's installer updates. `MASTHEAD_CLAUDE`, `MASTHEAD_CONFIG_DIR`, `MASTHEAD_DATA_DIR`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are not carried over; `install` adds a note naming any of them set in the current shell and suggests `setx`.
- `winQuote(arg)`: quotes one argument the way `CommandLineToArgvW` and `node.exe` parse it (backslashes before a `"` doubled).
- `taskUser(env)`: `USERDOMAIN\USERNAME`, or just `USERNAME` (default `user`).
- `taskXml(o, user)`: refuses a node path, main.js path or user name with a line break or NUL (`checkValue`), then builds UTF-16 task XML with a `LogonTrigger` for that user, principal `InteractiveToken` with `LeastPrivilege` (no admin rights), `MultipleInstancesPolicy` `IgnoreNew`, runs on battery, `Hidden`, no time limit (`PT0S`), priority 7, `RestartOnFailure` every minute up to 3 times, and the `Exec` action from `taskAction()`.
- `utf16le(text)`: the XML as UTF-16LE with a byte order mark, as `schtasks /XML` wants.

| Action | Commands |
|---|---|
| `install` | Writes the XML to `<tmpdir>/masthead-task-<pid>.xml`; `schtasks /End /TN Masthead` (failure ignored: `/Create /F` would leave a running copy on the old definition); `schtasks /Create /TN Masthead /XML <file> /F` and `schtasks /Run /TN Masthead` (both must succeed; if either fails, `schtasks /Delete /TN Masthead /F` runs before rethrowing). The temp file is removed whatever happens. Returns `Created the scheduled task "Masthead" (runs at logon, no admin rights).` and `It starts Masthead when you log in.`, plus the `setx` note above when it applies. |
| `uninstall` | `schtasks /End /TN Masthead` (not checked), then `schtasks /Delete /TN Masthead /F` (success: `Stopped and deleted the scheduled task "Masthead".`). When `/Delete` fails and `/Query` also fails (the task does not exist, in any display language): `Nothing was installed.` Any other `/Delete` failure throws. |
| `status` | `schtasks /Query /TN Masthead /FO LIST /V`. Non-zero: not installed (`Not installed.`). Otherwise `parseTaskQuery()` reads `Status:` (running when it is `Running`, null when missing) and the port from `--port N` in `Task To Run:` (else 7717). No `dataDir`. Detail: `Task "Masthead" <status>, port <n>`. |
| `serves(port)` | The same query, and the port matches. |

## laststop.ts

Linux, systemd only. Reads the marker the unit's `ExecStopPost=` line writes ([systemd.ts](#systemdts)) so that, after the computer ran out of memory and the service was restarted, the chats it cut off say so.

| Name | What |
|---|---|
| `LAST_STOP_FILE` | `masthead-last-stop`, the marker's name in `$XDG_RUNTIME_DIR` (`laststop.ts:8`). |
| `LastStop` | `result` (systemd's `$SERVICE_RESULT`: `success`, `exit-code`, `signal`, `oom-kill`, `timeout`, …), `code` (`$EXIT_CODE`: `exited`, `killed` or `dumped`), `status` (`$EXIT_STATUS`: a number or a signal name such as `TERM`, `KILL`), `oomKills` (out-of-memory kills in the unit's cgroup during that run; null when it could not be read). |
| `parseLastStop(text)` | Splits the trimmed text on white space into those four fields; missing `code`/`status` become `''`, a fourth word that is not all digits gives `oomKills: null`. Empty text gives null (`laststop.ts:21-26`). |
| `stoppedForMemory(s)` | True when `result` is `oom-kill` (a unit still on the old `OOMPolicy=stop`), or when `result` is `signal`, `status` is `KILL` and `oomKills` > 0: the server itself was killed with SIGKILL while the OOM killer was at work in its cgroup (`laststop.ts:33-35`). |
| `lastStopNotice(s)` | `Masthead was restarted because the computer ran out of memory.` when `stoppedForMemory`, else null (also for null). |
| `takeLastStop(env = process.env)` | Only when `INVOCATION_ID` (set by systemd for a unit's processes) and `XDG_RUNTIME_DIR` are both set: reads `$XDG_RUNTIME_DIR/masthead-last-stop`, removes it (`rmSync`, `force`), and returns `parseLastStop()` of it. No marker or an unreadable one gives null and removes nothing (`laststop.ts:46-57`). So each stop is reported once. |

**How it is used.** `runServer()` in [server/main.ts](Source-Main.md) passes `restartReason: lastStopNotice(takeLastStop())` to `new App(...)` (`main.ts:218`). `App.restartReason()` returns it (`server/app/app.ts:204-208`), and `Conversation.afterRestart()` adds it as an info notice to the lead's transcript, before the usual restart notes, in every conversation whose last activity was within 6 hours (`RESUME_WINDOW_MS`), and in an older one only when the restart cut something off in it (a helper's note, an unanswered message, or a lead cut off mid-turn). Restore runs once per start and the marker is removed when read, so each chat says it once. A conversation idle for longer, with nothing cut off, gets no notice.

## scratch.ts

A private scratch folder per conversation, on disk, given to its agents as their temporary folder. Agents' temp files, downloads and browser profiles then land there instead of `/tmp`, which is often a small RAM-backed tmpfs, and Masthead removes them. The file header gives the reason the cleaning is Masthead's: Claude Code's safety check refuses many `rm -rf` an agent tries on its own temp folders.

| Name | What |
|---|---|
| `SCRATCH_MAX_AGE_DAYS` | `7`. |
| `scratchRoot(platform, env, home, dataDir)` | The folder holding every conversation's scratch. With `MASTHEAD_DATA_DIR` set: `<dataDir>/scratch` (tests and custom set-ups keep everything together). Otherwise the cache folder: macOS `~/Library/Caches/Masthead/scratch`; Windows `%LOCALAPPDATA%\Masthead\Cache\scratch` (`~\AppData\Local` when `LOCALAPPDATA` is unset); Linux and others `$XDG_CACHE_HOME/masthead/scratch`, default `~/.cache/masthead/scratch`. Uses `path.win32` or `path.posix` by platform, so it is testable anywhere. |
| `safeId(id)` (private) | Accepts only `^[A-Za-z0-9_-]{1,128}$`; anything else throws `not a conversation id: "<id>"`, so no id can leave the root (`..`, separators). |
| `scratchDir(root, id, platform?)` | `<root>/<id>` after `safeId`. |
| `ensureScratch(root, id, platform?)` | `mkdirSync(dir, { recursive: true, mode: 0o700 })` and returns the path. The mode applies to folders it creates; an existing folder keeps its mode, and on Windows the mode has no effect. |
| `scratchEnv(dir, platform?)` | `{ TMPDIR, CLAUDE_CODE_TMPDIR }` = `dir`; on Windows also `TMP` and `TEMP`. Claude Code documents `CLAUDE_CODE_TMPDIR` for its own temp files and adds `claude-<uid>` under it. |
| `removeScratch(root, id, platform?)` | `rmSync(dir, { recursive: true, force: true, maxRetries: 3 })`; no error when it is missing. |
| `WALK_MAX_ENTRIES`, `WALK_MAX_DEPTH` | `2000` and `4`: how far `newestChange()` looks. |
| `newestChange(dir, now, platform?)` | The newest modification time in a folder: the folder's own `mtime` and those of its entries, walked breadth-first at most `WALK_MAX_DEPTH` levels down and `WALK_MAX_ENTRIES` entries in all, with `lstat` (symbolic links are not followed). An unreadable folder inside is skipped; an entry gone meanwhile is ignored. Going over the entry limit, or folders left below the last level, returns `now`: the folder counts as changed now and is kept rather than judged on part of its contents. So a huge browser profile cannot stall start-up. A scratch folder that is itself a symbolic link (`lstat` of `dir`) also returns `now`, so it is never judged by what it points to; if its conversation is gone, `removeScratch()` removes only the link. A missing `dir` throws. |
| `sweepScratch(root, { exists, busy?, activeAt?, maxAgeDays?, now? }, platform?)` | Lists `root` (none: returns `[]`). For each name matching the id pattern: skips it when `busy(id)`. When `exists(id)` is false, removes it. For an existing conversation it keeps the folder when `activeAt(id)` (its last activity) is within `maxAgeDays` (default 7) of `now`, or when `newestChange()` of the folder is; otherwise removes it. Returns the ids removed; an error on one folder leaves it for the next start. |

**How it is used** (`server/app/app.ts`):

- `new App()` sets the root: `scratchRoot(process.platform, process.env, HOME, DATA_DIR)` for a real start; tests pass `scratchRoot` themselves, and an `App` given its own store gets none (`app.ts:104`).
- `App.scratchDir(convId)` calls `ensureScratch()`; on failure it logs `Masthead could not make a scratch folder: …` and returns undefined, and the agent uses the system's temporary folder as before (`app.ts:147-157`).
- Each time an agent's session opens, `Agent` asks the host for the folder (`Conversation.scratchDir()` → `App.scratchDir()`) and passes `dirs: [dir]` always, `env: scratchEnv(dir)` only when the backend's `BackendCaps.sessionEnv` is true, and `tmpDir` plus `tmpIsEnv: backend.caps.sessionEnv` for the system prompt (`server/runtime/agent.ts`). `sessionEnv` is true for Claude Code and the fake, false for Codex, whose one app-server is shared by every session and so cannot take a session's environment. The Claude adapter turns `dirs` into `additionalDirectories`, so the agent may use the folder without asking. The Codex adapter records the sandbox the thread reports from `thread/start` or `thread/resume`; while that sandbox is `workspaceWrite`, each `turn/start` sends it with the `dirs` added to `writableRoots`. A read-only thread gets no writable folder. The prompt line: `Your temporary folder is <dir> ($TMPDIR), private to this conversation and on disk: put temporary files, downloads and browser profiles there, not in /tmp. Masthead deletes it with the conversation.`; with `tmpIsEnv` false (Codex) the ` ($TMPDIR)` is left out (`server/core/prompts.ts`). All agents of a conversation share the one folder.
- Deleting a conversation removes its folder (`app.ts:688`).
- `SWEEP_DELAY_MS` (10 s) after start, off the start-up path, `App.sweepScratch()` runs `sweepScratch()` with `exists` = the conversation is loaded, `busy` = the conversation is busy and `activeAt` = its `meta.updatedAt`; failures are only logged.

## usage.ts

Linux, systemd. What the running service uses and what `/tmp` is, for the `Service memory` and `Temporary folder` lines of `masthead doctor` ([server/doctor.ts](Source-Doctor.md)). The unit's cgroup holds every agent's children (browsers, MCP servers, shells), so its memory is the whole team's.

| Name | What |
|---|---|
| `ServiceUsage` | `memoryBytes` (systemd's `MemoryCurrent` for the whole cgroup, null when not accounted), `children` (processes in the cgroup besides the server, null when they cannot be counted). |
| `parseUsageShow(show)` | From `systemctl --user show -p ActiveState -p MemoryCurrent -p ControlGroup` output: null unless `ActiveState=active`; `memoryBytes` when `MemoryCurrent` is all digits (systemd prints `[not set]` otherwise); `cgroup` when `ControlGroup` starts with `/` (`usage.ts:159-165`). |
| `serviceUsage(run, readFile?)` | Runs that `show` for `masthead.service`; a non-zero status or a unit not active gives null. With a cgroup it reads `/sys/fs/cgroup<cgroup>/cgroup.procs` (cgroup v2), counts the lines that are numbers and subtracts one for the server; an unreadable file gives `children: null` (`usage.ts:167-186`). |
| `TmpInfo` | `{ path, fstype, size, free }`, sizes in bytes. |
| `mountType(mounts, path)` | The file system type of the mount holding `path`, from `/proc/mounts` text: the longest mount point that is `/`, equals `path` or is a parent of it wins; `\040` in a mount point is read as a space. Null when none matches (`usage.ts:196-206`). |
| `tmpInfo(path = '/tmp')` | `mountType()` of `/proc/mounts` plus `statfsSync(path)`: `size` = `blocks × bsize`, `free` = `bavail × bsize`, `fstype` `unknown` when no mount matched. Any error gives null. `TMPDIR` is ignored on purpose: the question is what `/tmp` itself is (`usage.ts:209-217`). |

`main.ts` passes `serviceUsage: () => serviceUsage(systemDeps().run)` and `tmp: () => tmpInfo()` to the doctor only on Linux, and `totalMemory: os.totalmem()` on every platform (`main.ts:172-173`).

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
- `status()`: an `AwakeStatus`, `{ state, detail }`, where `state` (`AwakeState`) is `holding`, `unavailable` (with the last error as `detail`) or `off`.
- `new Awake(options?)`: `AwakeOptions` lets tests pass `platform`, `pid`, a `Spawner`, `releaseAfterMs` and their own timers.
- Errors are recorded, not thrown: no command for the platform (`Keeping the computer awake is not supported on <platform>.`), a spawn that throws or emits `error` (`Could not start <cmd>: …`), or the child exiting while still wanted (`<cmd> ended (exit <code>); the computer may sleep while agents work.`, for example no logind or a policy refusal). A failed hold is not retried until work starts again, so a missing tool costs one attempt per busy period. Masthead carries on without it; `masthead doctor` reports whether the tool is on `PATH` ([server/doctor.ts](Source-Doctor.md)).

### How the app uses it

- `runServer()` in [server/main.ts](Source-Main.md) creates `new App({ remote, awake: new Awake() })`. The `awake` option is any object with `set(working)` and `stop()`; tests pass a fake.
- `App.keepAwake()` in `server/app/app.ts` calls `awake.set(settings.keepAwake !== false && workingCount() > 0)`, where `workingCount()` is the number of busy conversations. It runs when a conversation's busy state changes (`agentChanged()`), when a conversation is deleted, and when settings change. So turning the setting off releases the hold after the same 5-second delay, not at once.
- `App.shutdown()` calls `awake.stop()` first.
- The setting `keepAwake` defaults to true, and settings saved before the field existed get true (`server/settings/settings.ts`). The page shows it as "Keep this computer awake while helpers are working" ([Configuration and settings](Configuration-and-Settings.md)).

### The sleep notice

Separately, `server/core/conversation.ts` notices when the computer **did** sleep: an awake-time clock read every 15 seconds sees a gap larger than its step (60 s) and calls `Conversation.wokeFromSleep(from, to)` on every conversation. A conversation that is busy adds an info notice to its lead's transcript: `This computer was asleep from <time> to <time>; work carried on afterwards.` Of each gap the clock counts at most 60 s, so the time asleep does not count as running time ([Agent life cycle](Agent-Life-Cycle.md)).

## Related pages

[Command-line launcher](Command-Line-Launcher.md#service) · [server/main.ts](Source-Main.md) · [server/doctor.ts](Source-Doctor.md) · [server/paths.ts](Source-Paths.md) · [Installing](Source-Install-Scripts.md) · [Configuration and settings](Configuration-and-Settings.md) · [Security model](Security-Model.md) · [Platforms](Platforms.md) · [Tests](Source-Tests.md)
