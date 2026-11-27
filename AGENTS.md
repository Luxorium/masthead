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

- Masthead is a standalone project for anyone to use. Do not tie it to any other project, business
  or product in code, text, names or examples, and do not assume one person's machine or habits:
  where a preference and the general case differ, make it a setting with the general case as default.
- Masthead runs the person's own, unmodified agent CLIs (Claude Code, and from 0.2.0 Codex) and never
  handles their credentials. Do not add a login, store tokens for those services or bundle a private
  copy of a CLI. Do not use Anthropic's or OpenAI's names or marks as part of the product's name, icon
  or styling.
- Every start, message and effort change goes through the team rules in the core; agents never get a
  CLI's own sub-agent or workflow tools. Tiers come from a team profile (0.2.0); within a profile an
  agent may only start the tier directly below it.
- There is no `max` effort level. Do not add one.
- The server listens on loopback (or a private local socket) only and checks `Host` and `Origin`.
  Remote access is only ever through the person's own Tailscale `serve`, off by default, with each
  device approved in the app. Never bind a public or tailnet interface, never use Funnel.
- People's data must survive updates: every on-disk format and the page protocol carry a version, and a
  change needs a migration and a test that loads the previous version's data.
- Text added to an agent's system prompt costs tokens on every request. Keep prompts and tool
  descriptions short.
- Never guess a CLI's or SDK's API. Read its types or documentation, or try it in a throwaway folder.
- The plan for 0.2.0 is `docs/plans/0.2.0/PLAN.md`. Work for it happens on branch `next`.

## Before you say a change is done

```sh
npm run check && npm test && npm run build
```

For anything that touches agents, messaging, limits or effort, also run `npm run test:live` (it uses
real Claude usage, with Haiku for every tier). For the page, run `test/ui.e2e.mjs` against a test
server started with its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, never against the installed one.
Update `docs/wiki/` when behaviour changes.
