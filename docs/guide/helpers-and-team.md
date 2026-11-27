# Helpers and the team

[Back to the guide](README.md)

You always talk to one **Main assistant**. When a task is big, it can bring in **helpers**, and
helpers can bring in helpers of their own. Each helper has a name (Bravo, Charlie, …) and a short
title saying what its job is. When a helper finishes, it sends a report to the one that started it.

## Levels

A team has levels, each named after the model it uses. With the built-in Claude team:

1. **Fable**: the main assistant, the one you talk to.
2. **Opus** helpers, started by the main assistant.
3. **Sonnet** helpers, started by Opus helpers.
4. **Haiku** helpers, started by Sonnet helpers. They start no one.

**Each level can start helpers on the level below it.** You can change the levels in
[Teams](teams-and-agent-programs.md).

## The Team panel

1. Press **Team** at the top of the page. It shows **Team · 2 working** (**Team · 2** on a small
   screen) while helpers work.
2. The panel shows the team as an outline: the **Main assistant** at the top, and each helper
   under the one that started it, with its model and its job. Under each name a line says what it
   is doing: **Working**, **Waiting its turn**, **Waiting**, **Idle**, **Done**, **Failed** or
   **Stopped**. A working helper also shows what it is doing right now and for how long. When you
   have more than one team, the panel names the team this chat uses.
   While the main assistant waits for helpers, **Waiting for N helpers** names them; open it to see
   what each is doing.
3. The small arrow beside a name hides or shows the helpers under it.
4. **Hide finished** folds each helper's finished helpers into one row (for example **3 finished:
   Delta, Echo, Foxtrot**). Click that row to see them again. Helpers that failed are never folded.
5. Rest the pointer on a helper (or move to it with the keyboard) to see its task and its last few
   lines. Click it to read its own chat or to message it directly.
   **Back to …** returns you.
6. **Memory used: …%** shows how full the main assistant's memory of this chat is.
7. When the team has been tidied, **Archived helpers (N)** at the foot of the panel lists the
   helpers that were archived. See [Tidying a long chat](tidying-a-long-chat.md).

## Team controls

Turn on **Show team controls** in the settings to see these in the Team panel:

- **Helpers at a time**: how many helpers of a level may work at once, across all your chats.
  More than that wait (**Waiting its turn**). **Off** means that level starts none.
- **Thinking time** (or **Thinking time up to**): **Short**, **Medium**, **Long** or **Longest**.
  Longer thinking is more careful and uses more of your plan.

Other settings that shape the team:

- **Let them decide how long to think** (shown when **Show team controls** is on): everyone starts with short thinking time; the main
  assistant raises its own, helpers ask the one above them.
- **Keep light**, set per level when you edit a team (see
  [Teams and agent programs](teams-and-agent-programs.md)): agents on that level cannot use your
  connected services and tools, so they start faster and use less. The main assistant knows which
  levels cannot.
- **Show helper reports as one line**: reports stay folded until you open them.
- **Longest a helper may work**: a helper still working after this long is stopped, and the one
  that started it is told. **No limit** turns this off.

## Stopping

- The **■ Stop** button next to the message box stops the reply that is running now.
- **Stop all** stops the main assistant and every helper in this chat.
- **Stop** next to one helper in the Team panel stops that helper and everything under it.
- `masthead stop` in a terminal stops Masthead and all work in every chat.

Closing the browser tab does not stop anything.

## Usage

Under the chat list, **Usage** shows (**not reported yet** until an agent has run) how much of your Claude plan you have used (for example
**This session (5 hours)** and **This week, all models**). Near the limit a banner says **You are
close to your Claude usage limit.** At the limit, helpers pause and carry on when it resets.
