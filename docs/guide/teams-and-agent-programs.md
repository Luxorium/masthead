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

Support for Codex is new in 0.2.0 and still being tested. What it needs:

1. The Codex command-line program, version 0.172.0 or later.
2. Signed in: run `codex login` in a terminal.
3. Press **Check again** in **Agents on this computer**.

When Masthead finds a ready Codex, it offers **A team for Codex is ready**, put together from the
models your Codex offers. Choose **Use it for new chats**, or **Change it first**.

Things that work differently with Codex: a change of thinking time applies from the helper's next
step, and commands left running in the background are not followed up by Masthead.

## Teams

**A team is the main assistant and the helpers it may bring in, one level each.** Masthead comes with
a built-in Claude team (Fable, then Opus, Sonnet and Haiku helpers).

- **Team for new chats** chooses the team a new chat starts with. You can also pick one for a single
  chat with **Team:** under the message box, before the first message.
- **Edit** a team to change its levels. For each level you can set the **Name shown**, the **Agent
  program**, the **Model**, **Thinking time up to**, **Helpers at a time**, **Keep light** and a
  **Colour**. **Add a helper level** adds one below; a team can have at most 5 levels.
- **Every level of a team uses the same agent program for now.**
- **Make a copy** to try changes without losing the original. **Reset to the built-in team** undoes
  your changes to a built-in one. **Remove team** deletes one you made; chats that used it keep their
  history.
- A team whose program is not ready says **Needs …, which is not ready on this computer.**
