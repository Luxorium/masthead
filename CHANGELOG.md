# Changelog

## 0.2.0 (unreleased; pre-releases first)

Masthead for anybody: simple by default, on Linux, macOS and Windows, able to run a team on Claude
Code or on Codex, reachable from your other devices over your own Tailscale, and showing pictures.

What you will notice
- A simpler page by default, in plain words, with the team view one click away and a phone layout.
- Teams: choose a team profile (levels, which agent program, how many at once) instead of fixed tiers.
- Codex can run a team as well as Claude Code (new; see Known limits).
- Pictures: attach images to a message and see images agents produce; they are stored as files, not
  inside the transcript.
- Use Masthead from your phone or another computer over your own Tailscale: a switch in settings,
  each device approved by you with a six-digit code, its role adjustable, sign-out per device.
- Keeps the computer awake while helpers are working (idle sleep only; closing the lid or choosing
  Sleep still works). If the computer did sleep, the chat says from when to when.
- Runs on macOS and Windows as well as Linux: native folders, the browser opens signed in, and
  `masthead service install` starts it at login (systemd, launchd or Task Scheduler).
- `masthead doctor` checks the set-up and says how to fix what is wrong.
- A user guide for non-developers in `docs/guide/`.

Under the hood
- The team rules are a tested state machine; agent programs sit behind one backend interface (Claude
  Code, Codex, and a fake one for tests).
- Versioned settings (team profiles), storage format 2 (images as files) and protocol v2 (the old
  protocol is still accepted for one release).
- Platform fixes for macOS and Windows: finding Claude Code (`claude.exe`, npm shims, Homebrew),
  opening the browser, the secret kept private with an ACL on Windows, file retries, signals, drives.
- Package ready for npm with the built app inside (name pending), CI on Linux, macOS and Windows
  including the page in a real browser on the fake backend, SECURITY.md, CONTRIBUTING.md, code of
  conduct, issue templates, and outlines for Homebrew, AUR and Scoop.

Upgrading from 0.1.x
- Your conversations and settings are converted when 0.2.0 first uses them. Before the first rewrite,
  the old files are copied beside the new ones: `settings.json.v1.bak` and, per conversation,
  `conversation.json.v1.bak`.
- On Linux the folders stay where they were (`~/.config/masthead`, `~/.local/share/masthead`).
- The old way to install (`scripts/install.sh`) still works from a checkout; the new way is the package
  plus `masthead service install`.
- To go back to 0.1.4: stop Masthead, copy each `.v1.bak` file back over the file next to it, and
  reinstall 0.1.4. 0.1.x cannot read the new files. Images attached in 0.2.0 do not show in 0.1.4.
- Copying both folders somewhere safe before upgrading is still the simplest backup.

Known limits
- macOS and Windows have been built and tested automatically, but not yet checked by a person on real
  machines (`docs/plans/0.2.0/release-checklist.md`).
- Remote access has only run against a fake Tailscale in tests, not a real tailnet.
- Pausing at a usage limit is tested with a fake clock; it has never been seen at a real limit.
- Codex support drives Codex's own app-server interface, which Codex marks experimental, and Codex's
  own sub-agents could not be switched off in tests, so a Codex team cannot yet guarantee the levels.
- Stopping an agent now stops the commands it started (its whole process tree: `taskkill /T` on Windows);
  this is verified on Linux only.
- Not yet published to npm or any package manager; install from source.

## 0.1.4

Security
- The sign-in key is no longer passed to the browser on the command line, where other users of the
  machine could read it. `masthead` writes a private file that sends the browser on, with the key in
  the address fragment, which is never sent to the server.
- The launcher sends the key only to a server that has proved it knows the secret.
- A malformed request can no longer stop the server.
- Images are limited to 5 MB each and 30 MB per message on the server.
- A page elsewhere can no longer sign the browser out by linking to Masthead with a wrong key.

Agents
- At a usage limit an agent pauses and carries on when the limit resets, instead of failing.
- New setting "Longest run for a sub-agent" (off by default).
- Effort goes back to low after each piece of work.
- The agents you stopped and the count of messages between agents survive a restart.
- Every agent reports its real context size.
- A sub-agent left waiting only on a background command is closed after 10 minutes and reports what it has.
- A tier switched off refuses a new agent at once instead of queuing it.

Page
- The message box shows which agent it is pointed at, with "Back to Alpha".
- Open tabs reconnect by themselves after Masthead restarts.
- The usage banner is right after a reload; stopped agents show why they stopped.
- Settings changes send only what changed.

## 0.1.3

- After Zulu, agent names carry on as Alpha II, Bravo II … instead of alpha-2.

## 0.1.2

- An agent whose turn ends with a background command still running is waiting, not finished.
- A sub-agent can ask the agent that started it a question and wait for the answer.
- Settings apply to agents that are already running.
- `list_agents` shows activity, running time, context and cost.
- After a restart the lead is told which agents were stopped.
- The stop button is easier to see.

## 0.1.1

- Stop no longer lets a queued agent start afterwards.
- A report can no longer be replaced by a late acknowledgement.
- A local secret is required to connect; `masthead` signs the browser in.
- `--port` works on an installed copy.
- A usage section, a settings popup, and an option to fold agent reports.
- Unit tests for the server, the launcher and the team rules.

## 0.1.0

- First version: a lead agent that starts Opus agents, which start Sonnet agents, which start Haiku
  agents; limits per tier; named agents that message each other; automatic thinking effort; a team map;
  approvals.
