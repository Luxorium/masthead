# Tests

Masthead 0.1.2 has three kinds of test in `test/`: six unit-test files, a live run and a browser test. Only the unit tests run without Claude Code. The other two spend real usage and are run by hand. `AGENTS.md` says when each one is expected.

| File | Command | Needs | What it covers |
|---|---|---|---|
| `test/unit.test.ts` | `npm test` | nothing external | Pure logic: scheduler, settings, tiers, store, prompts, tool wording, names |
| `test/agent.test.ts` | `npm test` | nothing external | One agent's life cycle, with a fake Claude Code process |
| `test/conversation.test.ts` | `npm test` | nothing external | The team rules in `Conversation`, with a fake host |
| `test/app.test.ts` | `npm test` | nothing external | `App.handle` validation, settings, approvals, folders; `agentEnv`; the secret file |
| `test/http.test.ts` | `npm test` | nothing external | The HTTP layer: Host, Origin, secret, shutdown, static files |
| `test/launcher.test.ts` | `npm test` | nothing external | Parsing of the `masthead` command line |
| `test/live.e2e.ts` | `npm run test:live` | Claude Code installed and signed in; spends usage | The whole server driving real agents |
| `test/ui.e2e.mjs` | `node test/ui.e2e.mjs <url> <screenshot folder>` | A running test server, Chromium, `playwright-core`; spends usage | The real page in a headless browser |

## Unit tests

All six files run with Node's built-in test runner (`node --test`), with `tsx` loading the TypeScript directly; `npm test` runs every `test/*.test.ts`. None starts Claude Code, and none writes outside the system temp directory.

### `test/unit.test.ts`

There are 14 tests:

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

### `test/agent.test.ts`

Seven tests of `Agent`, using a `FakeProcess` in place of a Claude Code process; the test decides what it says. They cover: an agent ended while waiting for a slot is never launched, even if the slot was granted first, and can still be resumed later; a follow-up turn does not replace the earlier turn's text in the outcome; a turn that names no messages does not clear ones still queued; a Claude Code that never names messages still ends the turn; a resume whose session is gone starts fresh once and re-sends the message, while a resume failing for another reason is reported, not retried.

### `test/conversation.test.ts`

Fifteen tests of `Conversation` with a fake `ConversationHost` and a real `Scheduler`. `claudePath()` returns null, so an agent that gets a slot fails at once; to keep one live (queued), a test first fills its tier with a dummy holder. They cover: spawning follows the tiers and names agents in order; a tier that is off is refused and the starting effort is capped; names resolve case-insensitively, plus "lead" and "parent"; stop works only down the tree and sends no report; a failed agent reports to its parent; settling a waiting parent; `stopAll`; effort changes, approval and ceilings; `restore` resets agents that were working; and regressions: a tier switched off fails its queued agents, a finished agent woken by a sibling reports to its parent once, a woken agent whose parent cannot receive owes no report, agents cannot wake one the person stopped, envelope bodies cannot close or open an envelope. One test checks the prompt's real starting effort, "a/an" and the request for file-relative line numbers.

### `test/app.test.ts`

Thirteen tests. `App` gets a temp `Store`, its own `settingsFile` and no Claude Code, so no agent starts. They cover:

- malformed messages, unknown requests and missing conversations are answered with `error`, never thrown;
- a refused `send` carries its `ref` (clipped to 80 characters);
- images: at most 8, only PNG, JPEG, GIF and WebP, valid base64;
- a new conversation must start in an existing folder;
- the folder listing leaves out files and hidden folders, and reports an error for a missing one;
- rename tidies the title (and ignores an empty one); delete removes the conversation from memory and disk;
- a partial settings update changes only the fields it names (including `collapseReports`) and is saved; bad values are ignored;
- settings that cannot be saved are still applied, and the failure is logged once;
- approvals: every open request is listed in `state.pending`, an answer counts once, "always" passes the suggested rules (a plain allow without them), deny with a message, question answers, cancellation, and Masthead's own tools never reach the person;
- the latest usage notice of each kind is kept in `state.usage`;
- `agentEnv()` strips the enclosing Claude Code session's variables and keeps credentials;
- the secret file is created once, mode 0600 in a 0700 folder, kept across calls, and replaced if it is unusable.

### `test/http.test.ts`

Seven tests against `serve()` on a free port picked by the system (never 7717), with a temp web folder and a stand-in app:

- a wrong `Host` gets 403 (DNS rebinding);
- `/api/health` is open and reports `busy`;
- the socket is refused (403) with a wrong or missing `Origin`, a wrong `Host` or another path;
- the socket is refused without the `key.<secret>` subprotocol, or with a wrong or short key, and accepted with it, answering only `masthead` (the key is never echoed), also via `localhost`;
- `/api/shutdown` needs POST, `x-masthead: 1` and the right `x-masthead-key`;
- the page and its assets are served to anyone, with the security headers, cache rules, 404 for a missing asset and 405 for other methods;
- encoded `../`, a sibling folder sharing the root's prefix, malformed escapes and NUL bytes cannot read outside the web folder.

