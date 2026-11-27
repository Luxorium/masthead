# Masthead: working rules

Masthead is a local web app that runs a tiered team of Claude agents through the Claude Code
installed on the machine. Read `README.md` for what it does and `docs/wiki/Home.md` for how the
code works.

## Layout

- `shared/` types and helpers used by both sides. No Node or DOM imports.
- `server/` the Node server: `agent.ts` (one Claude Code session), `conversation.ts` (the team
  rules), `scheduler.ts` (limits), `tools.ts` (what agents can call), `app.ts`, `http.ts`, `main.ts`.
- `web/` the Svelte 5 page. State lives in `web/src/lib/store.svelte.ts`.
- `test/` unit tests (`*.test.ts`) and live end-to-end runs (`*.e2e.*`).
- `scripts/`, `packaging/` installation.

## Rules

- Masthead is a standalone project. Do not tie it to any other project, business or product in
  code, text, names or examples.
- Masthead runs the person's own, unmodified Claude Code and never handles credentials. Do not add
  a login, store tokens or bundle a private copy of Claude Code. Do not use Anthropic's names or
  marks as part of the product's name, icon or styling.
- The tiers are fixed: lead starts Opus, Opus starts Sonnet, Sonnet starts Haiku. Every start,
  message and effort change goes through `Conversation`; agents never get Claude Code's own
  sub-agent or workflow tools.
- There is no `max` effort level. Do not add one.
- The server binds to `127.0.0.1` and checks `Host` and `Origin`. Do not weaken either.
- Text added to an agent's system prompt costs tokens on every request. Keep `prompts.ts` and the
  tool descriptions short.
- Never guess the Agent SDK's API. Read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

## Before you say a change is done

```sh
npm run check && npm test && npm run build
```

For anything that touches agents, messaging, limits or effort, also run `npm run test:live` (it uses
real Claude usage, with Haiku for every tier). For the page, run `test/ui.e2e.mjs` against a test
server started with its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, never against the installed one.
Update `docs/wiki/` when behaviour changes.
