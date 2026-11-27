# Installing Masthead

[Back to the guide](README.md)

Masthead installs with one command once Node.js and Claude Code are in place. It takes about five
minutes in all. This is the command; the steps below say where to type it:

<!-- The file name is the package name @luxorium/masthead plus the version. For a new version change
the address here, in README.md and in docs/guide/installing.md. -->
```
npm install -g --os=none --cpu=none https://github.com/Luxorium/masthead/releases/download/v0.2.0/luxorium-masthead-0.2.0.tgz
```

It downloads Masthead from its [release page](https://github.com/Luxorium/masthead/releases/tag/v0.2.0).

> Masthead has been checked on Linux and on a real Windows 11 PC. On macOS it is built and tested
> automatically but has not yet been tried by a person on a real Mac. If something goes wrong,
> please [report it](https://github.com/Luxorium/masthead/issues).

## What you need on every computer

- **Node.js 22 or newer**, from [nodejs.org](https://nodejs.org) or your package manager.
- **Claude Code**, signed in with your own account (or Codex: see
  [Teams and agent programs](teams-and-agent-programs.md)).

## Windows

1. Install Node.js 22 or newer from [nodejs.org](https://nodejs.org) (the "LTS" installer).
2. Open **PowerShell** and install Claude Code with one of:
   - `irm https://claude.ai/install.ps1 | iex`
   - `winget install Anthropic.ClaudeCode`
3. Run `claude` once and follow the steps to sign in. Then close it.
4. Install Masthead: paste the install command above into PowerShell and press Enter.
5. Run `masthead.cmd`. Your browser opens on Masthead, already signed in.
   In PowerShell type `masthead.cmd`, not `masthead`: stock Windows PowerShell refuses npm's
   `masthead.ps1` with "running scripts is disabled on this system". In Command Prompt plain
   `masthead` works. To make plain `masthead` work in PowerShell for good, you may run
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (optional).
6. Optional: to start Masthead each time you log in, run `masthead.cmd service install`.
   This uses the Windows Task Scheduler. Remove it again with `masthead.cmd service uninstall`.

## macOS

1. Install Node.js 22 or newer, from [nodejs.org](https://nodejs.org) or with `brew install node`.
2. Install Claude Code, for example `brew install --cask claude-code`
   (other ways: [Claude Code setup](https://code.claude.com/docs/en/setup)).
3. Open **Terminal**, run `claude` once and follow the steps to sign in. Then close it.
4. Install Masthead: paste the install command above into Terminal and press Enter.
5. Run `masthead`. Your browser opens on Masthead, already signed in.
6. Optional: to start Masthead each time you log in, run `masthead service install`.
   Remove it again with `masthead service uninstall`.

## Linux

1. Install Node.js 22 or newer from your distribution (or [nodejs.org](https://nodejs.org)).
2. Install Claude Code ([setup](https://code.claude.com/docs/en/setup)).
3. Run `claude` once in a terminal and follow the steps to sign in. Then close it.
4. Install Masthead: paste the install command above into a terminal and press Enter.
   If npm says it has no permission, your Node.js is installed for the whole system; see
   [npm's guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally),
   or use the script under "Installing from source".
5. Run `masthead`. Your browser opens on Masthead, already signed in.
6. Optional: to start Masthead each time you log in, run `masthead service install`.
   Remove it again with `masthead service uninstall`.

Why `--os=none --cpu=none`: it stops npm from downloading a spare copy of Claude Code that one of
Masthead's parts brings along. Masthead never runs it; it uses the Claude Code you installed.

## Installing from source

If you prefer, install from the source code. You need [Git](https://git-scm.com) as well.

```sh
git clone --branch v0.2.0 https://github.com/Luxorium/masthead
cd masthead
npm ci
npm pack
npm i -g --os=none --cpu=none ./luxorium-masthead-0.2.0.tgz
```

(In PowerShell write the last line with `.\luxorium-masthead-0.2.0.tgz`.) On Linux, instead of the
last two lines you may run `scripts/install.sh`: it installs Masthead for your user only (no root
password needed) and adds the `masthead` command, an entry in your app launcher, and a service that
starts Masthead when you log in. Run again later, it keeps the port of the service you already have
(unless you set `MASTHEAD_PORT`). Remove that install with `scripts/uninstall.sh` from the same folder.

## Check that it worked

Run `masthead doctor`. Every line should start with `[ OK ]` (a `[WARN]` is fine to read and usually
harmless). If a line starts with `[FAIL]`, the line under it, starting `fix:`, says how to fix it. See
[Troubleshooting](troubleshooting.md).

## The commands

On Windows, in PowerShell, write `masthead.cmd` wherever this guide says `masthead`.

| Command | What it does |
|---|---|
| `masthead` | Starts Masthead if needed and opens it in your browser, signed in |
| `masthead status` | Says whether it is running |
| `masthead stop` | Stops it. Helpers that are working are stopped too |
| `masthead service install` | Starts Masthead each time you log in (`uninstall`, `status` too) |
| `masthead doctor` | Checks your set-up and says how to fix what is wrong |
| `masthead --no-browser` | Starts it without opening the browser and prints the address to open |
| `masthead serve` | Runs Masthead in this terminal, to see why it does not start |
| `masthead remote off` | Removes Masthead's entry from Tailscale (turns remote access off) |

## Uninstalling

1. If you added the service: `masthead service uninstall`.
2. Installed with `npm`: `npm uninstall -g @luxorium/masthead`.
   Installed with `scripts/install.sh` on Linux: run `scripts/uninstall.sh` from the same folder.
3. Your chats and settings are kept. To remove them too, delete the folders listed in
   [Updating, and where your data is kept](updating-and-your-data.md).
