# Tests

Masthead 0.1.3 has eight test files in `test/`: six unit-test files, a live run and a browser test. Only the unit tests run without Claude Code. The other two spend real usage and are run by hand. `AGENTS.md` says when each one is expected.

| File | Command | Tests or checks | Needs | What it covers |
|---|---|---|---|---|
| `test/unit.test.ts` | `npm test` | 14 tests | nothing external | Pure logic: scheduler, settings, tiers, store, prompts, tool wording, names |
| `test/agent.test.ts` | `npm test` | 12 tests | nothing external | One agent's life cycle, with a fake Claude Code process |
| `test/conversation.test.ts` | `npm test` | 27 tests | nothing external | The team rules in `Conversation`, with a fake host |
| `test/app.test.ts` | `npm test` | 13 tests | nothing external | `App.handle` validation, settings, approvals, folders; `agentEnv`; the secret file |
| `test/http.test.ts` | `npm test` | 7 tests | nothing external | The HTTP layer: Host, Origin, secret, shutdown, static files |
| `test/launcher.test.ts` | `npm test` | 4 tests | nothing external | Parsing of the `masthead` command line |
| `test/live.e2e.ts` | `npm run test:live` | 5 scenarios, 15 checks | Claude Code installed and signed in; spends usage | The whole `App` driving real agents |
| `test/ui.e2e.mjs` | `node test/ui.e2e.mjs <url> <screenshot folder>` | 26 checks | A running test server (not on 7717), its secret, Chromium, `playwright-core`; spends usage | The real page in a headless browser |

`npm test` result on 2026-11-26: **77 tests, 77 pass, 0 fail** (14 + 12 + 27 + 13 + 7 + 4).

## Unit tests

All six files run with Node's built-in test runner (`node --test`), with `tsx` loading the TypeScript directly. `npm test` runs every `test/*.test.ts` (`package.json`, script `test`). None starts Claude Code. None writes outside the system temp directory. None uses port 7717.

### `test/unit.test.ts` (14 tests)

Set-up: no fakes needed. It calls `Scheduler`, `sanitizeSettings`, `defaultSettings`, `Store`, the prompt builders, `toolLine()`, `modelLabel()` and the name helpers directly. Store tests use a fresh folder from `mkdtempSync` in the system temp directory.

| Test | What it proves |
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
| store: conversations round-trip and ids cannot escape the data folder | Save, load and delete; `../` ids throw. |
| prompts: each tier is told what it can do | The prompt changes by tier and settings; both envelopes. |
| tool wording: past for the transcript, present… | `toolLine()` in both tenses, MCP and unknown tools. |
| model names: ids read as people say them | `modelLabel()` on known, dated and unknown ids. |
| agent names: handed out in order… | `agentName()` past `zulu`, `displayName()`, 200 unique names. |

### `test/agent.test.ts` (12 tests)

Set-up: a `FakeProcess` class stands in for one Claude Code process. The test decides what it says (`init`, `result`, `tasks` for `background_tasks_changed`, `fail`, `end`), and it records the messages, `applyFlagSettings` calls and `setModel` calls it receives. `fakeHost()` builds an `AgentHost` whose `query` creates a `FakeProcess`, with a real `Scheduler`. `claudePath()` returns `/usr/bin/false`, which never runs. Two tests use Node's mock timers.

| Test | What it proves |
|---|---|
| one ended while waiting for a slot is never launched… | An agent ended while queued is not started, even if the slot was granted first. |
| an ended agent can still be resumed afterwards | Ending it does not prevent a later resume. |
| a follow-up turn does not replace the earlier turn in the outcome | The outcome keeps both turns' text. |
| a turn that names no messages does not clear ones still queued | Queued messages stay queued. |
| with a Claude Code that never names messages, a result still ends the turn | A `result` without `user_message_uuids` ends the turn. |
| a resume whose session is gone starts fresh once and re-sends the message | One fresh start, same message. |
| a resume that fails for another reason is reported, not retried | Other failures reach `processLost`. |
| background work keeps the run open until the turn Claude Code starts by itself | With a background task, the turn's result does not finish the agent; the later `task-notification` turn's text is joined to it; no idle signal. |
| background work that ends with no new turn is reported idle after the grace time | `ambient` tasks do not count; `backgroundIdle` fires after exactly `BACKGROUND_GRACE_MS`. |
| a process that exits with background work running is lost as usual | `processLost` is called; background work is cleared. |
| applySettings caps effort, sets fixed effort and switches the lead model | A lower tier ceiling caps effort through `applyFlagSettings`; the lead's model change goes through `setModel`; an agent without a process is left alone. |
| a change to automatic effort relaunches the process before its next turn, not during one | Mid-turn messages go into the running process; the next turn resumes the session in a new process. |

