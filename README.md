# Masthead

Masthead is an app on your own computer that runs a team of AI helpers for you, in your web browser.
You talk to one main assistant; when the work calls for it, it brings in helpers, using the Claude
Code (or Codex) you have already installed and signed in to.

> **Masthead 0.2.0 is in progress** (branch `next`). These notes describe 0.2.0. Masthead 0.1.4 is
> the current release.

## Screenshots

> **TODO:** take these pictures and save them under `docs/images/`, then remove this note.

- `![New chat](docs/images/new-chat.png)`: a new chat, with "What are we working on?" and the message box.
- `![A chat with helpers](docs/images/chat-with-helpers.png)`: the main assistant working with two helpers.
- `![The team](docs/images/team.png)`: the Team panel showing who is working.
- `![Team panel](docs/images/team-panel.png)`: the Team panel, with helpers under the one that started them.
- `![Permission request](docs/images/permission-request.png)`: a card asking "Allow" or "Deny".
- `![Pictures](docs/images/pictures.png)`: a picture attached to a message.
- `![Settings](docs/images/settings.png)`: the Settings page.
- `![Phone](docs/images/phone.png)`: Masthead on a phone over Tailscale.

## What you need

- A computer running Windows, macOS or Linux.
- [Node.js](https://nodejs.org) 22 or newer.
- [Claude Code](https://code.claude.com/docs/en/setup), installed and signed in with your own account.
  (Or Codex: see [Teams and agent programs](docs/guide/teams-and-agent-programs.md).)
- Git, while Masthead is only available from source.

**Windows has been partly checked on a real machine; macOS not yet.** It is built and tested
automatically on all three systems. On Windows 11 a person has installed it, run agents and the
service at login; keep-awake and some prompts are not checked yet. Until the
[release checklist](docs/plans/0.2.0/release-checklist.md) is done on a real Mac, treat macOS as untested.

## Install

Masthead will be installable with `npm i -g --os=none --cpu=none @luxorium/masthead` **once it is
published**. That package is not published yet and its name may change. Until then, install from
source as below. Full steps with more detail: [docs/guide/installing.md](docs/guide/installing.md).

### Windows

1. Install Node.js 22 or newer and Git.
2. Install Claude Code: open PowerShell and run `irm https://claude.ai/install.ps1 | iex`
   (or `winget install Anthropic.ClaudeCode`).
3. Sign in: run `claude` once and follow the steps, then close it.
4. Install Masthead from source, in PowerShell:
   ```powershell
   git clone https://github.com/Luxorium/masthead
   cd masthead
   git switch next
   npm ci
   npm pack
   npm i -g --os=none --cpu=none .\luxorium-masthead-<version>.tgz
   ```
   (`<version>` is the number in the file name `npm pack` printed.)
5. Run `masthead.cmd`. Your browser opens on Masthead. (In PowerShell use `masthead.cmd`: stock
   PowerShell refuses `masthead.ps1` because running scripts is disabled. Command Prompt takes plain
   `masthead`. Optional permanent fix: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.)
6. Optional: run `masthead.cmd service install` so Masthead starts when you log in.

### macOS

1. Install Node.js 22 or newer (for example `brew install node`) and Git.
2. Install Claude Code, for example `brew install --cask claude-code`
   (other ways: [Claude Code setup](https://code.claude.com/docs/en/setup)).
3. Sign in: run `claude` once in Terminal and follow the steps, then close it.
4. Install Masthead from source, in Terminal:
   ```sh
   git clone https://github.com/Luxorium/masthead
   cd masthead
   git switch next
   npm ci
   npm pack
   npm i -g --os=none --cpu=none ./luxorium-masthead-*.tgz
   ```
5. Run `masthead`. Your browser opens on Masthead.
6. Optional: run `masthead service install` so Masthead starts when you log in.

### Linux

1. Install Node.js 22 or newer and Git from your distribution.
2. Install Claude Code ([setup](https://code.claude.com/docs/en/setup)).
3. Sign in: run `claude` once in a terminal and follow the steps, then close it.
4. Install Masthead from source:
   ```sh
   git clone https://github.com/Luxorium/masthead
   cd masthead
   git switch next
   scripts/install.sh
   ```
   The script installs Masthead for your user only (no root), adds the `masthead` command, a
   launcher entry, and a service that starts Masthead when you log in.
5. Run `masthead`. Your browser opens on Masthead.

If the browser opens but asks you to "Open Masthead with the `masthead` command", run
`masthead --no-browser` in a terminal and open the address it prints. More in
[Troubleshooting](docs/guide/troubleshooting.md).

## Your first chat

1. Run `masthead`.
2. Under the message box, choose the **Folder** to work in. Agents can read and change files in this folder.
3. Type what you want in your own words in the box that says "Ask for anything", and press **Send** (or Enter).
4. Watch the reply. When helpers join, **Team** at the top shows how many are working.
5. If a card asks for permission, choose **Allow** or **Deny**.
6. To stop, press **Stop**.

Closing the browser tab stops nothing: the helpers carry on, and the page catches up when you come
back. Step by step: [Your first chat](docs/guide/first-chat.md).

## Help

- The guide: [docs/guide](docs/guide/README.md).
- Run `masthead doctor` in a terminal: it checks your set-up and says how to fix what is wrong.
- Report a problem: [GitHub issues](https://github.com/Luxorium/masthead/issues).
- Report a security problem privately, as described in [SECURITY.md](SECURITY.md).

## Costs and usage

Masthead itself is free, but every helper uses your own Claude (or Codex) plan or API key exactly as
the program would on its own, and a team uses it much faster than a single chat. Masthead shows your
usage under the chat list and warns you near your limit; fewer helpers at a time and shorter thinking
time keep usage down (see [Helpers and the team](docs/guide/helpers-and-team.md)).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). How the code works is described in [docs/wiki](docs/wiki/Home.md).

## Not affiliated

Masthead is an independent project. It is not affiliated with, made by or endorsed by Anthropic or
OpenAI. Claude and Claude Code are Anthropic's; Codex is OpenAI's.

## Licence

MIT. See [LICENSE](LICENSE).
