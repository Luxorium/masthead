# Installing Masthead

[Back to the guide](README.md)

Masthead will be installable with one command, `npm i -g --os=none --cpu=none @luxorium/masthead`, once
it is published. **It is not published yet, and the name may change.** Until then, install it from
source with the steps below. They take about five minutes.

> Windows has been partly checked on a real machine; macOS not yet. If something goes wrong
> there, please [report it](https://github.com/Luxorium/masthead/issues).

## What you need on every computer

- **Node.js 22 or newer**, from [nodejs.org](https://nodejs.org) or your package manager.
- **Git**, to download Masthead.
- **Claude Code**, signed in with your own account (or Codex: see
  [Teams and agent programs](teams-and-agent-programs.md)).

## Windows

1. Install Node.js 22 or newer and Git.
2. Open **PowerShell** and install Claude Code with one of:
   - `irm https://claude.ai/install.ps1 | iex`
   - `winget install Anthropic.ClaudeCode`
3. Run `claude` once and follow the steps to sign in. Then close it.
4. Download and install Masthead:
   ```powershell
   git clone https://github.com/Luxorium/masthead
   cd masthead
   git switch next
   npm ci
   npm pack
   npm i -g --os=none --cpu=none .\luxorium-masthead-<version>.tgz
   ```
   Replace `<version>` with the number in the file name that `npm pack` printed.
5. Run `masthead.cmd`. Your browser opens on Masthead, already signed in.
   In PowerShell type `masthead.cmd`, not `masthead`: stock Windows PowerShell refuses npm's
   `masthead.ps1` with "running scripts is disabled on this system". In Command Prompt plain
   `masthead` works. To make plain `masthead` work in PowerShell for good, you may run
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (optional).
6. Optional: to start Masthead each time you log in, run `masthead.cmd service install`.
   This uses the Windows Task Scheduler. Remove it again with `masthead.cmd service uninstall`.

## macOS

1. Install Node.js 22 or newer (for example `brew install node`) and Git.
2. Install Claude Code, for example `brew install --cask claude-code`
   (other ways: [Claude Code setup](https://code.claude.com/docs/en/setup)).
3. Open **Terminal**, run `claude` once and follow the steps to sign in. Then close it.
4. Download and install Masthead:
   ```sh
   git clone https://github.com/Luxorium/masthead
   cd masthead
   git switch next
   npm ci
   npm pack
   npm i -g --os=none --cpu=none ./luxorium-masthead-*.tgz
   ```
5. Run `masthead`. Your browser opens on Masthead, already signed in.
6. Optional: to start Masthead each time you log in, run `masthead service install`.
   Remove it again with `masthead service uninstall`.

## Linux

1. Install Node.js 22 or newer and Git from your distribution.
2. Install Claude Code ([setup](https://code.claude.com/docs/en/setup)).
3. Run `claude` once in a terminal and follow the steps to sign in. Then close it.
4. Download and install Masthead:
   ```sh
   git clone https://github.com/Luxorium/masthead
   cd masthead
   git switch next
   scripts/install.sh
   ```
   This installs Masthead for your user only (no root password needed). It adds the `masthead`
   command, an entry in your app launcher, and a service that starts Masthead when you log in.
5. Run `masthead`. Your browser opens on Masthead, already signed in.

You can also install on Linux the same way as on macOS (`npm pack`, then `npm i -g …`) and add the
service with `masthead service install`.

## Check that it worked

Run `masthead doctor`. Every line should start with `OK` (a `WARN` is fine to read and usually
harmless). If a line says `FAIL`, the line under it says how to fix it. See
[Troubleshooting](troubleshooting.md).

## The commands

| Command | What it does |
|---|---|
| `masthead` | Starts Masthead if needed and opens it in your browser, signed in |
| `masthead status` | Says whether it is running |
| `masthead stop` | Stops it. Helpers that are working are stopped too |
| `masthead service install` | Starts Masthead each time you log in (`uninstall`, `status` too) |
| `masthead doctor` | Checks your set-up and says how to fix what is wrong |
| `masthead --no-browser` | Starts it without opening the browser and prints the address to open |

## Uninstalling

1. If you added the service: `masthead service uninstall`.
2. Installed with `npm`: `npm uninstall -g @luxorium/masthead`.
   Installed with `scripts/install.sh` on Linux: run `scripts/uninstall.sh` from the same folder.
3. Your chats and settings are kept. To remove them too, delete the folders listed in
   [Updating, and where your data is kept](updating-and-your-data.md).
