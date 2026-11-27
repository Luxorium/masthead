# 0.1.1 audit (history)

> **History.** The plan for 0.1.1, released 2026-11-26. Kept as a record; the current plan is
> `docs/plans/0.2.0/PLAN.md`.

**Status, 2026-11-26:** items 1-20 below were implemented and released as 0.1.1, together with a usage
section, a settings popup, folded agent reports and a reuse line in the lead's prompt. The "Later"
list is still open. The rest of this page is the audit as written before the work.

Audit of Masthead 0.1.0, 2026-11-26. Done inside Masthead by the lead (alpha) with three Opus agents:
bravo (server/, shared/), charlie (web/), delta (tests, install scripts, docs). The lead read all of
`server/` itself and checked the findings below against the code; items it did not check are marked
"not re-checked". No source was changed. `npm run check` (0 errors) and `npm test` (14 pass) were run
by the agents. Nothing here was confirmed by running the failing scenario; each is read from the code.

## Verdict: 0.1.1, fixes and polish only

0.1.0 has bugs in the things it already promises: Stop does not always stop, a report can be lost,
`--port` does not work on an installed copy, and the security-critical HTTP layer and all of the team
rules have no unit tests. None of the fixes needs a new capability, and most are small. Adding features
on top of a Stop button that can leave an agent running would be the wrong order. New capability
(pausing at a usage limit, live settings, better tools for the lead) is listed for 0.2.0.

## Top problems

1. **Stop can start a "ghost" agent.** `server/agent.ts:251-256`: `launch()` runs when a slot is granted
   without checking the agent was ended meanwhile. Stop a parent with one running and one queued child of
   the same tier: ending the first frees its slot and grants it to the second in the same pass
   (`scheduler.ts:105-107`); `end()` on the second then finds nothing to cancel, and on the next tick its
   process starts anyway, shown as running, holding no slot, after the person pressed Stop. Same for
   Stop everything and delete.
2. **A late message replaces the report.** `server/agent.ts:472-484`, `conversation.ts:275`: the report
   is the text of the last turn only. A message or effort note (`conversation.ts:436`) that lands as the
   turn ends causes one more turn, and its "Noted" becomes the report; the findings never reach the parent.
3. **`--port` is wrong on an installed copy, and `stop --port N` stops the real app.**
   `server/main.ts:77-78` starts the systemd unit (always 7717) then polls port N for 10 s and fails;
   `main.ts:135` stops the unit whenever one exists, even when aimed at a test server on another port.
4. **The page loses input and misses approvals.** The composer clears text and images before the server
   accepts them (`web/src/lib/Composer.svelte:65-67`), so any rejection deletes what was typed; 8 images
   of 5 MB exceed the 48 MB socket limit (`Composer.svelte:6-7`, `server/http.ts:20`) and the socket is
   closed. After a reconnect the page never learns of approval requests in conversations that are not
   open (`store.svelte.ts:98`; `AppState` carries none), so an agent can wait for Allow unseen; `creating`
   is not reset either, leaving the composer stuck on "Starting…".
5. **No tests where it matters, and no local secret.** Nothing tests `serve()`/`serveStatic()`
   (`server/http.ts:35,118`: Host, Origin, shutdown header, path check) or anything in
   `server/conversation.ts`. The socket has no token (`http.ts:64`): any local process can send a fake
   Origin, set `bypassPermissions` and send prompts. This was a known limit of 0.1.0; it should not
   survive a second release.

## Contents of 0.1.1, in priority order

Sizes: S = under an hour, M = a few hours, L = a day or more.

| # | Item | Where | Size |
|---|---|---|---|
| 1 | Do not launch an agent that was ended while waiting for a slot or for its old process; release the slot | `agent.ts:251-270` | S |
| 2 | Report the substantive text, not the last turn's: keep the last non-trivial turn text across follow-up turns; stop sending effort notes as messages that need a turn | `agent.ts:472-484`, `conversation.ts:436` | M |
| 3 | Do not clear all unanswered messages when a result names none (self-started and error turns) | `agent.ts:455-457` | S |
| 4 | Launcher: `--port` on an installed copy; `stop` only touches the unit for the unit's port | `main.ts:75-91,130-144` | S |
| 5 | Per-launch token for the socket and `/api/shutdown`, given to the page only | `http.ts`, `app.ts`, `web/src/lib/store.svelte.ts` | M |
| 6 | Unit tests: HTTP layer (Host, Origin, header, traversal); `Conversation` with a fake host (spawn tiers, find, message/owesReport, stop, effort, finish/report/settle, restore); `App.dispatch` validation; launcher argument parsing; `handleResult` bookkeeping. Include regression tests for 1–4 | `test/` | L |
| 7 | Page: keep composer text until accepted or restore on error; cap total image size; reset `creating` on reconnect; send all pending approvals with `state` | `Composer.svelte`, `store.svelte.ts`, `protocol.ts`, `app.ts:187` | M |
| 8 | Sanitizer: forbid `style`, `class`, `id` on agent-written HTML (keep classes Masthead adds itself). Today an agent can draw a full-page fake "Allow" link or hide text inside a Copy block | `web/src/lib/markdown.ts:37` | S |
| 9 | Tell an agent its real starting effort. The prompt and `set_effort` say "you start at low" even when started higher; bravo, started at high, asked to "raise" to medium and was silently lowered | `prompts.ts:46`, `tools.ts:73-74`, `conversation.ts:409` | S |
| 10 | Setting a tier to Off with agents queued: fail them with a notice instead of leaving them and their parent waiting for ever | `scheduler.ts:46,94`, `conversation.ts:313` | S |
| 11 | A finished agent woken by anyone other than its parent delivers its result to nobody; an agent can wake one the person stopped | `conversation.ts:362-367` | S |
| 12 | Escape `</agent-message>` / `</agent-report>` in envelope bodies | `prompts.ts:57-64` | S |
| 13 | Server must not die on a stream or save error (file vanishing during a build, disk full) | `http.ts:128-142`, `app.ts:158-161` | S |
| 14 | A resume whose session file is gone: clear the session id and say so, instead of failing every send | `agent.ts:313`, `conversation.ts:278-287` (exact CLI error not re-checked) | M |
| 15 | Lean mode for Opus agents too, as a setting. Opus agents (and the lead) load every connector the person has; all three auditors got Gmail, Drive, Shopify and Docs tools for a code audit | `agent.ts:292` | S |
| 16 | Close the remaining routes round the tiers: `Skill` entries that start sub-agents or workflows, and deferred tools (`CronCreate`, `RemoteTrigger`, `SendToProject`, `PushNotification`) are still offered | `agent.ts:87` | S |
| 17 | `ui.e2e.mjs` refuses port 7717; make its `true` assertion real | `test/ui.e2e.mjs:6,35` | S |
| 18 | Install: run `npm ci` when the lock file changed; warn before restarting when agents are working; wider PATH for the unit; absolute path in the desktop entry | `scripts/install.sh:26,32-37,55-56,71`, `packaging/masthead.desktop:5` | M |
| 19 | Small page fixes: composer draft per conversation; folder picker shows stale listing on reopen; question card names the asking agent and takes focus; "a Opus" grammar | `Composer.svelte`, `FolderPicker.svelte`, `PermissionCard.svelte`, `prompts.ts:26` | S |
| 20 | Wiki: remove stub markers, fix links, list new pages, note the `--port` behaviour. Do this last; see note below | `docs/wiki/` | M |

