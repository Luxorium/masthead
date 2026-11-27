# Compact team (0.2.0-beta.2)

> **History.** This plan was built in 0.2.0 (it first shipped in the 0.2.0-beta.2 pre-release). It is kept as the record of the design and the evidence; where it
> differs from the code, the code and `docs/wiki/` are right.

Status: design, 2026-11-27, foxtrot (core) with echo (backends), golf (app/protocol), charlie (page).
Nothing happens unless the person agrees.

## What the person sees (decided 2026-11-27: fully automatic, told afterwards)

1. **Automatic** (setting `autoCompact`, default on; "Tidy the team automatically"): when the lead's
   turn ends and the team has about 15 finished helpers, or the lead's memory is past about 70 %,
   Masthead asks the lead who to keep (`compact_team`), archives the rest and compacts the memory of
   everyone who stays, lead last. The person typing `/compact` does the same at once.
2. Afterwards the lead's chat says plainly what happened: "Archived 47 finished helpers and compacted
   the memory of 4 that stay. Kept: bravo because … Archived helpers can be read or restored from the
   team panel." No "memory freed" figure (the backend reports it only after the next turn).
3. Archived helpers leave the team list, cannot be woken, stay readable under **Archived helpers (M)**,
   with **Restore**. The person can cancel while it runs.
4. **Setting off** (or switched off for one conversation, `meta.autoCompact: false`): nothing automatic;
   the lead suggests `/compact` once past a threshold, and `/compact` shows the card: *Keep these N,
   archive M* with tick boxes (helpers still working stay ticked).

Guards: only at the end of a lead turn (or on `/compact`); never while the person has a question or
approval open for the lead; once per crossing, then a cool-down (`meta.compactMark`): not again until 15
more helpers have finished, or memory has dropped below the mark and risen past it again. If the lead
ends a turn after the request without choosing, nothing is archived.

## Core model (foxtrot)

- **Archived** is a flag on a finished agent: `AgentInfo.archived?: number` (when). In the state
  machine: `AgentState.archived`; events `Archive` (only from `ended`, never the lead) and `Unarchive`;
  `Woken` is ignored while archived. Archived agents are never live and hold no slot.
  `find()`, `send_message`, `stop`, effort tools skip them; `list_agents` ends with
  "N archived helpers: read them with read_archive". Saved in `conversation.json` (optional field:
  old files load; 0.2.0-beta.1 ignores it safely, the agents just reappear).
- **Compaction flow** per conversation, saved as `StoredConversation.compact` so a restart resumes it:
  `asked → (proposed, card only) → archiving → compacting → done` (or `cancelled`), with `auto` and `reason`, with `keep[] {name, why, forced}`,
  `archive[]`, `note`, `pending[]` (agents still to compact) and `failed[]`.
  - `/compact` (golf calls `Conversation.startCompact(words)`): the lead gets one message asking for
    `propose_compact`. If nothing can be archived, the flow goes straight to `compacting`.
  - `compact_team(keep: [{name, why}], note)` (lead only): live helpers and the ancestors of kept
    helpers are added to `keep` as forced; everything else finished is `archive`. Automatic: archives at
    once; setting off: raises the card.
  - The person's answer (`answerCompact(id, keepNames, accept)`): accept → archive → compact; refuse →
    `cancelled`. Ticks may only add to keep the forced ones.
  - Compacting: every kept agent that is not mid-turn, the lead last, through `Agent.compact()`
    (echo); a helper that is working is skipped with a note. Each finished one leaves `pending`.
    Restart: `proposed` keeps its card; `archiving` re-runs (idempotent); `compacting` carries on with
    `pending` once Masthead is up again. `cancel` is allowed until `compacting` ends.
- **Suggest once**: when the person sends the lead a message and the counts pass the thresholds, the
  core prepends one short bracketed line naming the count/percentage and `/compact`; a saved flag
  (`meta.compactSuggested`) stops it repeating. No system-prompt text.
- **read_archive** (every agent): no name → an index (name, level, job, archived when, first lines of
  the final report); with a name → that chat as plain text, paged (`page`), capped (12,000 chars), with
  an optional `search` word (matching lines with a line of context). Reads through
  `ConversationHost.readItems` (golf, from storage); archived chats never enter anyone's memory unread.
- **Restore** (the person only): `restoreAgent(id)` clears the flag.

## Seams

- echo: `Session.compact()` + `BackendCaps.compact`; `Agent.compact(): Promise<{ ok: boolean; error?: string }>`
  resumes the session if needed, waits for completion before the next message, refreshes usage.
- golf: `/compact` in app; protocol v2: `compact` event `{convId, compact}` (the flow state above),
  `compact_answer {convId, id, keep: string[], accept}`, `compact_cancel {convId}`,
  `archived {convId, agents: AgentInfo[]}` (and agents' `archived` field), `archive_items` paged like
  `items`, `restore_agent {convId, agentId}`; role gate (approve may answer; read may view).
- charlie: card, progress, Archived helpers row, read-only archived chat, `/compact` hint.

## Tests

Machine rows for Archive/Unarchive/Woken; flow state machine incl. restart in each phase; archived not
wakeable by agents or the person; Restore; a kept agent reading the archive (index, page, search);
suggest-once; live scenario on Haiku (echo).
