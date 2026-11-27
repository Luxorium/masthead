# Tests

**Role:** what each test file in `test/` and `web/test/` covers and how it runs, for version 0.2.0. Three kinds:

- **Server tests** (`test/*.test.ts`), run by `npm test`. No real agent CLI, no account, no network; files go to a per-run temporary folder that `scripts/run-tests.mjs` removes afterwards; nothing uses port 7717.
- **Page tests** (`web/test/*.test.ts`), run by `npm run test:web`. Svelte components and the page store in a simulated DOM.
- **Live and browser runs** (`test/live.e2e.ts`, `test/compact.live.ts`, `test/settings.live.ts`, `test/restart.live.ts`, `test/codex.live.ts`, `test/codex-team.live.ts`, `test/codex-app.live.ts`, `test/ui.e2e.mjs`, `web/test/team-shots.mjs`), run by hand (`test/ui.e2e.mjs` also in CI). The live ones spend real usage; see [Live tests](Live-Tests.md).

`AGENTS.md` says which are expected before a change is called done: `npm run check && npm test && npm run test:web && npm run build` always; `npm run test:live` for anything touching agents, messaging, limits or effort; `node scripts/ci-e2e.mjs` (the browser test on the fake backend) for the page.

## Commands

| Command | What it runs (`package.json`) |
|---|---|
| `npm test` | `node scripts/run-tests.mjs`, which runs `node --import tsx --test test/*.test.ts` (or the files given) with its own temporary folder (see [Test runner](#test-runner-scriptsrun-testsmjs)): Node's built-in test runner, with `tsx` loading TypeScript directly. Only files ending in `.test.ts`, so `backend-conformance.ts` and the `*.live.ts` / `*.e2e.*` files are not picked up. |
| `npm run test:web` | `node scripts/run-tests.mjs -- vitest run --config web/vitest.config.ts`, the same temporary-folder rules around Vitest with root `web/`, files `test/**/*.test.ts`, environment `happy-dom` (some files switch to `jsdom`), set-up file `test/setup.ts`. |
| `npm run test:live` | `node --disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED --import tsx test/live.e2e.ts` |

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check`, `npm test`, `npm run test:web` and `npm run build` on Linux, macOS and Windows, and separately a browser job per system that builds and runs `node scripts/ci-e2e.mjs e2e-shots` (the browser test on the fake backend).

## Results on 2026-11-27 (branch `next`, working tree)

Each server test file was run on its own with Node 26.13.1 (`node --import tsx --test <file>`), and the web tests with `npx vitest run --config web/vitest.config.ts`.

- `npm test` files: **490 tests, 489 pass, 0 fail, 1 skipped** (`npm test` on the 0.2.1-beta.1 working tree, 2026-11-27; some per-file rows below are from earlier runs), in 3 suites (the conformance suites). The skipped one is the conformance case "a message sent during a turn is not lost" in the suite "fake without mid-turn delivery or consumed ids", skipped on purpose because that variant has no mid-turn delivery.
- `npm run test:web`: **21 files, 108 tests, 108 pass** (run again after the 0.2.1 page changes, which added `progress.test.ts`; the page-test rows below are from the earlier 93-test run).

The per-file counts below come from those runs and add up to the totals. Other work was adding tests at the time, so expect the numbers to grow.

## Test runner (`scripts/run-tests.mjs`)

`npm test` and `npm run test:web` run through this plain Node script so no run leaves files in the system temporary folder.

- It makes one folder per run, `mh-XXXXXX` in the system temporary folder (short, so Unix socket paths under it fit macOS's 104-byte limit), and gives the child `TMPDIR`, `TEMP` and `TMP` pointing at it. Every `os.tmpdir()`/`mkdtemp` folder a test makes lands inside it.
- `node scripts/run-tests.mjs` runs `node --import tsx --test test/*.test.ts` (Node expands the glob, no shell); with arguments, those test files instead; `node scripts/run-tests.mjs -- <command> [args]` runs any command (how `test:web` runs Vitest; on Windows non-node commands go through a shell for npm's `.cmd` shims). Nothing after `--`: exit 2.
- It removes the folder when the child exits, passes or fails, and after SIGINT, SIGTERM or SIGHUP (SIGTERM and SIGHUP are passed on to the child; exit 130 after a signal), with retries for Windows file locks. A failed removal is only printed. `MASTHEAD_KEEP_TMP=1` keeps the folder and prints its path.
- `test/backend-conformance.ts` also removes the session folders it makes (`masthead-conf-…`) when the test file ends, so live conformance runs outside the runner clean up too.

### Work folders of live and browser runs (`test/workdir.ts`)

`finishWorkFolder(dir, failed, log?)`: when everything passed it removes the folder (retries; a failure is only logged); when something failed it keeps it and logs "work folder kept for a look: <dir>". Used by `test/live.e2e.ts`, `test/compact.live.ts`, `test/settings.live.ts`, `test/restart.live.ts`, `test/codex-team.live.ts` and `test/codex-app.live.ts`.

## Server tests (`npm test`)

| File | Tests | What it covers |
|---|---|---|
| `test/unit.test.ts` | 14 | Pure helpers: the scheduler (limit kept, tiers separate, lead unlimited, fair order by parent, cancel and raised limit, same agent asking twice), 0.1.x-style settings validation (no `max` effort), tier order, the store's transcript and conversation files, tier prompts, tool wording (`toolLine`), model labels, agent names past `zulu`. |
| `test/agent.test.ts` | 38 | The runtime `Agent` (`server/runtime/agent.ts`). Through the Claude adapter with a fake SDK `query()`: ended while queued never launches, resume after end, turns joined into one outcome, unnamed results, a missing session starts fresh once, background work keeps the run open, `applySettings` and effort relaunches, context size read at turn end, usage-limit handling (report at once, close the process, hold unconsumed messages), long-run text trimming. One test checks the Claude adapter's approval translation (Masthead tools allowed without asking). Then "runtime on fake": the same behaviours on the fake backend, plus tool-result images stored as blobs, a self-started turn, a backend without background tracking, a lead on a non-Claude profile (tier `codex:0`), and a team tool reported under its bare name (as Codex does) shown like Claude Code's `mcp__masthead__…`, and `compact()` (on a finished agent, refused mid-turn, nothing to do, a backend without compaction). |
| `test/conversation.test.ts` | 62 | The team rules in `Conversation` (`server/core/conversation.ts`) with a fake host: spawn by tier and naming, refusals and effort caps, name lookup, stop only down the tree, reports and settling, stop all, effort requests, restore, regressions (tier off, sibling wake, stop marks, envelope escaping), `wait`, restart notes, background work, settings changes, usage-limit pauses, run-time limit, sleep, shutdown through the machine, a random-activity invariant test, and Compact team (`/compact`, `propose_compact` and the card, archiving and restoring helpers, automatic tidying past 15 finished helpers, a restart midway). |
| `test/restart.test.ts` | 14 | 0.2.1 restarts, reports and person messages (R1–R5, from real chats; each test first reproduced the problem): a result naming no message from a Claude Code that names them (`interrupt_receipt_v1`) answers nothing; an agent woken while its old process still finishes a turn shows `queued` and that turn's text stays out of the new report; the run text starts at the last full answer; after a restart the lead gets a turn of its own naming cut-off helpers, their parent and task, and such helpers are kept, not archived as finished; the person's unanswered last message is resent once with a notice; a cut-off lead (crash or clean stop) is asked to carry on once and saved at once; `SENT_WHILE_ANSWERING` only when the busy turn answers the person; the parent told once that a report waits on a background command, and again after a new wake; `activitySince`/`lastOutputAt`; the stall rule (`Agent.unansweredGraceMs` shortened); after an out-of-memory restart every chat active in the last 6 hours says why once, even with nothing cut off, and older chats do not. Uses the fake backend and the Claude adapter with a stand-in process. See [Restarting the app](Walkthrough-Restarting-the-App.md#the-leads-turn-after-a-restart). |
| `test/review-restart.test.ts` | 1 | A review of the R2/R3 changes (failing tests here would be findings, not fixes): a long text from the turn a finished background command starts does not drop the report written before it. Claude adapter with a stand-in process. |
| `test/machine.test.ts` | 31 | The state machine (`server/core/machine.ts`): the rows of the transition table (rows 1–27, some rows grouped in one test), plus invariants (no sub-agent waits with nothing holding it, ended agents hold nothing, `step` is pure), fixes, and archiving (only a finished helper, never the lead). Pure: no process, timer or disk. See [State machine](State-Machine.md). |
| `test/app.test.ts` | 15 | `App.handle`: malformed messages answered not thrown, a refused send keeps its `ref`, image checks, new-conversation folder, folder listing, rename/delete, partial settings updates, approvals (once, "always", deny, questions, cancelled), usage notices; `agentEnv`, the secret file, Windows `~\` and drive roots, `maxRunMinutes`. |
| `test/characterisation.test.ts` | 6 | Pins 0.1.4 behaviour for the 0.2.0 refactors: 0.1.x settings and conversations load as before, a 0.1.x transcript reads back (last line per id, torn line skipped), v1 message shapes, a send without Claude Code refused with its `ref`, and a replay of lead → Opus → report through a fake Claude Code. Uses `test/fixtures/v0.1`. |
| `test/protocol-v1.test.ts` | 1 | What a version 1 (0.1.x) tab receives from `App`: no v2 fields leak in. |
| `test/protocol-v2.test.ts` | 17 | Protocol 2 in the hub (`server/app/clients.ts`): hello and version, subscriptions, `seq` and resync from the ring, draft deltas and `draft_sync`, clipped tool fields and `item_full`, error codes, the role gate, draft endings, scheduler limits from the profile, backends in state, `reset_profile`, and review fixes (remote tab before hello, seq from another start, ring byte cap, v1 hello from a device). |
| `test/backpressure.test.ts` | 1 | `attach()` in `server/transport/http.ts`: draft messages dropped past 4 MiB buffered, socket closed past 32 MiB. |
| `test/compact-app.test.ts` | 5 | The server side of Compact team in `App`: `/compact` to the main assistant starts it (anything else is chat), answer/cancel/restore reach the conversation, archived transcripts only for archived agents, the state broadcast on every change, device roles (approve may answer, read may only view), the per-conversation automatic switch. |
| `test/http.test.ts` | 10 | The HTTP layer: Host check (DNS rebinding), `/api/health`, socket Origin and secret, shutdown (POST, header, secret), the HMAC proof, an unparsable request line, static files and security headers, `extraOrigins`, path escapes. Free ports only. |
| `test/send-images.test.ts` | 3 | Pictures in a send: uploaded refs checked against the conversation reach the item and the backend; a first message's inline pictures become refs; one 30 MB cap for uploaded and inline together. The big pictures are small PNGs lengthened with `truncateSync` (sparse files where the file system allows), so the cap, which reads file sizes, is tested without writing 30 MB. |
| `test/storage.test.ts` | 13 | Storage format 2: image type and size from bytes, the blob store (hash, 0600, refused files, path tricks, garbage collection), migration of the 0.1 fixtures and format 1, paged transcript reads, `readItems`, the blob HTTP routes, atomic renames on Windows, the format marker (raised to 2, never lowered from a newer one). |
| `test/storage-wiring.test.ts` | 2 | Storage in `App`: paged `items`, `storeImage` and collection of unreferenced images on load. |
| `test/settings.test.ts` | 16 | Settings v2 and team profiles: defaults, migration of a 0.1.x file (backup first), validation, old-shape patches, absolute default folder, tier lookups, conversations on a chosen profile, generated built-in profiles, descriptions, `keepAwake`, resetting a built-in profile, and data safety (going back to 0.1.4 and returning keeps the teams, an invalid program name kept and marked unusable, a chat keeps its copy of a deleted team). |
| `test/prompts.test.ts` | 11 | Prompts and team tools per capability set: no backend or model name in shared text, lines follow capabilities, tool names as the backend shows them, the appended text within its budget, the lead batching updates and pictures explained, light (lean) levels named from the profile, the effort line (reset, announced, not to ask for the same level), the scratch folder line only with a folder and without `$TMPDIR` when `tmpIsEnv` is false; `teamToolDefs` (spawn only with a child tier, effort tools only with levels), `compact_team` taking plain names or `{name, why}`, `spawn_agent` warning about a light level below, `read_archive` on any finished helper. |
| `test/registry.test.ts` | 5 | `server/backends/registry.ts`: the generated Codex team, the fake needing its allow flag, detection, and a conversation on the generated Codex team end to end on the fake app-server. |
| `test/fake-backend.test.ts` | 31 (1 skipped) | The fake backend (`server/backends/fake/`): tests of its scripts (selection, thinking, images, questions, background work, usage limit, errors, crash, deleted session, no mid-turn delivery, `close`), one that runs an `App` team on it with no account, and the conformance suite twice (normal, and without mid-turn delivery or consumed ids: one case skipped). See [server/backends/fake/](Source-Backend-Fake.md). |
| `test/codex.test.ts` | 45 | The Codex adapter against a scripted app-server (`server/backends/codex/testing/fake-app-server.ts`): CLI helpers, detection, models, `thread/start` contents, turns, steering, text and deltas, usage, rate limits, team tools, MCP/shell/file items, approvals, questions, images, resume, interrupt, a dying app-server, Codex's own sub-agents stopped, compaction, caps, a permission-mode change keeping the thread's own sandbox with the scratch folder as a writable root, a full-access thread needing a relaunch to step back, and the sandbox after a resume (the wanted one carried on every turn when the thread reports another, the `inherit` probe cached, fail-closed when it cannot be known); plus the conformance suite. No Codex CLI needed. |
| `test/codex-proctree.test.ts` | 2 | The Codex app-server started as a process tree and stopped as one (POSIX group, Windows `taskkill`). |
| `test/proctree.test.ts` | 4 | `server/backends/proctree.ts`: own process group, SIGTERM then SIGKILL, Windows `taskkill /T /F`; Claude Code started through the tree spawner. |
| `test/awake.test.ts` | 5 | Keeping the computer awake: commands per platform, held while working and released after, a missing tool reported not thrown. Fake spawner. |
| `test/awake-app.test.ts` | 1 | `App` holds the computer awake while conversations work, follows the setting, stops on shutdown. |
| `test/doctor.test.ts` | 11 | `masthead doctor` with every probe faked. One test skipped on Windows (POSIX modes). |
| `test/launcher.test.ts` | 22 | The `masthead` command line: port, command word, systemd port, dev page port, sign-in files and the key in the fragment, the opener, proof before sending the key, the service PATH, per-platform openers and folders, PATH lookup. Some tests skip off POSIX. |
| `test/platform.test.ts` | 10 | Folders per platform, finding Claude Code (Windows `.exe` and npm shims, including real cmd-shim 9.0.2 shims from `test/fixtures/npm-shim-9.0.2/`), making the secret private, renames on Windows. |
| `test/service-health.test.ts` | 10 | Out-of-memory handling and agents' temporary files (`server/service/laststop.ts`, `scratch.ts`, `usage.ts`): only an out-of-memory stop gives the restart notice; the marker is read once and only under systemd; the scratch root per platform and with `MASTHEAD_DATA_DIR`; scratch made private, removed with the conversation, swept when gone or neither active nor changed for 7 days (a file written deep inside, or recent activity in the conversation, keeps it; the walk is bounded and a folder past its limits counts as changed now); `systemctl show` and `cgroup.procs` parsed into memory and child processes; the longest matching mount point for `/tmp`; the doctor's `Service memory` and `Temporary folder` lines. No `systemctl`; files in a fresh temporary folder. |
| `test/scratch-app.test.ts` | 3 | The per-conversation scratch folder through a real `App` on the fake backend: an agent's session gets the folder as `TMPDIR` (`SessionSpec.env`) and in `SessionSpec.dirs`, its system text names the folder ("Your temporary folder is …"), and deleting the conversation removes it; `App.sweepScratch()` removes the folders of gone conversations and week-old ones and keeps the rest; a folder that cannot be made leaves the agent on the system temporary folder. Run on its own on 2026-11-27: 3 pass. |
| `test/service.test.ts` | 25 | The background service with every system call faked: systemd, launchd, Windows Task Scheduler; also that `scripts/install.sh` writes the same `OOMPolicy` and `ExecStopPost` lines as the unit, and that a unit with the old OOM policy or without the stop marker (`ExecStopPost` with `masthead-last-stop`) is reported as outdated. |
| `test/remote.test.ts` | 25 | Remote access logic with a fake Tailscale: pairing requests and codes, caps, refusal logging, tokens, deny, expiry, the devices file, revoke and roles (approving without a role gives `read`), the audit log, tailnet and tag rules, `authorise`, Tailscale `serve` commands and parsing, whois caching. No real `tailscale` command. |
| `test/remote-wiring.test.ts` | 19 | Remote access wired end to end with the fake provider: the switch, one socket per data folder, test servers never running tailscale, a leftover entry removed only by the instance that added it, refusals (a socket target refused for want of root offers `sudo tailscale serve …` and switching on then works; other refusals keep the operator advice and say what Tailscale said; switching off works even when the removal is refused, also at restart), restart, settings, pairing over HTTP (approved without naming a role: `read`), the device socket and its role, revoke, `forget_me`, the private socket folder, switching off while Tailscale is down. |
| `test/backend-conformance.ts` | (helper) | Not a test file by itself. `runConformance(name, make, opts)` defines the cases every backend must pass through the interface in `server/backends/types.ts` (see [Backend interface](Backend-Interface.md)): detect/models, a session answers and names the consumed message, a team tool through its `ToolDef`, resume by id, a missing session, a message during a turn, interrupt, a permission request, effort/model changes and `close('now')`. Cases the backend's `caps` rule out are skipped. Used by `fake-backend.test.ts`, `codex.test.ts` and `codex.live.ts`. |
| `test/fixtures/v0.1/` | (data) | A 0.1.x data folder: `settings.json` and two conversations (`conv-a` with a transcript, `conv-old`). Loaded by `characterisation.test.ts` and `storage.test.ts` (migration), as `AGENTS.md` requires for on-disk formats. |
| `test/fixtures/npm-shim-9.0.2/` | (data) | Real npm shims (`.cmd`, `.ps1`, `.sh`) for a `claude` that is an `.exe` and one that is a `.js`, with a `README`. Used by `platform.test.ts`. |

## Page tests (`npm run test:web`)

All in `web/test/`, environment `happy-dom` unless the file says `// @vitest-environment jsdom` (DOMPurify misbehaves under happy-dom).

| File | Tests | What it covers |
|---|---|---|
| `setup.ts` | (set-up) | Unmounts components after each test. Loaded through `setupFiles` in `web/vitest.config.ts`; not a test. |
| `settings-fixtures.ts` | (data) | A Claude and a Codex team and a backends report, shared by the settings tests. |
| `words.test.ts` | 6 | `statusWords`, `shortReason`, `fmtTokens`, `shortPath` (including Windows homes), `childPath`. |
| `pure.test.ts` | 4 | `settingsPatch` sends only changed fields; `worstLimit` and `limitKey` for the usage banner. |
| `signin.test.ts` | 4 | The sign-in key from `#key=` / `?key=`: the address is cleaned, the key stored only once accepted, fallback to the stored key. |
| `store.test.ts` | 4 | The store on fake v1 messages: pending approvals replaced on `state`, a refused message back into its draft without overwriting newer typing, the usage banner and its dismissal. |
| `store-v2.test.ts` | 4 | Protocol 2 in the store: approval summaries and `subscribe`, draft deltas and `draft_sync` after a gap, resubscribe with `since` after a reconnect, an older page merged. |
| `markdown.test.ts` | 4 | Markdown safety: agent HTML shown as text, no hand-made copy block, own code blocks kept, `javascript:` links dropped, `target`/`rel` on links. jsdom. |
| `draft.test.ts` | 7 | Incremental draft rendering: split points, an unclosed fence, the same result as a full render, cost per update, the Markdown cache. jsdom. |
| `permission-card.test.ts` | 2 | The approval card names the agent, takes focus when nobody types, keeps two questions with the same text apart. |
| `transcript.test.ts` | 1 | A 2,000-item chat renders the newest 80; "Show earlier" adds a page. jsdom. |
| `text.test.ts` | 2 | No team jargon in page strings; `friendlyError` rewrites known server errors. |
| `tiers.test.ts` | 2 | Tier colours from the profile (0.1.x names as fallback); one level box per level of the chat's profile. |
| `settings-logic.test.ts` | 6 | Team settings logic: usable teams, plain problem messages without banned words, adding/removing/copying levels, a new model's effort and name, a malformed backends report. |
| `settings-components.test.ts` | 8 | `BackendsSection`, `ProfilesSection` (the Codex team as a proposal, editing with real models, copy/remove, an invalid program name, a team whose program is not ready), `ProfileChip` (menu of usable teams only, Esc returns focus). |
| `remote-signin.test.ts` | 5 | The remote pairing screen (`fetch` mocked): code, poll secret across reload, refusals and rate limits, a stored token. |
| `device.test.ts` | 5 | A paired remote device's sign-in (`fetch` mocked): the token kept after a brief refusal, forgotten only when the server says it is invalid, "Forget this device"; what each device role may do (read-only: no stop buttons; approve: answer but not act). |
| `remote-section.test.ts` | 5 | The Remote access section and device request card (`fetch` mocked): switch, the box after a refusal, the command, devices list and activity. |
| `restricted-device.test.ts` | 12 | What the page shows on a remote device with a limited role: read-only (no message box, no rename, no new or deleted chats, approvals and questions shown without answer buttons, the tidy-up card and archived helpers without actions) and approve (may answer approvals and stop, no message box, no rename); this computer keeps the message box. |
| `compact.test.ts` | 3 | Tidying the team: the card keeps forced helpers ticked and sends the ticks; progress counts and offers Cancel; archived helpers leave the outline and sit under one row with Restore. |
| `team-outline.test.ts` | 8 | The team outline: rows nested by who started whom, folding finished helpers (never a failed one), collapsed branches, shrinking indent past depth 4; `TeamOutline` as a tree with keyboard (arrow keys, one tab stop). |
| `no-inline-text.test.ts` | 1 | Scans the markup of every `.svelte` file for English written inline (text between tags, `aria-label`, `title`, `placeholder`, `alt`): page text must come from `web/src/lib/text.ts`. |

## Browser test (`test/ui.e2e.mjs`)

Drives the real page in Chromium against a running test server: sign-in cases, the simple first load (at most 10 controls, no team jargon), settings, composer restore after a refused message, the approval card, the team panel and its outline (guides checked to the pixel), stop, tidying the team, folded reports, pictures, a phone layout (390 × 844, light theme, touch), progress without asking (fake backend only: the "Waiting for N helper" toggle and its helper list, activity times in that list and on the team row, and "Waiting for your answer", which highlights the buried question, moves focus to it and goes once it is answered), and axe-core WCAG 2 A/AA checks on several screens. The file has 133 `check(…)` calls; with the fake backend the checks that need a model's own writing (a code block, a final table) are skipped.

- **Usage:** `node test/ui.e2e.mjs <url> <screenshot folder>`. Exit 1 on a failed check, 2 on bad usage.
- **Never 7717:** it refuses that port (the installed app). The server must have its own data and settings folders, and a **fresh** data folder: it checks the empty first load.
- **Secret:** from `?key=` in the URL, else `MASTHEAD_KEY`, else `$MASTHEAD_DATA_DIR/secret`, else `$XDG_DATA_HOME/masthead/secret`.
- **Browser:** `$CHROMIUM`, else `/usr/bin/chromium` if present, else Playwright's own Chromium. Dark scheme unless `SCHEME=light`.
- **Backend:** `MASTHEAD_E2E_BACKEND=fake` with a server started with `MASTHEAD_BACKEND=fake MASTHEAD_ALLOW_FAKE=1` needs no account. That is what CI runs, through `node scripts/ci-e2e.mjs [shots]` (needs `npm run build` and `npx playwright-core install chromium`): a fresh temp data and config folder, a free port, `permissionMode: "default"`, tier limits Opus 3, Sonnet 2, Haiku 2, and `MASTHEAD_TAILSCALE=off`. Against real Claude Code it spends usage.

### Running it against real Claude Code

The settings must make a Write ask for approval (`permissionMode: "default"`) and allow three agents on the second tier at once; every tier on Haiku keeps it cheap. A settings file in the 0.1.x `tiers` shape still works: it is migrated into the Claude profile on load (with a backup), see [Configuration and settings](Configuration-and-Settings.md). From the project folder:

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

Not run for this page.

## Team screenshots (`web/test/team-shots.mjs`)

Not part of any suite. Takes screenshots of the team panel with a busy three-level team, for review. It needs a **fresh** test server on a port other than 7717 (it throws on 7717), started with `MASTHEAD_BACKEND=fake MASTHEAD_ALLOW_FAKE=1` and settings allowing 6 Opus, 1 Sonnet, 2 Haiku and `permissionMode: "default"`. Usage: `MASTHEAD_DATA_DIR=<its data folder> node web/test/team-shots.mjs <url> <shots folder>` (default URL `http://127.0.0.1:7798`). Browser: `$CHROMIUM`, else `/usr/bin/chromium`, else Playwright's own. Not run for this page.

## Live tests

`test/compact.live.ts` (Claude Code, Haiku: `Agent.compact()` on a finished agent) is described on [Live tests](Live-Tests.md#claude-code-testcompactlivets). `test/settings.live.ts` (Claude Code, Haiku: a permission mode change reaching a running session, and the scratch folder as `$TMPDIR`) is on [Live tests](Live-Tests.md#claude-code-testsettingslivets).

`test/live.e2e.ts` (Claude Code), `test/codex.live.ts`, `test/codex-team.live.ts` and `test/codex-app.live.ts` (Codex) run against the real, signed-in CLIs and spend real usage. How to run each and what it costs: [Live tests](Live-Tests.md).

## Related pages

[Live tests](Live-Tests.md) · [Building, testing and installing](Building-Testing-Installing.md) · [Code coverage map](Code-Coverage-Map.md) · [State machine](State-Machine.md) · [Backend interface](Backend-Interface.md) · [server/backends/fake/](Source-Backend-Fake.md)
