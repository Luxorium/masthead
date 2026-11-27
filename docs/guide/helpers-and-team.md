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

1. Press **Team** at the top of the page. It shows **Team · 2 working** while helpers work.
2. The panel lists everyone in this chat, with what each is doing: **Working**, **Waiting its
   turn**, **Waiting**, **Idle**, **Done**, **Failed** or **Stopped**.
3. Click a helper (**Click to open the chat**) to read its own chat, or to message it directly.
   **Back to …** returns you.
4. **Show as a map** draws the team as a tree. **Back to the chat** returns.
5. **Memory used** shows how full the main assistant's memory of this chat is.

## Team controls

Turn on **Show team controls** in the settings to see these in the Team panel:

- **Helpers at a time**: how many helpers of a level may work at once, across all your chats.
  More than that wait (**Waiting its turn**). **Off** means that level starts none.
- **Thinking time** (or **Thinking time up to**): **Short**, **Medium**, **Long** or **Longest**.
  Longer thinking is more careful and uses more of your plan.

Other settings that shape the team:

- **Let them decide how long to think**: everyone starts with short thinking time; the main
  assistant raises its own, helpers ask the one above them.
- **Keep Opus helpers light** and **Keep Sonnet and Haiku helpers light**: they skip your
  connected services, which keeps them smaller and quicker.
- **Show helper reports as one line**: reports stay folded until you open them.
- **Longest a helper may work**: a helper still working after this long is stopped, and the one
  that started it is told. **No limit** turns this off.

## Stopping

- **Stop** next to the message box stops the reply that is running now.
- **Stop all** stops the main assistant and every helper in this chat.
- **Stop** next to one helper in the Team panel stops that helper and everything under it.
- `masthead stop` in a terminal stops Masthead and all work in every chat.

Closing the browser tab does not stop anything.

## Usage

Under the chat list, **Usage** shows how much of your Claude plan you have used (for example
**This session (5 hours)** and **This week, all models**). Near the limit a banner says **You are
close to your Claude usage limit.** At the limit, helpers pause and carry on when it resets.
