# Teams and agent programs

[Back to the guide](README.md)

Masthead does not contain an AI itself. It runs an **agent program** that you have installed and
signed in to on this computer, with your own account. Masthead never asks for or sees your password.

## Agents on this computer

In the settings (⚙ at the foot of the chat list), **Agents on this computer** lists the programs
Masthead found, each marked **Ready**, **Not found** or **Not ready**, with what to do next. After
installing or signing in to one, press **Check again**.

### Claude Code

What it needs:

1. Claude Code installed ([setup](https://code.claude.com/docs/en/setup)).
2. Signed in once: run `claude` in a terminal and follow the steps.

Claude Code uses your Claude plan or your API key, whichever you signed in with. Masthead runs the
Claude Code you installed, never a copy of its own. If Masthead says **Masthead needs Claude Code to
work**, install it, sign in, then restart Masthead.

### Codex

Support for Codex is new in 0.2.0. What it needs:

1. The Codex command-line program, version 0.172.0 or later.
2. Signed in: run `codex login` in a terminal.
3. Press **Check again** in **Agents on this computer**.

When Masthead finds a ready Codex, it offers **A team for Codex is ready**, put together from the
models your Codex offers. Choose **Use it for new chats**, or **Change it first**.

Things that work differently with Codex:

- A change of thinking time does not reach a helper that is already running; it applies from its
  next session.
- Codex helpers do not run commands in the background.
- Codex's highest thinking levels are not used; **Longest** is the most Masthead asks for.
- Codex's own helpers, picture making and goals are switched off: helpers start only through
  Masthead, so the team rules hold.
- Tidying a Codex helper's memory runs as a separate step of its own.

## Teams

**A team is the main assistant and the helpers it may bring in, one level each.** Masthead comes with
a built-in Claude team (Fable, then Opus, Sonnet and Haiku helpers).

- **Team for new chats** chooses the team a new chat starts with. You can also pick one for a single
  chat with the **Uses …** button under the message box (for example **Uses Claude**; its menu is "Choose which AI works on this chat"), before the first message. It shows only when you have more than one team that can start.
- Press **Edit …** (for example **Edit Claude**) to change a team's levels. For each level you can set the **Name shown**, the **Agent
  program**, the **Model**, **Thinking time up to**, **Helpers at a time**, **Keep light** and a
  **Colour**. **Add a helper level** adds one below; a team can have at most 5 levels.
- **In 0.2.0 a team runs wholly on Claude Code or wholly on Codex**: every level of a team uses the
  same agent program. To use both, make one team for each.
- If a team's program is missing or not signed in, the editor says "<program> is not ready on this computer, so this team cannot start yet."
- **Make a copy** to try changes without losing the original. **Reset to the built-in team** undoes
  your changes to a built-in one. **Remove team** deletes one you made; chats that used it keep their
  history. If you then make a new team with the
  same name, it is a new team: those chats keep the old team's settings.
- A team whose program is not ready says **Needs …, which is not ready on this computer.**
