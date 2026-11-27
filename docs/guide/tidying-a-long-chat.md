# Tidying a long chat

[Back to the guide](README.md)

A long chat gathers many finished helpers, and the main assistant's memory fills up. Masthead tidies
the team for you, so it stays quick and does not run out of memory.

> New in 0.2.0.

## What happens

1. When the main assistant finishes a reply and the team has about 10 finished helpers, or its
   **Memory used** is past about 70 % or about 200,000 tokens (whichever comes first), Masthead
   tidies the team. Helpers that a restart cut off before they finished are always kept.
2. The main assistant decides which helpers it still needs. Helpers that are still working, and the
   ones that started a helper that stays, always stay.
3. The others are archived: they leave the team list but nothing is deleted.
4. Everyone who stays has their memory compacted (shortened), the main assistant last.
5. Afterwards the chat says what was done: how many helpers were archived, whose memory was
   compacted, and which helpers were kept and why.

While it runs, the page shows **Tidying the team…** and you can press **Cancel**.

## Tidy now: /compact

Type `/compact` in the message box and send it to tidy the team at once.

## Archived helpers

- **Archived helpers (N)** at the foot of the Team panel lists them, each with when it was archived.
- Click one to read its chat. It cannot be given new work while it is archived.
- **Restore** brings a helper back into the team.
- Helpers in the team can still read archived helpers' chats when they need something from them.

## Turning it off

- In the settings, **Tidy the team automatically** is on by default. Turn it off to be asked first.
- **Tidy this chat's team automatically**, in the Team panel, can turn it off for one chat only (with the setting off, it
  cannot turn it on for one chat).
- With it off, the main assistant suggests `/compact` once when the team gets large or its memory gets full, and `/compact`
  shows a card, **Tidy the team?**: *Keep N, archive M*, with a tick box for each helper. Helpers
  that must stay are marked **Stays: still working, or needed by a helper that stays**. Press
  **Tidy up**, or **Not now** to leave everything as it is.
