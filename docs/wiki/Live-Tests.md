# Live tests

**Role:** how to run the tests that drive the real agent CLIs on this machine, per backend, and what they cost. None of them is part of `npm test` or CI: each needs the CLI installed and signed in, and each spends real usage on the person's account. For everything that runs without an account, see [Tests](Source-Tests.md).

| Backend | Command | What it runs | Cost |
|---|---|---|---|
| Claude Code | `npm run test:live` | `test/live.e2e.ts`: eight scenarios through a real `App` | Real Claude usage; every tier on `claude-haiku-5-5` |
| Codex | `node --import tsx --test test/codex.live.ts` | The backend conformance suite on the real Codex CLI | Real, small Codex usage; `gpt-6-luna` at low effort |
| Claude Code | `node --import tsx test/compact.live.ts` | `Agent.compact()` on a finished agent, through a minimal host | Two short Haiku turns plus one compaction |
| Codex | `node --import tsx test/codex-team.live.ts` | One conversation on the generated Codex team through a real `App` | Real, small Codex usage; every tier `gpt-6-luna` at low effort |
| Codex (and Claude Code) | `node --import tsx test/codex-app.live.ts` | A permission prompt, an image, stop all, and a mixed Claude + Codex team, through a real `App` | Real, small Codex usage (`gpt-6-luna`, low effort) and a little Claude usage (`claude-haiku-5-5`, low effort) |
| Fake | (none needed) | The fake backend runs in `npm test` and in CI's browser test | Nothing: no account, no CLI. See [server/backends/fake/](Source-Backend-Fake.md) |

`AGENTS.md` asks for `npm run test:live` for any change that touches agents, messaging, limits or effort. Never point a live run at the installed app's data: each creates its own temp folder (and, except `compact.live.ts`, its own `App`), with no HTTP server and no port.

## Claude Code: `test/live.e2e.ts`

`npm run test:live` runs `node --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED --import tsx test/live.e2e.ts` (`package.json`). Needs Claude Code found by `findClaude()` and signed in.

**Set-up** (top of the file):

- A fresh folder `masthead-live-…` under the system temp directory (`mkdtempSync`), used as `defaultCwd`, for conversations and for the settings file. It is left behind; the path is printed at the end.
- `defaultSettings()`, then `setTier()` sets **every tier's model to `claude-haiku-5-5`** through the team profiles (the source of truth since 0.2.0) and the old `tiers` view; the second tier (`opus`) may run 2 at once, the third (`sonnet`) 1. `permissionMode` is `default`, and the stand-in client allows every approval request.
- A stand-in `Client` copies each message (as the network would), records agents and items, and logs with timestamps. Each `until()` wait gives up after 4 minutes by default.

**Scenarios** (the `--- n.` log lines), 26 checks in all (25 in the eight scenarios plus the final usage check), each printed as PASS or FAIL:

1. **Chain:** lead → second tier → third tier; reports travel back up (three tiers used, sub-agents `done`, PINEAPPLE-OK reached the person, names `alpha`, `bravo`, `charlie` in order).
2. **Messaging a finished agent resumes it; an effort request goes to its parent** (bravo resumed and finished again, its effort was raised to medium by its parent, the lead reported back).
3. **Limits:** with one slot, two agents run one after the other; stopping the first from the app works.
4. **Background command:** an agent with a background command still running is `waiting`, not finished, and reports once, after the command ends.
5. **`wait: true`:** a question keeps the asker alive until it is answered; the question is not taken as a report.
6. **Settings change, then a resume whose session file is gone** (the file is deleted on purpose): one fresh session, the message answered.
7. **Automatic effort switched back** restarts the process on the same session, with no second fresh start.
8. **`/compact`** ([Compact team](Compact-Team.md)): the lead chooses which finished helpers to keep with `compact_team`; the rest are archived and every kept agent compacts, the lead last, right after the turn that called `compact_team`. Checks: helpers archived, the lead never archived, the summary notice says the lead's memory was compacted ("compacted the memory of 1 that stays", no "Not compacted: alpha"), then a further turn: `send_message` to an archived helper is refused and `read_archive` lists it. Passed on 2026-11-27 (26 checks, about 90 s).

Finally it checks that usage (context and output) was recorded for every agent that ran a turn, logs each agent's usage and cost, and prints `finished all passed` (or `WITH FAILURES`) with the work folder. Exit code 1 on any failure or time-out.

**Cost and time:** real Claude usage at Haiku prices for every agent in all eight scenarios. Not run for this page, so no current timing is given.

## Codex: `test/codex.live.ts`

