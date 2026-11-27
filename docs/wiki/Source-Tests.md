# Tests

Masthead has three kinds of test in `test/`. Only the unit tests run without Claude Code. The other two spend real usage and are run by hand. `AGENTS.md` says when each one is expected.

| File | Command | Needs | What it covers |
|---|---|---|---|
| `test/unit.test.ts` | `npm test` | nothing external | Pure logic: scheduler, settings, tiers, store, prompts, tool wording, names |
| `test/live.e2e.ts` | `npm run test:live` | Claude Code installed and signed in; spends usage | The whole server driving real agents |
| `test/ui.e2e.mjs` | `node test/ui.e2e.mjs <url> <screenshot folder>` | A running test server, Chromium, `playwright-core`; spends usage | The real page in a headless browser |

## Unit tests (`test/unit.test.ts`)

They run with Node's built-in test runner (`node --test`), with `tsx` loading the TypeScript directly. There are 14 tests:

| Test | Checks |
|---|---|
| scheduler: never runs more than the limit… | With limit 2, a third request waits and starts when one is released. |
| scheduler: tiers are limited separately and the lead is never limited | Separate counts per tier; two lead requests both run; a tier at 0 starts nothing. |
| scheduler: a freed slot goes to the parent with the fewest running agents | The fair-queueing order (see [Slot scheduling](Slot-Scheduling.md#example)). |
| scheduler: cancelling… raising the limit starts waiters | `cancel()` rejects with `SlotCancelled`; `limitsChanged()` starts waiters; lowering a limit stops nothing. |
| scheduler: asking twice for the same agent holds one slot | Repeated `acquire` and `release` are safe. |
| settings: defaults are valid and there is no max effort | `sanitizeSettings(defaults)` is unchanged; `EFFORTS` has no `max`. |
| settings: bad values fall back instead of being stored | Bad model, `effort: 'max'`, out-of-range limits, a bad mode, a non-boolean, a relative folder, `null` and a string. |
| tiers: each tier starts only the one below it | `CHILD_TIER` and `capEffort`. |
| store: a transcript keeps order and the last version of each item | The append-only, last-version-wins reading. |
| store: conversations round-trip and ids cannot escape the data folder | Save/load/delete; `../` ids throw. |
| prompts: each tier is told what it can do | The prompt changes by tier and settings; both envelopes. |
| tool wording: past for the transcript, present… | `toolLine()` in both tenses, MCP and unknown tools. |
| model names: ids read as people say them | `modelLabel()` on known, dated and unknown ids. |
| agent names: handed out in order… | `agentName()` around `zulu`, `displayName()`, 200 unique names. |

Store tests use a fresh folder from `mkdtempSync` in the system temp directory, so they never touch real data.

## Live end-to-end run (`test/live.e2e.ts`)

The file's opening comment says it runs against the real Claude Code on the machine, spends real usage, and is therefore not part of `npm test`.

Set-up:

- It creates `App` directly (no HTTP) with a fresh temp folder for conversations and its own `settingsFile`, so it never touches real settings or data.
- Every tier uses the Haiku model, to keep it cheap. Opus is limited to 2 and Sonnet to 1.
- `permissionMode` is `default`, and every permission request is approved automatically.
- A fake `Client` copies each message (as the network would), records agents and items, and logs progress with timestamps.

It runs three scenarios and prints PASS or FAIL for each check:

1. **A chain of three tiers.** The lead starts "middle", which starts "leaf"; leaf answers PINEAPPLE, and the answer must come back up to the person as "PINEAPPLE-OK". It also checks that the three tiers were used, that sub-agents end `done`, and that the names are `alpha`, `bravo` and `charlie` in order.
2. **Messaging and effort.** The lead tells `bravo` (finished) to request medium effort; the lead approves it. It checks that `bravo` resumed (at least 2 turns), ended `done` at `medium`, and that the lead reported back.
3. **Limits and stopping.** With the Opus limit set to 1, the lead starts "first" (which runs `sleep 20`) and "second". It checks that "second" is `queued`. "first" is then stopped through `{t:'stop_agent'}`; it must end `stopped`, and "second" must then run and end `done`. Finally it checks that usage numbers were recorded.

It exits 1 on any failure and leaves its temp folder behind. That folder's path is printed.

## Browser test (`test/ui.e2e.mjs`)

It drives the real page with **playwright-core**, a library that controls a browser from code, using Chromium (`CHROMIUM` variable, default `/usr/bin/chromium`) in a 1440×900 window. It runs in a dark colour scheme unless `SCHEME=light`. It saves numbered screenshots to the folder given. The file's comment says to point it at a test server whose settings use cheap models; `AGENTS.md` adds that the server should be started with its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, never the installed one.

It checks that:

- the new-conversation screen renders, with "Team" in the panel;
- the Opus stepper changes the limit (found by its "More/Fewer Opus 5.5 agents" labels);
- after a two-branch task is sent (with Allow clicked automatically every half second):
  - the agents appear in the panel;
  - the map shows at least four cards named Alpha, Bravo, Charlie and Delta;
  - hovering a card shows its preview, with the task;
  - opening a sub-agent from the map shows breadcrumbs and its task;
  - reports reach the lead, and the final answer contains a Markdown table;
- after a reload, the conversation comes back from disk and the sidebar lists it;
- there were no page errors.

## Related pages

[Building, testing and installing](Building-Testing-Installing.md) · [Web components](Source-Web-Components.md)