### `test/conversation.test.ts` (27 tests)

Set-up: `setup()` builds a fake `ConversationHost` with a real `Scheduler` and the default settings. `claudePath()` returns null, so an agent that gets a slot fails at once ("Claude Code was not found"). To keep an agent live (queued), a test first fills its tier with dummy holders (`block`). The host records every item, so tests can count reports, messages and notices. `endTurn()` ends a turn by hand, as `Agent` would after a result.

| Test | What it proves |
|---|---|
| spawn follows the tiers and names agents in order | Lead starts Opus, Opus starts Sonnet; names go alpha, bravo… |
| spawn refuses a tier that is off, and caps the starting effort | Tier off is refused; effort is capped at the tier's ceiling. |
| names resolve case-insensitively, plus "lead" and "parent" | Name lookup. |
| stop works only down the tree and sends no report | An agent cannot stop its parent or a sibling's child. |
| a failed agent reports to its parent; the lead gets it | Failure reports travel up. |
| a child ending without a report moves on a waiting parent (settle) | The parent does not wait forever. |
| stopAll stops everything and settles a waiting lead | `stopAll`. |
| effort changes, approval and ceilings | Self-change, requests to the parent, approval and caps. |
| restore resets agents that were working | Loaded agents are not left "running". |
| regression: switching a tier off fails its queued agents… | They fail and report to the parent. |
| regression: a finished agent woken by a sibling reports to its parent once | No double report. |
| regression: a woken agent whose parent cannot receive owes no report | No report into nowhere. |
| regression: agents cannot wake an agent the person stopped; the person can | The person's stop is respected. |
| regression: envelope bodies cannot close or open an envelope | Message text cannot fake an envelope tag. |
| prompts: real starting effort, a/an, file-relative line numbers | `systemAppend` and `withArticle`. |
| list_agents: activity, time, context and cost in one line | The line format of `conv.list()`; zero context and cost are left out. |
| wait: a question to the parent is not a report; the answer resumes the asker | `wait: true` keeps the asker `waiting`; any message from the recipient ends the wait. |
| wait: an unanswered question gets one reminder, then the asker is told to carry on | One "Reminded" notice, then "No answer from…". |
| wait: an interrupted recipient releases the asker at once | No reminder after an interrupt. |
| wait: a question to the lead is plain to the person, and the asker keeps waiting for it | The person sees a notice; the lead gets one reminder; interrupting the lead releases the asker. |
| wait: stopping everything leaves nobody waiting for the lead | `stopAll` clears `waitingFor`. |
| wait: only toward the parent or the lead; the person can answer directly | Other targets get "Not waiting"; the lead never waits; `userSend` to the asker ends the wait. |
| wait: stopping the asker or its recipient leaves nobody waiting | A stopped asker is not woken. |
| wait: the envelope tells the recipient the sender is waiting | `messageEnvelope(…, 'wait')` and the prompt line. |
| restart: the lead is told which agents were cut off, once… | After `Conversation.restore`, the note is shown, survives another save, is put in front of the person's next message once, and is not repeated. |
| background work: a turn that leaves commands running is not finished | `hasBackgroundWork` keeps an agent (and the lead) `waiting`; `backgroundIdle` finishes it and sends the report. |
| settingsChanged: every agent gets the new settings | `applySettings` is called on each agent. |

### `test/app.test.ts` (13 tests)

Set-up: `setup()` makes a temp folder (`mkdtempSync`, prefix `masthead-app-`), a `Store` in it, a `settingsFile` in it and a `claude` that is not found, so no agent ever starts. It can pre-save conversations. A fake `Client` copies every message with `structuredClone`, as the network would. Approval tests call `app.askPermission` directly with a fake conversation and agent.