`node --import tsx --test test/codex.live.ts`. Runs `runConformance('codex (live)', …, { live: true, model, timeoutMs: 240_000 })` from `test/backend-conformance.ts` against a real `CodexBackend`: the same cases as the fake and the scripted Codex server in `npm test` (see [Backend interface](Backend-Interface.md)). In a live run the permission-request case is skipped.

**Cost:** the file header says "real (small) Codex usage": the cheapest model, `MASTHEAD_CODEX_MODEL` (default `gpt-6-luna`), at low effort, a temp folder per session. Threads must be saved for the resume case, so every thread it creates is recorded (from `sessionStarted`) and deleted afterwards with `codex delete --force <id>` (`MASTHEAD_CODEX` names another `codex` binary). It prints how many threads it deleted.

## Codex: `test/codex-team.live.ts`

`node --import tsx test/codex-team.live.ts` (a plain script, not `--test`). A conversation on the **generated Codex team**, through the real `App`, `BackendRegistry` and signed-in Codex CLI:

1. `registry.detectAll()`; checks that Codex is usable and that a Codex team was generated from its model list (at least two tiers).
2. `App` in a temp folder `masthead-codex-team-…`; `backendsDetected()` adds the team; a settings update sets **every tier of the `codex` profile to `MASTHEAD_CODEX_MODEL` (default `gpt-6-luna`) at low effort**, with automatic effort off.
3. Sends a new conversation with `profile: 'codex'` asking the lead to spawn "leaf" (reply PINEAPPLE) and pass its report on; waits up to 240 s.
4. Checks: the leaf ran on the second Codex tier (`codex:1`) and finished; its report reached the lead; the lead passed it on.

Afterwards it shuts the app down, disposes the registry and deletes every thread it created with `codex delete --force`. Exit 1 on failure.

## Codex: `test/codex-app.live.ts`

`node --import tsx test/codex-app.live.ts` (a plain script, not `--test`). Codex through the real `App` and `BackendRegistry`, for what the conformance run cannot show. Set-up: a temp folder `masthead-codex-app-…`; `permissionMode: 'default'`; automatic effort off; every tier of the `codex` profile set to `MASTHEAD_CODEX_MODEL` (default `gpt-6-luna`) at low effort; and a custom profile `mixed` with a Claude Code lead (`claude-haiku-5-5`, low effort) over one Codex tier. Each wait gives up after 180 s by default (240 s for the mixed team, 30 s for stopping). Checks, printed as PASS or FAIL:

1. **Permission prompt:** a request to run `touch denied.txt` raises a permission request; it is denied and the file is not created. A second request (`touch allowed.txt`) is allowed and the file appears.
2. **Image:** a 16×16 red PNG, made in the script, is sent with the message; the answer must say "red".
3. **Stop all** during a long turn (counting to 400): every agent leaves `queued`, `running` and `waiting` within 30 s.
4. **Mixed team** (skipped with a `SKIP` line when Claude Code is not found): the Claude lead starts a Codex helper `leaf`, which reports PINEAPPLE; checks that the helper on tier `mixed:1` finished and that the word reached the lead's reply.

Afterwards it shuts the app down, disposes the registry, deletes every Codex thread it created with `codex delete --force` (`MASTHEAD_CODEX` names another binary), and prints how many it deleted and the work folder. Exit 1 on failure. No result of a run is recorded in the wiki or the plans.

## Claude Code: `test/compact.live.ts`

`node --import tsx test/compact.live.ts`. `Agent.compact()` on the real Claude Code through a minimal host (no `App`): a Haiku agent remembers a word and finishes; `compact()` resumes its session quietly, Claude Code runs `/compact`, the process closes again. Checks: compaction ok, no turn counted, the status stayed done, the "summarized" notice appeared, the slot was given back, and the agent still knew the word afterwards. Temp folder; two short Haiku turns plus one compaction. Passed on 2026-11-27.

## When adding scenarios

Check the settings the run actually uses. Live runs made before the profile fix during 0.2.0 development changed only the old `tiers` view, so agents ran on the profile defaults (Fable, Opus, Sonnet) instead of Haiku. `setTier()` in `live.e2e.ts` now changes the profiles too; set any new tier, limit or model through it (or through the profiles), not through `settings.tiers` alone.

## Related pages

[Tests](Source-Tests.md) · [Backend interface](Backend-Interface.md) · [server/backends/claude/](Source-Backend-Claude.md) · [server/backends/codex/](Source-Backend-Codex.md) · [server/backends/fake/](Source-Backend-Fake.md)
