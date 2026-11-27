# 0.2.0 release checklist: what only a real machine can show

CI (`.github/workflows/ci.yml`) proves the type check, the unit tests, the web tests, the build and
installing the packed package on Linux, macOS and Windows, plus the browser test on the fake backend.
It has no Claude account, no logged-in desktop and no second device. The checks below need a person at
a real machine. Each is done before 0.2.0 is tagged; write the date, machine and result next to it.

Rules for every check: use a throwaway data folder unless the check says otherwise
(`MASTHEAD_DATA_DIR`, `MASTHEAD_CONFIG_DIR`), and a port other than 7717 unless the check is about the
installed service.

## 1. The browser opens, signed in (macOS and Windows)

1. Install from the packed tarball: `npm pack` in a checkout, then
   `npm i -g --omit=optional ./luxorium-masthead-<version>.tgz`.
2. With Claude Code installed and signed in, run `masthead --port 7790` in a terminal.
3. Expect: the default browser opens on `http://127.0.0.1:7790/`, the page is signed in (no
   "Open Masthead with the masthead command" screen), and the address bar shows no `#key=`.
4. Expect in the terminal: "If the browser did not open signed in, run: masthead --no-browser".
5. Within 60 s the `sign-in-*.html` file is gone from the sign-in folder (macOS: `$TMPDIR/masthead`;
   Windows: `%LOCALAPPDATA%\Masthead\open`).
6. macOS with Safari and with Firefox; Windows with Edge and with Chrome or Firefox as default.

## 2. The service starts at login (macOS and Windows; Linux once more)

1. `masthead service install --port 7791`, then `masthead service status`: installed, running, port 7791.
2. Log out and in again (reboot on Windows). `masthead status --port 7791` says running.
3. macOS: `launchctl print gui/$(id -u)/io.github.luxorium.masthead` shows the job; the log is in
   `~/Library/Logs/Masthead/masthead.log`. Windows: Task Scheduler shows task "Masthead", and **no
   console window** is visible after login.
4. `masthead --port 7791` opens the browser signed in (the service and the launcher share the data folder).
5. `masthead stop --port 7791`: stops it, and it is not restarted at once (clean exit).
6. `masthead service uninstall`: status says not installed; after a new login nothing starts.

## 3. Claude Code is found (Windows, each install method)

On a clean Windows user account, one method at a time, then `masthead doctor`:
1. Native installer (`irm https://claude.ai/install.ps1 | iex`): doctor shows
   `%USERPROFILE%\.local\bin\claude.exe` and a version.
2. winget (`winget install Anthropic.ClaudeCode`): found, with a version.
3. npm (`npm i -g @anthropic-ai/claude-code`): found through `%APPDATA%\npm\claude.cmd`, resolved to the
   real program (not the `.cmd`), with a version.
4. For each: start a conversation and send "say hi"; the lead answers.
Also macOS with Homebrew (`brew install --cask claude-code`) while Masthead runs as a launchd service:
doctor and the page both find it.

## 4. Stopping an agent leaves no processes behind (Windows)

1. Start a conversation; ask the lead: "Run the shell command `ping -t localhost` and wait".
2. When the agent shows it running, press its stop button.
3. Task Manager (Details): no `ping.exe`, and no `bash.exe`/`powershell.exe` child of a stopped
   `claude.exe`. Expected today: they probably remain (see echo's note: `spawnClaudeCodeProcess` with
   `taskkill /T` is planned). Record what you see; if processes remain and the fix has landed, it failed.
4. Repeat with "Stop everything" and with `masthead stop`.

## 5. Remote access over Tailscale

Follow golf's test plan, `docs/plans/0.2.0/remote-test.md` (to be written), on a real tailnet with a
phone and a second computer.

## 6. A real usage limit

Only on an account that can reach a limit (or a low-limit test account):
1. Run a team until Claude Code reports a usage limit.
2. Expect: the agents that hit it show "Paused at the usage limit until <time>", the usage banner shows
   the limit, nothing fails, no report is sent for the paused agents.
3. After the reset time (or within 15 min if none was given), they resume by themselves within 30 s and
   finish their work.
4. Record the exact text Claude Code gave; if it differs from what `usageLimitFor()` recognises, file it.

## 7. Upgrade from an installed 0.1.4 with real data

On a Linux machine that runs 0.1.4 as installed by `scripts/install.sh`, with real conversations:
1. Back up `~/.local/share/masthead` and `~/.config/masthead` (copy both folders).
2. Install 0.2.0 the new way (`npm i -g --omit=optional …`, then `masthead service install`), or with
   `scripts/install.sh` from the 0.2.0 checkout; it must stop the old service cleanly (busy check first).
3. Expect: every conversation and transcript is listed and opens; settings kept (limits, efforts,
   permission mode); the `.bak` files of the migration exist next to the converted files.
4. Continue an old conversation (resume): the lead remembers it.
5. Downgrade path: restore the backup, reinstall 0.1.4; it starts with the old data.

## 8. The secret stays private (Windows)

1. After first start, `icacls "%LOCALAPPDATA%\Masthead\secret"` lists only the current user (no
   inherited entries, no Users/Everyone).
2. From a second, non-admin Windows account: the file cannot be read.

## 9. The computer stays awake while agents work (all three)

Set the power settings so the machine sleeps after 1 to 2 minutes idle, with `keepAwake` on (default).
1. Start a team on a long task (or the fake backend's `[[background 600s]]`) and leave the machine alone.
2. Expect: it does not sleep while any agent is working. Linux: `systemd-inhibit --list` shows
   "Masthead … idle … Agents are working". macOS: `pmset -g assertions` shows `PreventUserIdleSystemSleep`
   by caffeinate. Windows: `powercfg /requests` (admin) lists the PowerShell process under SYSTEM.
3. The screen still turns off on its own schedule; closing the lid or choosing Sleep still sleeps at once.
4. When all agents are idle, the hold is gone within about 5 s (same commands) and the machine sleeps
   on its normal schedule.
5. Switch `keepAwake` off while agents work: the hold is released at once.
6. Kill the server process (`kill -9` / Task Manager): the hold disappears with it.
7. Put the machine to sleep by hand while agents work, wake it after a few minutes: each conversation
   that was working shows "This computer was asleep from HH:MM to HH:MM; work carried on afterwards". (Posted by `Conversation.wokeFromSleep()` when the
   awake-time clock, `activeNow()` in `server/core/conversation.ts`, sees a wall-clock gap over 60 s.)