| Test | What it proves |
|---|---|
| malformed messages are answered with an error, never thrown | Unknown `t`, bad shapes, a missing conversation. |
| a refused send carries its ref | The `ref` comes back, clipped to 80 characters. |
| images are checked | At most 8; only PNG, JPEG, GIF and WebP; valid base64. |
| a new conversation must start in an existing folder | A missing `cwd` is refused. |
| listing folders leaves out files and hidden folders | `dirs`; a missing folder gives an error. |
| rename tidies the title and ignores an empty one; delete removes the conversation | From memory and from disk. |
| a partial settings update changes only what it names, and is saved | Fields not named are kept; bad values are ignored or clamped; the file on disk equals the sent settings (so `saveSettings` and `writeFileAtomic` run). |
| settings that cannot be saved are applied and logged, not thrown | The settings folder is a file; both updates are applied and the error is logged once. |
| approvals are listed in state, answered once, and "always" passes the suggested rules | `state.pending`; one answer counts; "always" without suggestions is a plain allow. |
| deny, questions and cancelled requests | Deny with a message; question answers; an aborted request leaves the list; Masthead's own tools never reach the person. |
| the latest usage notice of each kind is kept in state | `state.usage`. |
| config: agentEnv strips the enclosing session and keeps credentials | `CLAUDECODE` and `CLAUDE_CODE_*` session variables are removed; `ANTHROPIC_API_KEY` is kept; `CLAUDE_AGENT_SDK_CLIENT_APP` starts `masthead/`. |
| config: the secret is created once, private, and kept | `loadSecret`: 64 hex characters, mode 0600 in a folder closed to others, the same on the second call, replaced if the file holds garbage. |

### `test/http.test.ts` (7 tests)

Set-up: a temp folder with a small `web/` (an `index.html` and `assets/app.js`), a sibling `web2/secret.txt` and an `outside.txt`, used as bait for path escapes. A stand-in `ServedApp` records connections and reports `workingCount() = 2`. `serve()` listens on port 0, so the system picks a free port; the test asserts it is not 7717. The secret is a fixed 64-character string.

| Test | What it proves |
|---|---|
| a request naming another host is refused (DNS rebinding) | Wrong `Host` gets 403. |
| health is open and reports the number of busy conversations | `/api/health` needs no secret and returns `busy: 2`. |
| the socket needs the right Origin | 403 with a wrong or missing `Origin`, a wrong `Host`, or another path. |
| the socket needs the secret | Refused without the `key.<secret>` subprotocol or with a wrong or short key; accepted with it, answering only `masthead` (the key is never echoed); also via `localhost`. |
| shutdown needs POST, the custom header and the secret | `/api/shutdown` needs POST, `x-masthead: 1` and the right `x-masthead-key`. |
| the page and its assets are served to anyone, with the security headers | Security headers, cache rules, 404 for a missing asset, 405 for other methods. |
| paths cannot leave the web folder | Encoded `../`, a sibling folder sharing the root's prefix, malformed escapes and NUL bytes all fail. |

### `test/launcher.test.ts` (4 tests)

Set-up: none. It calls the pure functions in `server/cli.ts`.

| Test | What it proves |
|---|---|
| the port comes from --port, then MASTHEAD_PORT, then the default | `parsePort`: `--port N`, `--port=N`, `MASTHEAD_PORT`, then 7717. |
| a missing or bad port is an error, never a silent fallback | `UsageError` (exit 2). |
| the command is the first word that is not an option or the port | `parseCommand`. |
| only the unit's own port is handled through systemd | `unitPortFrom` on `systemctl show` output: no unit, default 7717, or `MASTHEAD_PORT` in the unit's environment. |

### Not covered by the unit tests

Checked by searching `test/` for each name and reading `server/`:

- `server/tools.ts` (`teamTools`): no test imports it. The tool schemas and how a tool call reaches `Conversation` are tested only by the live run.
- `server/main.ts`: `runServer`, `start`, `open`, `status`, `stop`, `openBrowser`, `secretOrExit`, the `MASTHEAD_DEV` origins and the start-up messages. Only the parsing in `server/cli.ts` is tested.
- `server/config.ts`: `loadSettings` (tests pass `settings` in) and `findClaude` (only the live run calls it). `saveSettings` and `writeFileAtomic` run only indirectly, through the app settings test and `Store`.
- `server/agent.ts`: `describeTool` and `clip`, and the real Agent SDK. `FakeProcess` imitates the messages; it is not Claude Code.
- `server/app.ts`: the `items`, `interrupt`, `stop_agent` and `stop_all` requests, and a successful `send` that starts a conversation (the live run covers `send` and `stop_agent`).
- `server/http.ts`: the 30-second ping that ends a silent socket, the 48 MB socket message limit, the "Malformed message." reply to bad JSON on the socket, and `extraOrigins`.
- `server/conversation.ts`: the 200-agent limit and the 1000-message limit per conversation.
- `web/src/`: no unit tests. Only the browser test drives the page.

