# Masthead

Masthead is an app on your own computer that runs a team of AI helpers for you, in your web browser.
You talk to one main assistant; when the work calls for it, it brings in helpers, using the Claude
Code (or Codex) you have already installed and signed in to.

> Masthead is an independent open-source project, not affiliated with, endorsed by or sponsored by
> Anthropic or OpenAI. It runs your own Claude Code or Codex under your own account; their terms and
> your plan's limits apply. Running many agents on a Pro/Max subscription may hit limits or be
> restricted; use an API key if you need certainty. Read the [full notice](docs/guide/accounts-and-terms.md).

## What you need

- A computer running Windows, macOS or Linux.
- [Node.js](https://nodejs.org) 22 or newer.
- [Claude Code](https://code.claude.com/docs/en/setup), installed and signed in with your own account.
  (Or Codex: see [Teams and agent programs](docs/guide/teams-and-agent-programs.md).)

Masthead is built and tested automatically on all three systems, and has been checked by a person on
Linux and on a real Windows 11 PC. **macOS has not yet been checked on a real Mac**: it should work,
and reports of what does not are welcome.

## Install

Once Node.js and Claude Code are in place, Masthead installs from its
[release page](https://github.com/Luxorium/masthead/releases/tag/v0.2.0) with one command, called
"the install command" below:

<!-- The file name is the package name @luxorium/masthead plus the version. For a new version change
the address here, in README.md and in docs/guide/installing.md. -->
```
npm install -g --os=none --cpu=none https://github.com/Luxorium/masthead/releases/download/v0.2.0/luxorium-masthead-0.2.0.tgz
```

Full steps with more detail: [docs/guide/installing.md](docs/guide/installing.md).

### Windows

1. Install [Node.js](https://nodejs.org) 22 or newer.
2. Install Claude Code: open PowerShell and run `irm https://claude.ai/install.ps1 | iex`
   (or `winget install Anthropic.ClaudeCode`).
3. Sign in: run `claude` once and follow the steps, then close it.
4. Paste the install command into PowerShell and press Enter.
5. Run `masthead.cmd`. Your browser opens on Masthead. (In PowerShell use `masthead.cmd`: stock
   PowerShell refuses `masthead.ps1` because running scripts is disabled. Command Prompt takes plain
   `masthead`.)
6. Optional: run `masthead.cmd service install` so Masthead starts when you log in.

### macOS

1. Install Node.js 22 or newer (for example `brew install node`).
2. Install Claude Code, for example `brew install --cask claude-code`
   (other ways: [Claude Code setup](https://code.claude.com/docs/en/setup)).
3. Sign in: run `claude` once in Terminal and follow the steps, then close it.
4. Paste the install command into Terminal and press Enter.
5. Run `masthead`. Your browser opens on Masthead.
6. Optional: run `masthead service install` so Masthead starts when you log in.

### Linux

1. Install Node.js 22 or newer from your distribution.
2. Install Claude Code ([setup](https://code.claude.com/docs/en/setup)).
3. Sign in: run `claude` once in a terminal and follow the steps, then close it.
4. Paste the install command into a terminal and press Enter.
5. Run `masthead`. Your browser opens on Masthead.
6. Optional: run `masthead service install` so Masthead starts when you log in.

To install from source instead (or with `scripts/install.sh` on Linux), see
[Installing from source](docs/guide/installing.md#installing-from-source).

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

## Notice

Masthead is an independent open-source project, not affiliated with, endorsed by or sponsored by
Anthropic or OpenAI. "Claude", "Claude Code", "OpenAI", "Codex" and "ChatGPT" are trademarks of their
owners, used only to describe compatibility. The full notice, and how to use an API key instead of a
plan: [Your account, API keys and the terms](docs/guide/accounts-and-terms.md).

## Licence

MIT. See [LICENSE](LICENSE).
