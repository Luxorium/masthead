# 0.2.1: fixes from real chats

Written 2026-11-27 by delta. 0.2.0 was analysed in daily use on two machines (a Linux VM, and
Nitro), read-only, from the stored chats, the settings and the service journal. Chats were not copied and their content is not
recorded here. The changes are listed in `CHANGELOG.md` under 0.2.1-beta.1.

## What the analysis found (the Linux VM: 2 chats, 16 agents)

1. **An out-of-memory kill stopped everything.** The kernel killed two small browser processes that
   agents had started inside `masthead.service`. Because of systemd's default `OOMPolicy=stop`, the
   whole unit stopped: the server, every agent and the browser. → `OOMPolicy=continue`, the reason
   for the last stop recorded and shown once in every chat used in the last 6 hours, and a doctor
   check of the service's memory; an older unit is flagged until `masthead service install`.
2. **A helper woken after the restart was marked done with an empty report** while it kept working
   for 16 minutes. Its real report arrived 25 minutes late, with two versions joined together.
   → Report and wake fixes (bravo).
3. **A message sent at the moment of the crash was never answered**, and that chat got no restart
   notice. → An unanswered last message is sent again once.
4. **Agents killed mid-turn showed $0** of usage. → The cost is now marked as incomplete instead.
5. **The main assistant did the work itself.** Helpers were "Keep light" by default, so they could
   not use the connected service their tasks needed, and the main assistant did not know that. It
   reached 405,000 tokens and cost about three times all its helpers together, although the person
   had asked it to delegate. → Opus no longer light by default; the prompt says which levels are.
6. **The main assistant said it could not show pictures.** → The prompt says pictures it reads are
   shown.
7. **Tidying never started.** 70 % of a 1,000,000-token memory is 700,000 tokens. → Also at 200,000
   tokens; 10 finished helpers instead of 15.
8. **The person asked three times why a helper took so long.** → Activity and elapsed time on
   helper rows, and "Waiting for N helpers" with detail.
9. **A helper was blocked by a full `/tmp`** (a tmpfs with a quota) filled by browser profiles. →
   A private scratch folder per chat as `TMPDIR` (for Codex, named in the prompt and made writable,
   since its agents share one process), and a doctor check for a small or full tmpfs. At start a
   live chat keeps its folder if the chat or the folder changed in the last 7 days.
10. **`read_archive` refused a helper that was finished but not archived.** → It reads any
    finished helper.

## What the analysis found (Nitro: the long development chat and one Codex chat)

1. **A change of permission mode did not reach running sessions.** → It is set live
   (`setPermissionMode`); on Codex only the approval policy changes, bypass opens full access,
   and "inherit" or leaving full access relaunches the session.
2. **After a restart nothing resumed until the person typed.** Three helpers stopped mid-task were
   later archived as if finished. → The main assistant gets a restart turn of its own; tidying keeps
   helpers a restart stopped.
3. **The main assistant relayed every helper report:** 45 messages in 50 minutes, 292 from it
   against 116 from the person. → The prompt asks for milestones and decisions only.
4. **Two quick messages got two near-identical answers.** → Messages that arrive while it is still
   answering are marked so for it.
5. **Agents could not delete their temporary folders** (17 denials), and `/tmp` filled. → A
   per-chat scratch folder.
6. **The main assistant's questions got buried**; the person pasted them back. → The **Waiting for
   your answer** button, and helper progress in the Team panel.
7. **Tidying compacted one agent at a time** (8 minutes for 10). → 3 at a time.
8. **Every tool call was stored twice with its full input** (6.2 MB of 24.6 MB). → The input is
   stored once.
9. **Agents asked for an effort they already had.** → They are told when their effort changes.
10. **The restart notice was clumsy.** → Rewritten, naming who started each stopped helper.

Checked and fine there: no lost or duplicated reports among 794, no corrupt lines, and all 53 blobs
referenced.

## Found while testing

- Device approval had **Everything** preselected. → **Read only** is the default, and a device approved with no level chosen is read only
  everywhere.
- On real Codex 0.172, a thread given full access for one turn kept it after the mode changed back
  or a restart. → On reopening, Masthead enforces on every turn what a new chat in the current mode
  would get (for "inherit", learned once per folder from a throwaway, never-saved thread); if that
  is unknown and the thread has full access, it refuses to start and asks for a mode or a new chat.
- Test runs left their folders in the system temp folder (about 34,000 folders, 5.6 GB on the
  development machine, enough to fill the `/tmp` quota). → Tests run in one temp folder removed at
  the end (`scripts/run-tests.mjs`); live and browser tests keep theirs only on failure.
- Usage was empty after a restart. → It is kept in `usage.json`.

## Deferred

- **Mixed teams** (Claude Code and Codex levels in one team): the runtime ran it in a test, but the
  page still allows one agent program per team.
- **Clickable answer choices** in the main assistant's questions.
- **Moving agents' processes out of the service** (so a restart does not close their browsers and
  their memory does not count against Masthead's), for example with `systemd-run --user --scope`.

## Not verified

The restart handling was checked on real Claude Code by `test/restart.live.ts` (a clean stop with a
helper mid-command, an unanswered message, a hard kill mid-turn, and a second restart that sends
nothing), but not against a real out-of-memory kill. The update from 0.2.0 itself does not resume a
lead that was mid-task (0.2.0 does the stopping and does not record it): send any message. Of the Codex permission changes, only "never ask" back
to asking is checked on real Codex (`test/codex-app.live.ts`); "inherit", the refusal to start and
read-only threads are tested only against a fake Codex, and a read-only Codex chat cannot write to
its scratch folder; browsers' profiles following `TMPDIR` is not checked.
