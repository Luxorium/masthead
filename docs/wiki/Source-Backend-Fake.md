# server/backends/fake/

**Role:** a scripted backend with no CLI behind it. It is for unit tests, the backend conformance suite (`test/backend-conformance.ts`, run on it by `test/fake-backend.test.ts`), the browser test (`test/ui.e2e.mjs`) and CI on machines without any account (`scripts/ci-e2e.mjs`). It is deterministic: what it does follows only from the text of the messages it gets.

| File | Contents |
|---|---|
| `script.ts` | `plan(text, info?)`: the steps a message leads to (`info.hasImage` adds the image reply); the `Step` type |
| `index.ts` | `fakeBackendSelected`, `FAKE_CAPS`, `FAKE_MODELS`, `FakeOptions`, `FAKE_PNG`, `FakeBackend`, `FakeSession`, and a re-export of `plan` and `Step` |

## Selection

`fakeBackendSelected(env)` (`index.ts` line 17) is true only for `MASTHEAD_BACKEND=fake` **and** `MASTHEAD_ALLOW_FAKE=1`.

- `BackendRegistry` refuses to start (throws "MASTHEAD_BACKEND=fake is for tests only and also needs MASTHEAD_ALLOW_FAKE=1.") when only the first is set.
- With both, the registry holds only the fake, and it stands in for every backend id ([Backend interface](Backend-Interface.md#serverbackendsregistryts)). `App` then reports Claude Code as `{ path: null, version: 'fake backend (tests only)' }`.
- `MASTHEAD_FAKE_STEP_MS` sets the pause between steps (registry default 20 ms).
- The page can never choose it: no setting or message selects it.

## The script (`script.ts`, `plan()`)

### Plain phrases

These are also used by the conformance suite, so real backends get the same prompts. Matching ignores case.

| Phrase | Step | What happens |
|---|---|---|
| "Reply with exactly the word X" | `word` | Replies X and stores it as the session's last word. |
| "What word did you reply with before?" | `recall` | Replies the stored word (survives a resume), else "I do not remember any word." |
| "Call the tool NAME with input {json}" | `tool` | Calls that team tool and replies "Tool result: …". Invalid JSON becomes `{ raw }`; an unknown tool gives an error `toolFinished` and "The tool NAME does not exist."; a throwing tool gives "The tool failed: …". |
| "Run the shell command \`cmd\`" | `command` | Asks permission (kind `command`, tool `Bash`, title "Run cmd", `canAlways` = `caps.approvalsAlways`), then "Ran cmd." (with " (always allowed)" for an always), or "Permission denied." |
| "Count slowly …" | `slow` | Waits `slowMs` (default 150 ms), then replies `1` to `5` and `DONE` on separate lines, so messages can arrive during the turn. |
| "Also reply with the word X" | `reply` | Adds X as a reply. Not listed in the file's header comment. |
| "Call compact_team with the finished helpers" | `compact` | The core's tidy message; see [below](#compaction-and-the-tidy-message). |
| (a message with an image part) | `reply` | Adds "I see an image." |
| anything else | `reply` | "Fake reply: <first line, markers removed, at most 120 characters>" or "(empty)". |

### Markers

Written `[[name]]` or `[[name arg]]`, lowercase. Durations need a unit, `<n>ms` or `<n>s`; a bare number is ignored and the default applies (`[[limit 60]]` is the default 60 s, never 60 ms).

| Marker | What happens |
|---|---|
| `[[think]]` / `[[think text]]` | A thinking draft and `thinking()` ("Thinking about it." by default). |
| `[[image]]` | A `Screenshot` tool call whose result carries a 1×1 PNG (`FAKE_PNG`); replies "I took a screenshot." |
| `[[question]]` | A question to the person (`AskUserQuestion`, title "A question for you", "Which colour?" with teal / red); replies `COLOUR=<answer>` (`(no answer)` when none), or "Permission denied." on a deny. A session with `canAskPerson: false` replies "I may not ask the person." without asking. |
| `[[background]]` / `[[background 200ms]]` | Starts a background task (default `backgroundMs`, 50 ms), replies "Started a background task (bg-…).". When it ends: an updated `background()` set, then a turn the backend starts by itself. |
| `[[background-silent]]` | As above, but when it ends only `background()` is sent; no turn follows. |
| `[[limit]]` / `[[limit 60s]]` | `rateLimit({ status: 'rejected', type: 'five_hour', utilization: 1, resetsAt: now in seconds + the duration })` (default 60 s), and the message's steps stop with error "You've hit your usage limit." and `apiError: 'rate_limit'`. |
| `[[error text]]` | The message's steps stop with that error (default "The fake turn failed."). |
| `[[crash]]` | The process "dies": `exited({ failure: 'The fake process crashed.' })`, no `turnEnded`. |

Order of steps for one message: markers in the order written, then compact, tool, command, slow, "also reply", recall, word, image reply. A message whose only steps are `think` markers (or that has none) also gets the fallback reply. Unknown markers are ignored.

## `FakeBackend` (`index.ts`)

- `id = 'fake'`, `label = 'Fake backend'`. `caps` is `FAKE_CAPS` (every flag on; table on [the interface page](Backend-Interface.md#capabilities-per-backend)) merged with `opts.caps`.
- `detect()`: available, `version: 'fake-1'`, `signedIn: true`. `models()`: copies of `FAKE_MODELS` (`fake-large`, all levels, 200,000 context, default; `fake-small`, low to high, 100,000) or `opts.models`.
- Options: `stepMs` (default 0, so unit tests run fast), `slowMs` (150), `backgroundMs` (50).
- `sessions`: every session opened, for tests to inspect.
- `stored`: session id → `{ lastWord }`, standing in for a CLI's session files. `forget(id)` (line 91) deletes one, as if its file were removed.

## `FakeSession` (`index.ts`)

| Behaviour | Detail |
|---|---|
| Start (`boot`, line 133) | In a microtask, from the constructor. A resume of an id not in `stored` → `exited({ failure: 'No session found with id …', sessionMissing: true })` and `ended` settles. Otherwise the old id is reused, or a new `fake-<uuid>` is stored; then `sessionStarted(id)`. |
| `send` (line 151) | Ignored after a crash or close. During a turn, with `midTurnDelivery` the message joins the running turn and is planned when reached; without it, it waits and runs as the next batch. |
| A turn (`turn`, line 241) | `turnStarted()`, the steps of every message in the batch, then (unless interrupted) the joined reply text streamed as `draft` chunks of 40 characters and `draft(null)`, then `text(text, isError)`, `usage({ context: 1000 + turns × 500, output: text length })`, `turnEnded()`. |
| Consumed ids | `null` when `caps.consumedIds` is false; `[]` for a self-started turn; otherwise every message of the batch reached (all of them when interrupted). |
| Background turn (`finishBackground`, line 407) | Waits for any running turn, then runs a self-started turn whose text is "The background task bg-… finished.", then any queued messages. |
| `interrupt()` (line 160) | Marks a running turn interrupted (it stops at the next step and ends with `interrupted: true`, empty text) and **withdraws open approvals** (aborts their signals). |
| `close('graceful')` (line 180) | Drops messages not yet started, lets the running turn finish with its `turnEnded`, then settles `ended`. Idle: settles at once. |
| `close('now')` | Stops at once, withdraws open approvals; the running turn sends no `turnEnded`. |
| After `close()` | No `exited`, ever. |
| `setEffort`, `setModel` | Only record the value (`effort`, `model`). |
| `contextUsage()` | `{ used: 1000 + turns × 500, max }` with `max` from `FAKE_MODELS` (200,000 otherwise). |

## Compaction and the tidy message

`FakeSession.compact()` (caps `compact: true`) refuses while a turn runs, waits one step, calls `compacted()` and resolves; the session keeps its remembered word; `compactions` counts the calls. A message containing "Call compact_team with the finished helpers" (the core's tidy message, see [Compact team](Compact-Team.md)) makes the fake lead call `list_agents`, keep the first helper listed as done ("its findings are still needed") and call `compact_team` with the note "Tidied by the fake lead."

## Points to be aware of

- Written from the code. `test/fake-backend.test.ts` was run on 2026-11-27: 30 passed, 1 skipped ("a message sent during a turn is not lost"), none failed.
- `[[limit]]` and `[[error]]` stop only that message's steps. Other messages in the same batch still run, and the turn ends with the error.
- The text stream does not begin with a `draft({ append: '' })` block start as the Claude adapter's does; it starts with the first chunk.
- `usage.output` counts characters, not tokens, and there is no `costUsd`.
- `contextUsage()` reads `FAKE_MODELS` even when the backend was given other `models`.
- The comment above the fallback reply says markers like `background` "still need a reply", but only `think` is exempted in the code; a background marker replies with its own "Started a background task" text instead.
- A graceful close while a background task is pending ends the session; the task's turn never runs.

## Tests

`test/fake-backend.test.ts` (conformance suite and the fake's own behaviour), `test/registry.test.ts` (selection), `test/agent.test.ts` and `test/send-images.test.ts` use it; `test/ui.e2e.mjs` and `scripts/ci-e2e.mjs` start a server with it.

## Related pages

[Backend interface](Backend-Interface.md) · [Claude Code backend](Source-Backend-Claude.md) · [Building, testing, installing](Building-Testing-Installing.md)