## Live end-to-end run (`test/live.e2e.ts`)

The file's opening comment says it runs against the real Claude Code on the machine, spends real usage, and so is not part of `npm test`. It needs Claude Code installed and signed in (it calls `findClaude()`).

Set-up:

- It creates `App` directly (no HTTP, no port) with a fresh temp folder (`masthead-live-…`) for conversations and its own `settingsFile`, so it never touches real settings or data.
- Every tier uses the Haiku model, to keep it cheap. Opus is limited to 2 and Sonnet to 1.
- `permissionMode` is `default`, and the fake client approves every permission request.
- A fake `Client` copies each message (as the network would), records agents and items, and logs progress with timestamps. `until()` waits for a condition, up to 4 minutes by default.

Five scenarios, 15 checks. Each prints PASS or FAIL:

| # | Scenario | Checks |
|---|---|---|
| 1 | **A chain of three tiers.** The lead starts "middle", which starts "leaf"; leaf answers PINEAPPLE. | Three tiers were used; sub-agents end `done`; "PINEAPPLE-OK" reached the person; names are `alpha`, `bravo`, `charlie` in order. |
| 2 | **Messaging and effort.** The lead tells `bravo` (finished) to request medium effort, and approves it. | `bravo` resumed (at least 2 turns) and ended `done`; its effort is `medium`; the lead reported back. |
| 3 | **Limits and stopping.** Opus limit set to 1; the lead starts "first" (`sleep 20`) and "second". "first" is stopped with `{t:'stop_agent'}`. | "second" was `queued`; "first" ended `stopped`; "second" then ran and ended `done`. |
| 4 | **Background work.** "backgrounder" runs `sleep 12` with `run_in_background` and ends its turn. | It is `waiting`, not finished, while the command runs; it reported exactly once, with BG-FINISHED. |
| 5 | **Waiting for an answer.** "asker" sends "Which colour?" to its parent with `wait: true`; the lead answers "teal". | The asker was seen with `waitingFor` = `alpha`; exactly one report, containing `COLOUR=teal` (the question was not taken as a report). |
| – | After scenario 5 | Every agent with turns recorded context and output usage. |

It exits 1 on any failure or time-out and leaves its temp folder behind; the path is printed at the end. Not run for this page (it spends usage).

## Browser test (`test/ui.e2e.mjs`)

It refuses to run against port 7717, the installed app (message, exit code 2). It needs the test server's secret: from `?key=` in the URL, else `MASTHEAD_KEY`, else `$XDG_DATA_HOME/masthead/secret`. Without one it stops with exit code 2. It opens the main page with `?key=` (still accepted); one check opens it with `#key=`, as `masthead` does since 0.1.4. With no arguments it uses `http://127.0.0.1:7799` and the current folder for screenshots.

It drives the real page with **playwright-core**, a library that controls a browser from code, using Chromium (`CHROMIUM` variable, default `/usr/bin/chromium`, run with `--no-sandbox`) in a 1440×900 window. It uses a dark colour scheme unless `SCHEME=light`. It saves numbered screenshots to the folder given, and `failure-<scheme>.png` if it fails. It sends real messages, so the server must use cheap models and have its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME` (`AGENTS.md`). Last run for 0.1.4 against a test server on port 7798: all 33 checks passed in about 26 seconds.

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
XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data node dist/server/main.js stop --port 7798
```

`stop` with the same `XDG_DATA_HOME` reads the same secret and shuts the server down over HTTP. It does not touch the systemd unit, because the port is not 7717 (`server/main.ts`, case `stop`; read from the code, not run). Never use port 7717 or the real `~/.config/masthead` and `~/.local/share/masthead`.

### The 33 checks

