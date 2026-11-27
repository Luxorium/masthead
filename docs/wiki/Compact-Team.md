# Compact team

A long chat gathers many finished helpers, and the lead's memory (its context) fills up. **Compacting the team** ("tidying the team" in the page and the guide) archives the finished helpers the lead no longer needs and compacts the memory of everyone who stays, the lead last. It is new in 0.2.0. The design is `docs/plans/0.2.0/compact.md`; the code is the section "archived helpers and team compaction" of `server/core/conversation.ts`. The user guide's page is [`docs/guide/tidying-a-long-chat.md`](../guide/tidying-a-long-chat.md).

Everything here was read from the code. It is covered by `test/compact-app.test.ts`, `test/machine.test.ts`, `web/test/compact.test.ts` and the live test described on [Live tests](Live-Tests.md).

## What starts it

Two numbers in `conversation.ts` set the threshold: `COMPACT_SUGGEST_HELPERS = 15` finished helpers and `COMPACT_SUGGEST_MEMORY = 0.7` (70 % of the lead's `usage.contextMax`). A "finished helper" here is one that is not the lead, not live and not archived (`archivable()`).

- **`/compact`.** Text sent to the lead of an existing conversation that is exactly `/compact`, optionally followed by words, with no images, is not chat: `App` calls `Conversation.startCompact(words)` (see [Browser/server protocol](Browser-Server-Protocol.md)). The words go to the lead as the flow's `note`. Sent to a helper, or with images, it is an ordinary message.
- **Automatically.** When the lead's turn ends without being interrupted or failing, `leadTurnEndedForCompact()` starts a tidy with `startCompact('', { auto: true, reason })` if automatic tidying is on, no tidy is running, the person has no approval open for the lead, and either:
  - there are 15 or more finished helpers **and** at least 15 more helpers have finished (archived ones counted) since the last tidy (`meta.compactMark.finished`); or
  - the lead's memory is 70 % full or more **and** memory is "armed".
  The reason is "the team has N finished helpers" or "the lead's memory is N% full".
- **The cool-down** is `meta.compactMark = {finished, memoryArmed}`. An automatic tidy records the helpers finished so far and disarms memory if memory set it off. A `/compact` records the helpers finished so far and disarms memory. Memory re-arms at a lead turn end where it is back under 70 %; that turn end starts nothing.

### Automatic tidying on or off

`autoCompactOn()` is true when the setting `autoCompact` is not `false` **and** the conversation's `meta.autoCompact` is not `false`. The setting ("Tidy the team automatically") is on by default; a missing value becomes `true` ([Configuration and settings](Configuration-and-Settings.md)). The per-chat switch ("Tidy this chat's team automatically") sends `auto_compact`; `setAutoCompact(on)` stores `false` for off and removes the field for on. So the switch can only turn tidying off for one chat: with the setting off, switching it on in a chat changes nothing, and the page shows it disabled.

With automatic tidying off:

- Nothing starts by itself.
- Once per conversation, when the team has 15 finished helpers or the lead's memory is 70 % full, the person's next message to the lead is prefixed with a line from `compactHint()`: "Masthead: … You may suggest once, in your reply, that the person type /compact to tidy the team." `meta.compactSuggested` is then set, so it is not said again.
- `/compact` still works, and the lead's choice goes to the person on a card (below).

The `auto` flag is taken when a flow starts, so changing the setting does not change a flow already under way.

## The phases

The flow's state is `meta.compact`, a `CompactState` from `shared/protocol.ts`, saved with the conversation. Its `phase` is one of:

| Phase | Meaning | Next |
|---|---|---|
| `asked` | The lead has been asked to choose who to keep. | `proposed` (automatic off) or `archiving` (automatic on) when the lead calls `compact_team`; `cancelled` if it does not. |
| `proposed` | The person sees the card. | `archiving` on Tidy up; `cancelled` on Not now. |
| `archiving` | The chosen helpers are being archived. | `compacting` straight away. |
| `compacting` | Each agent that stays compacts its memory in turn; `pending` lists who is left. | `done`. |
| `done` | Finished; the summary notice has been added. | A later tidy replaces it. |
| `cancelled` | Stopped by the person, declined on the card, or left unanswered by the lead. | A later tidy replaces it. |

The other fields: `id`, `auto`, `reason?`, `askedAnswered?`, `keep` (`CompactKeep[]`: `name`, `why`, `forced?`), `archive` (names), `note`, `pending`, `failed` (`{name, why}`), `startedAt`. A flow is "running" in any phase but `done` and `cancelled`; a second `/compact` meanwhile only adds the notice "Tidying the team is already under way."

Every change goes through `setCompact()`, which saves the meta and calls `App.compactChanged()`. That sends `{t:'compact', convId, compact}` and then `{t:'archived', convId, agents}` (the agents with `archived` set) to every tab.

## Asking the lead

`startCompact()` adds the person's `/compact` line to the lead's chat (not for an automatic tidy) and builds the state in phase `asked`. If there is nothing to archive, the lead is not asked: the flow goes straight to `compacting`.

Otherwise the lead is woken and sent one message: "The person asked to tidy the team" (or "Masthead is tidying the team") with the reason or words, then "Call compact_team with the finished helpers to keep and why (helpers still working are kept anyway)." It ends with either "The rest are archived and everyone who stays compacts its memory; the person is told afterwards." (automatic) or "The person confirms on a card.", and says archived helpers' chats stay readable with `read_archive`.

If the lead does not answer: the first lead turn end in phase `asked` only sets `askedAnswered`; the next one cancels the flow with the notice "The lead did not choose who to keep, so the team was not tidied." Nothing is archived.

## Who stays: compact_team

`compact_team` is a lead-only tool ([server/core/tools.ts](Source-Core-Tools.md)): `keep` (up to 100 `{name, why}`) and an optional one-line `note`. `Conversation.compactTeam()`:

1. Refuses if the caller is not the lead ("Error: only the lead tidies the team.") or the phase is not `asked` ("Error: nobody asked to tidy the team now.").
2. Looks up each named helper; the lead, an archived helper or an unknown name is an error ("Error: there is no helper named … in the team."). Each `why` is cut to 200 characters ("kept by the lead" if empty).
3. Adds the helpers that **must** stay, marked `forced`:
   - every live helper (`why`: "still working");
   - every agent above a kept helper, up to the lead (`why`: "started X, which stays").
4. Everything else that is archivable goes into `archive`. The note is cut to 500 characters.

With `auto` the flow moves to `archiving` at once and the tool replies "Archiving N and keeping M; then everyone who stays compacts its memory, you last. The person is told." Otherwise it moves to `proposed` and replies "The person sees a card: keep M, archive N. You will hear the outcome."

## The card (automatic tidying off)

In phase `proposed` the page shows `CompactCard` ([Web components](Source-Web-Components.md#compactcardsvelte)): "Tidy the team?", "Keep N, archive M", the lead's note, and a tick per helper. Forced keeps are ticked and locked ("Stays: still working, or needed by a helper that stays"). The person answers with `compact_answer {convId, id, keep, accept}`, which needs the `approve` role or above.

`answerCompact()` ignores an answer whose `id` is not the flow's or whose phase is not `proposed`.

- **Not now** (`accept: false`): phase `cancelled`, and the lead's chat gets "The person declined the team compaction."
- **Tidy up**: the keeps are the forced ones, the lead's keeps still ticked, and any proposed-for-archive helper the person ticked (`why`: "kept by the person"). Every other archivable helper is archived. The flow moves to `archiving`.

## Archiving

`archiveAndCompact()` applies the machine event `Archive` to each named helper that is found, not live and not the lead, and stamps `info.archived` with the time. It can run twice safely (a restart may repeat it). Then the flow moves to `compacting`.

In the [state machine](State-Machine.md) an archived agent has `archived: true` and ignores every event except `Unarchive`. What that means:

- **Nothing is deleted.** The helper stays in `conversation.json` with `info.archived` set, and its transcript in `items/` is untouched ([Storage on disk](Storage-on-Disk.md)).
- **It leaves the team list.** `list_agents` leaves it out and adds a line "N archived helpers: read their chats with read_archive."; the page moves it to the "Archived helpers (M)" row under the team tree ([TeamOutline](Source-Web-Components.md#teamoutlinesvelte)).
- **It cannot be given work.** `send_message` to it returns "Error: … is archived and cannot be woken. Read its chat with read_archive."; the person's message to it is stored with the notice "… is archived. Restore it from the archived helpers to message it." `set_agent_effort` treats it as not in the team.
- **Its chat stays readable.** Agents use `read_archive`: with no name, a list of archived helpers with tier, job, when archived and the first lines of their last reply; with a name, that chat as plain text, 12,000 characters a page (`ARCHIVE_PAGE_CHARS`), optionally only lines with a `search` word and one line around each. The page uses `archive_items {convId, agentId, before?, limit?}`, which works like `items` but only for an archived agent ("That agent is not archived here." otherwise); `read` devices may send it. The chat opens read-only, with an Archived note and Restore in place of the composer.

## Compacting memory

`compactOrder()` lists who compacts: every helper that is not archived and has a session or is live, then the lead, last. `runCompact()` goes through `pending` one at a time:

- A missing or archived agent is skipped silently.
- A helper that is running, queued or busy is skipped and recorded in `failed` as "still working".
- The lead, if still running (usually in the turn that called `compact_team`), is waited for: `runCompact()` stops and the lead's turn end starts it again.
- Otherwise it calls `Agent.compact()` ([server/runtime/agent.ts](Source-Runtime.md)), which calls the backend session's `compact()` ([Backend interface](Backend-Interface.md)). An agent without a process has its session resumed quietly for this and closed again. An agent with no session yet counts as done. A failure is recorded in `failed` with its reason, for example "This agent program cannot compact its memory."

Compaction is not a turn: no report, no status change, and messages that arrive meanwhile are delivered afterwards.

## The summary notice

When `pending` is empty the phase becomes `done` and the lead's chat gets an info notice from `compactSummary()`, for example:

> Archived 6 finished helpers and compacted the memory of 3 that stay. Kept: bravo because its findings are still needed. Also kept: charlie (still working). Not compacted: charlie (still working). Archived helpers can be read or restored from the team panel.

With nothing archived it starts "Compacted the memory of N agents." It gives no "memory freed" figure, because the backend only reports the new size after the next turn.

## Cancel

While a flow is running, the progress line ([CompactProgress](Source-Web-Components.md#compactprogresssvelte)) offers **Cancel**, which sends `compact_cancel` (`approve` role or above). `cancelCompact()` sets `cancelled` and adds "Team compaction cancelled." An agent already compacting finishes; no one after it starts. Helpers already archived stay archived.

## Restore

**Restore** on an archived helper sends `restore_agent {convId, agentId}` (`full` role or the local page). `restoreAgent()` applies `Unarchive`, clears `info.archived` and saves. The helper is back in the team as a finished helper and can be messaged again. An id that is not archived is ignored.

## After a restart

`Conversation.restore()` calls `resumeCompact()`:

- `asked` becomes `cancelled` with "Masthead restarted before the lead proposed a compaction. Type /compact again to start over."
- `proposed` keeps its card.
- `archiving` runs the archiving again.
- `compacting` carries on with `pending`.

## Messages

| Message | From | What it does |
|---|---|---|
| `send` with `/compact` | page | `startCompact(words)`. |
| `compact_answer` | page | The card's answer. |
| `compact_cancel` | page | Cancel. |
| `restore_agent` | page | Restore an archived helper. |
| `archive_items` | page | Read an archived helper's chat; the reply has the same name. |
| `auto_compact` | page | The per-chat switch. |
| `compact` | server | The flow's state, to every tab. |
| `archived` | server | The archived agents, to every tab after each `compact`. |

A version 2 tab must be subscribed to the conversation before it sends `compact_answer`, `compact_cancel`, `restore_agent`, `archive_items` or `auto_compact`. Fields and replies: [Browser/server protocol](Browser-Server-Protocol.md). The page keeps the state in `store.compact` and `store.archivedAgents` ([Web store](Source-Web-Store.md)).

## The fake backend

The fake backend advertises `compact: true`. Its `compact()` waits a moment and calls `compacted()`. Its fake lead answers the tidy message by keeping the first finished helper in `list_agents` ("its findings are still needed") and calling `compact_team` with the note "Tidied by the fake lead." See [Fake backend](Source-Backend-Fake.md).

## Related pages

[Team rules](Team-Rules.md) · [State machine](State-Machine.md) · [Source: core/conversation.ts](Source-Core-Conversation.md) · [Source: core/tools.ts](Source-Core-Tools.md) · [Backend interface](Backend-Interface.md) · [Configuration and settings](Configuration-and-Settings.md) · [Storage on disk](Storage-on-Disk.md) · [Browser/server protocol](Browser-Server-Protocol.md) · [Web components](Source-Web-Components.md) · [Web store](Source-Web-Store.md) · [Live tests](Live-Tests.md)