### `test/launcher.test.ts`

Four tests of `server/cli.ts`: the port comes from `--port N`, `--port=N`, `MASTHEAD_PORT`, then the default; a missing or bad port is an error (`UsageError`, exit 2), never a silent fallback; how the command word is found; and how the installed unit's port is read from `systemctl show` output (no unit, default 7717, or `MASTHEAD_PORT` in its environment), which decides when the launcher goes through systemd.

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

It refuses to run against port 7717, the installed app (message, exit code 2). It needs the test server's secret: from `?key=` in the URL, else `MASTHEAD_KEY`, else `$XDG_DATA_HOME/masthead/secret`; without one it stops. It opens the page with `?key=`, as `masthead` does. How to start such a server: [Building, testing and installing](Building-Testing-Installing.md#a-test-server-with-its-own-folders).

It drives the real page with **playwright-core**, a library that controls a browser from code, using Chromium (`CHROMIUM` variable, default `/usr/bin/chromium`) in a 1440×900 window. It runs in a dark colour scheme unless `SCHEME=light`. It saves numbered screenshots to the folder given. The file's comment says to point it at a test server whose settings use cheap models; `AGENTS.md` adds that the server should be started with its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, never the installed one.

### Running it

The server's settings must make a Write ask for approval (`permissionMode: "default"`) and allow three Opus agents at once. Every tier on Haiku keeps it cheap. One way, from the project folder:

```sh
npm run build
T=$(mktemp -d); mkdir -p $T/config/masthead $T/work $T/shots
cat > $T/config/masthead/settings.json <<JSON
{"tiers":{"lead":{"model":"claude-haiku-5-5","effort":"low","max":1},
 "opus":{"model":"claude-haiku-5-5","effort":"low","max":3},
 "sonnet":{"model":"claude-haiku-5-5","effort":"low","max":2},
 "haiku":{"model":"claude-haiku-5-5","effort":"low","max":2}},
 "permissionMode":"default","defaultCwd":"$T/work"}
JSON
XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data node --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED dist/server/main.js serve --port 7798 &
XDG_DATA_HOME=$T/data node test/ui.e2e.mjs http://127.0.0.1:7798 $T/shots
kill $(curl -s http://127.0.0.1:7798/api/health | python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
```

A full run takes about half a minute. Never use port 7717 or the real `~/.config/masthead` and `~/.local/share/masthead`.

### What it checks

Before any agent runs:

- **Sign-in**, each in a fresh browser context: with no key the page shows "…to sign this browser in" and no Try again button; with a wrong key (`?key=not-the-key`) it shows the same message with **Try again** after three refused attempts; with the right key the page loads and `key` is gone from the address bar.
- The new-conversation screen renders, with "Team" in the panel.
- The Opus stepper changes the limit: "More Opus 5.5 agents" changes the shown value and "Fewer" brings it back.
- The **Usage** section renders: either "No usage reported yet" or at least one limit row.
- **Settings popup:** Enter on the gear opens it; Escape closes it and focus returns to the gear. "Fold agent reports" is switched on and is still on after a reload. A click outside closes the popup.
- **Composer restore:** a message of 400,001 characters is refused by the server ("too long"), and the text comes back into the box.

Then one three-branch task is sent: a "shell job" Opus agent that starts a "helper job" Sonnet agent running `sleep 6; echo ready`; a "list job" that saves a list with the Write tool; and a "busy one" that runs `sleep 8` twelve times in the foreground. The test then checks that:

- **Approval card:** the first card (the Write) names the asking agent, also in its accessible label; it takes focus, since nobody is typing; Allow removes it. After that, Allow is clicked automatically every half second.
- The map shows at least four cards named Alpha, Bravo, Charlie and Delta, and hovering a card shows its preview with the task.
- **Stop:** hovering the ■ on "busy one"'s map card shows the word "Stop", and pressing it makes the card read Stopped.
- Opening a sub-agent from the map shows breadcrumbs and its task.
- All three reports reach the lead, and a Markdown table is written after the last of them (interim tables do not count).
- **Folded reports:** with the setting on, a report shows as one line (no body) and opens on click.
- After a reload, the conversation comes back from disk and the sidebar lists it.
- There were no page errors.

Not tested: Try again actually reconnecting, a socket drop giving a message back, the 30 MB image cap, and the composer hint for an agent waiting for an answer (that needs an agent to ask its parent a question on cue).

## Related pages

[Building, testing and installing](Building-Testing-Installing.md) · [Web components](Source-Web-Components.md)
