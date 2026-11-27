# Project documents: README, AGENTS.md, CLAUDE.md

Three files at the top of the project folder describe Masthead outside this wiki.

## `README.md`

The page for people installing and using Masthead. It covers:

- **What it is:** a lead agent plus up to three tiers of agents (a table: Lead Fable 5.2, Second Opus 5.5, Third Sonnet 5.5, Fourth Haiku 5.5). A panel sets the limits; agents report back, message each other by name, and start at low effort. It runs the installed, signed-in Claude Code and has no login of its own.
- **Requirements:** Linux, Node.js 22 or newer, and Claude Code installed and signed in.
- **Install:** clone the repository, run `scripts/install.sh`, then run `masthead`. It describes the same steps as [Installing](Source-Install-Scripts.md), and the command table from the [Command-line launcher](Command-Line-Launcher.md).
- **Using it:**
  - conversations and the folder picker;
  - the team panel ("At once", "Off");
  - effort ("Effort up to" is the ceiling);
  - the team map (click an agent to read or message it);
  - approval cards;
  - stopping (the square button stops the lead's turn; "Stop everything"; per-agent stop).
- Closing the browser tab stops nothing; stopping Masthead stops the agents.
- **Where things are kept:**
  - the settings and conversation paths ([Storage on disk](Storage-on-Disk.md));
  - Claude Code's own session files in `~/.claude/`, which Masthead resumes by id.
- **Security:** the same points as [Security model](Security-Model.md), including that any program running as the person can reach the server.
- **Usage and limits:** every agent uses the person's Claude plan or API key as Claude Code does. A large team spends usage quickly, and the limits and low default effort are there to keep that in hand.
- **Development:** `npm install`, `check`, `test`, `build`, `start`, `test:live`, and `dev:web` with `MASTHEAD_DEV=1 npm start` beside it. It points to this wiki.
- A closing line that Masthead is an independent project, not made or endorsed by Anthropic.

## `AGENTS.md`

Working rules for AI agents (and people) changing the code. `CLAUDE.md` contains one line pointing to it, so Claude Code reads the same rules.

**Layout:** `shared/` (no Node or DOM imports), `server/` (with one line on each file), `web/` (state in `store.svelte.ts`), `test/`, and `scripts/` with `packaging/`.

**Rules:**

- Masthead is standalone: it must not be tied to any other project, business or product.
- It runs the person's own, unmodified Claude Code and never handles credentials. Do not add a login, store tokens, bundle a private Claude Code, or use Anthropic's names or marks in the product's name, icon or styling.
- The tiers are fixed. Every start, message and effort change goes through `Conversation`, and agents never get Claude Code's own sub-agent or workflow tools.
- There is no `max` effort level, and none may be added.
- The server binds to `127.0.0.1` and checks `Host` and `Origin`; neither may be weakened.
- Keep `prompts.ts` and the tool descriptions short, because they cost tokens on every request.
- Never guess the Agent SDK's API; read its `sdk.d.ts`.

**Before a change is done:**

- Always run `npm run check && npm test && npm run build`.
- Also run `npm run test:live` for anything touching agents, messaging, limits or effort.
- Also run `test/ui.e2e.mjs` against a separate test server for the page.
- Update `docs/wiki/` when behaviour changes.

## `CLAUDE.md`

One line: "See AGENTS.md".

## Related pages

[Home](Home.md) · [Building, testing and installing](Building-Testing-Installing.md) · [Tests](Source-Tests.md)