Before any agent runs (15 checks):

| Check | What it proves |
|---|---|
| no key shows the sign-in message | In a fresh browser context, no key shows "…to sign this browser in" and no Try again button. |
| a wrong key shows the sign-in message with Try again | `?key=not-the-key` ends with Try again after the refused attempts. |
| Try again connects once the right key is stored | The right key is written to that context's `localStorage` (as another signed-in tab would), and Try again then connects. |
| a key in the fragment works and leaves the address bar | In a fresh context, `#key=<secret>` signs in and no `key=` is left in the URL. |
| the right key works and leaves the address bar | The page loads and `key` is removed from the URL. |
| a wrong key in a link does not sign the browser out | A fresh load of `#key=not-the-key` in the signed-in browser: the candidate is refused, the stored key is used, the page stays signed in and the address is clean. |
| a wrong key pasted into the open tab is taken and refused, and it stays signed in | Setting `location.hash` to a wrong `#key=` (as pasting the address would) is handled by `hashchange`, refused, and the tab stays signed in. |
| new conversation screen renders | The right panel's first heading is "Team". |
| the stepper changes the limit | "More Opus 5.5 agents" changes the value; "Fewer" brings it back. |
| the usage section renders | "No usage reported yet" or at least one limit row. |
| the settings popup opens from the gear | Enter on the focused gear opens the dialog. |
| Escape closes it and focus returns to the gear | Keyboard handling and focus return. |
| "Fold agent reports" persists across a reload | The setting is saved on the server. A click outside then closes the popup (not a separate check). |
| "Longest run for a sub-agent" persists across a reload | 30 minutes chosen in the popup is still chosen after a reload. |
| a refused message is given back to the composer | A 400,001-character message gets the "too long" toast and the text comes back. |

Then one three-branch task is sent: "shell job" (Opus) starts "helper job" (Sonnet) running `sleep 6; echo ready`; "list job" saves a list with the Write tool; "busy one" runs `sleep 8` twelve times in the foreground (18 checks):

| Check | What it proves |
|---|---|
| an approval card names the agent | The first card names the asker, also in its accessible label. |
| the card takes focus | Nobody is typing, so the card gets focus. |
| Allow answers the card | The card goes away. After this, Allow is clicked automatically every half second. |
| the map shows three levels | The "helper job" card sits three levels deep in the map's tree (lead > shell job > helper job). |
| agents are named Alpha, Bravo, Charlie, Delta | Display names. |
| hovering an agent previews its chat | The preview shows the task and real content (a chat line or "Nothing yet."), not "Loading…". |
| the stop button says "Stop" on hover | The ■ on "busy one"'s card shows its label. |
| the map ■ stops the agent | The card reads Stopped. |
| a sub-agent transcript opens with its task | Opening "list job" shows breadcrumbs and its task. |
| the composer names the sub-agent it is pointed at | The line above the box reads "To <Name> · …" and the placeholder says "not Alpha". |
| Back returns the composer to the lead | "Back to Alpha" beside the composer removes that line and the breadcrumbs. |
| reports reached the lead | At least three reports, then a Markdown table after the last one. |
| a report is folded to one line | With the setting on, no body is shown. |
| a folded report opens on click | The body appears. |
| the final answer has a table | Markdown table rendering. |
| the conversation survives a reload | It comes back from disk. |
| the sidebar lists it | The left sidebar has a row. |
| no page errors | No `pageerror` or console error the whole run, except the browser's own log line for each socket the sign-in checks have refused on purpose ("WebSocket connection … 403"). |

### Not covered by the browser test

- A dropped socket giving a message back.
- A server restart while a tab is open (the page should keep reconnecting rather than show the sign-in page); the test does not control the server.
- The "Paused until … · usage limit" words (`pausedUntil`), which need a real usage limit.
- Images in general, including the page's 5 MB per-image and 30 MB total caps (`web/src/lib/Composer.svelte`).
- The composer hint for an agent waiting for an answer (an agent would have to ask on cue).
- Light scheme, unless run again with `SCHEME=light`.
- Dev mode (`MASTHEAD_DEV=1`, port 7718).

## Related pages

[Building, testing and installing](Building-Testing-Installing.md) · [Web components](Source-Web-Components.md) · [Source: App](Source-App.md) · [Source: Http](Source-Http.md)