Wiki note: during this audit another session was editing `docs/wiki/` (files changed at 22:22–22:23,
five new untracked pages including `Source-Install-Scripts.md`, which delta had reported as a broken
link). Delta's doc findings describe 22:22 and are partly out of date already. Recheck after that
session finishes, and line-check the pages delta did not: Agent-Life-Cycle, Team-Rules, Permissions,
Browser-Server-Protocol, Glossary, walkthroughs.

## Later (0.2.0 candidates)

- **Usage limit handling (M–L).** An error turn fails every sub-agent and stops its children
  (`conversation.ts:271-275`); at a limit the whole tree collapses. Pause until `resetsAt` and resume.
- **Settings that take effect now (M).** Lead model, ceilings and the auto-effort switch only apply to
  processes started later (`app.ts:307-312`, `tools.ts:68`).
- **Streaming cost (M).** The full draft is sent every 70 ms to every tab for every conversation and
  re-parsed as Markdown each time (`agent.ts:493-505`, `app.ts:100-102`, `Transcript.svelte`). Send
  deltas, only to tabs that have the conversation open.
- **Transcript size (M).** Tool inputs stored unclipped and rewritten on completion; whole file read
  on every `items` request (`agent.ts:397,413`, `store.ts:79-94`); hover in the team map keeps every
  transcript it touched.
- **Better tools for agents (M).** See the next section: progress and cost in `list_agents`, a report
  length limit, a question that does not count as finishing.
- **After a restart (S).** A waiting lead becomes idle and is never told its agents were stopped
  (`conversation.ts:85-91`).
- Already known and still open: effort does not fall back to low by itself; sub-agent with a background
  command still running is closed; message counter resets on restart; context maximum assumed 1M;
  untested paths from the handoff (images end to end, real Sonnet/Haiku tiers, long runs, reboot).
- Before any public release: name and trademark check, licence, Anthropic's rules for such products.

## Being an agent in Masthead: what was awkward or wasteful

Seen by the lead and the three Opus agents during this run.

- **Connector and skill clutter.** The lead's context held about a hundred deferred connector tools
  (Gmail, Drive, Shopify), a Docs server whose instructions say to create a document first, and a long
  skill list, including skills for workflows and for reviews that start sub-agents, which Masthead
  forbids. Opus agents got the same. This is the largest avoidable token cost (items 15, 16).
- **Instructions meant for a person's own session.** The global CLAUDE.md (owned task, HANDOFF.md)
  loads into every sub-agent and conflicts with a narrow, read-only brief.
- **"The user hasn't heard from you" nudges reach sub-agents**, who have no user; the lead got one too
  while it could do nothing but wait.
- **Effort is opaque.** An agent is not told its starting level (item 9), and `set_effort` replies do
  not say whether the level went up or down.
- **Asking a question finishes you.** The prompt tells a blocked sub-agent to ask its parent with
  send_message; ending the turn to wait counts as finishing and sends a "report" that is only the
  question. It works because the reply resumes the agent, but the parent sees a false completion.
- **The lead is blind while waiting.** `list_agents` gives status only: no current activity, context
  use or cost, though the page has all three. There is no cap on report length, and no way to see that
  an agent is stuck short of waiting.
- **Line numbers in reports were wrong** for two of three agents (offsets from reading several files
  in one command). Every reference above was re-located by the lead. A line in the sub-agent prompt
  asking for file-relative line numbers would have saved that.
- **No signal about other writers.** Nothing told the team that another session was editing the same
  folder.
- **Folder mismatch.** This conversation ran in another folder, not the Masthead source the prompt called
  "this folder"; the lead had to find the project. The page could show the conversation's folder more
  plainly beside the composer.
