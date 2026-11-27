# Changelog

## 0.2.0

Masthead for anybody: simple by default, on Linux, macOS and Windows, able to run a team on Claude
Code or on Codex, reachable from your other devices over your own Tailscale, and showing pictures.

What is new
- A simpler page, in plain words, with a phone layout. The team is one click away in the Team panel:
  an outline with each helper under the one that started it, branches you can fold, and **Hide
  finished** to fold finished helpers into one row. Resting on a helper shows its task and last lines.
- Teams: choose a team profile (levels, which agent program, how many at once) instead of fixed tiers.
- Codex can run a team as well as Claude Code (see Known limits).
- Pictures: attach images to a message and see images agents produce. They are stored as files, not
  inside the transcript.
- Long chats tidy themselves. When the team has about 15 finished helpers, or the main assistant's
  memory is about 70 % full, the main assistant keeps the helpers it still needs, the others are
  archived, and everyone who stays has their memory compacted; the chat then says what was done.
  Type `/compact` to tidy at once. Archived helpers stay readable under **Archived helpers** and can
  be restored. **Tidy the team automatically** (on by default, and per chat) turns it off; then
  Masthead asks first with a card. See [Tidying a long chat](https://github.com/Luxorium/masthead/blob/main/docs/guide/tidying-a-long-chat.md).
- Use Masthead from your phone or another computer over your own Tailscale: a switch in settings,
  each device approved by you with a six-digit code, its role adjustable, sign-out per device. On
  Linux and macOS, Tailscale needs one command with your password the first time (`sudo tailscale
  serve --bg --https=7443 unix:…`); the settings show it exactly. Switching remote access off always
  works, even when Tailscale refuses to remove its entry (a note then shows the command to remove it).
- Keeps the computer awake while helpers are working (idle sleep only; closing the lid or choosing
  Sleep still works). If the computer did sleep, the chat says from when to when.
- Runs on macOS and Windows as well as Linux: native folders, the browser opens signed in, and
  `masthead service install` starts it at login (systemd, launchd or Task Scheduler).
  `masthead service status` says whether Masthead answers on its port and whether the service or you
  started it. Without `--port`, `masthead`, `status`, `stop`, `service` and `doctor` use the installed
  service's port (else 7717); `--port` or `MASTHEAD_PORT` wins.
- `masthead doctor` checks the set-up and says how to fix what is wrong.
- Fixed since the last pre-release: chats on a copied team or a Codex team could show empty; a picture
  dropped beside the message box no longer makes the browser leave Masthead, dragged text still drops
  as text, and dragging over the box no longer flickers; the **Uses …** button now shows when the only
  team that can start is not the default, and the chat starts with the team it names; a copy of a team
  no longer reuses the id of a removed team: a new team with a removed team's name gets its own id
  (for example `name-2`), and the removed team's chats keep its settings; removing a team still
  in use explains what happens in plain words. A device with fewer rights sees what is waiting, with
  a note saying what it may do and how to get more; one that may stop work gets **Stop reply** and
  **Stop all**.
- A notice on what Masthead is and is not, and how to use an API key instead of a Pro/Max plan:
  [Your account, API keys and the terms](https://github.com/Luxorium/masthead/blob/main/docs/guide/accounts-and-terms.md).
- A user guide for people who are not developers: [docs/guide](https://github.com/Luxorium/masthead/blob/main/docs/guide/README.md).

Upgrading from 0.1.4
- Your conversations and settings are converted when 0.2.0 first uses them. Before the first rewrite,
  the old files are copied beside the new ones: `settings.json.v1.bak` and, per conversation,
  `conversation.json.v1.bak`.
- On Linux the folders stay where they were (`~/.config/masthead`, `~/.local/share/masthead`).
- New way to install: `npm install -g --os=none --cpu=none <the .tgz from the GitHub release>` and then
  `masthead service install`. Masthead is not on the npm registry; it may be later
  (see [Installing](https://github.com/Luxorium/masthead/blob/main/docs/guide/installing.md)). `--os=none --cpu=none` keeps npm from installing the
  Agent SDK's private copy of Claude Code, which Masthead does not use; `--omit=optional` does not
  work for a global install. `scripts/install.sh` still works from a checkout on Linux.
- Windows: in PowerShell run `masthead.cmd`, because stock PowerShell refuses npm's `masthead.ps1`
  ("running scripts is disabled"). Command Prompt takes plain `masthead`.
- To go back to 0.1.4: stop Masthead, copy each `.v1.bak` file back over the file next to it, and
  reinstall 0.1.4. 0.1.x cannot read the new files. Images attached in 0.2.0 do not show in 0.1.4.
- Copying both folders somewhere safe before upgrading is still the simplest backup.

Under the hood
- The team rules are a tested state machine; agent programs sit behind one backend interface (Claude
  Code, Codex, and a fake one for tests). Archived is a state of a finished helper: it holds no slot
  and cannot be woken by agents. A tidy-up in progress is saved and carries on after a restart; agents
  read archived helpers' chats with a `read_archive` tool.
- Versioned settings (team profiles), storage format 2 (images as files) and protocol v2 (the old
  protocol is still accepted for one release).
- Platform fixes for macOS and Windows: finding Claude Code (`claude.exe`, npm shims, Homebrew),
  opening the browser, the secret kept private with an ACL on Windows, file retries, signals, drives.
- Each data folder has its own Tailscale socket, so a second Masthead or a test can no longer remove
  the real one's Tailscale entry; test and fake servers never run `tailscale`.
- CI on Linux, macOS and Windows including the page in a real browser on the fake backend;
  SECURITY.md, CONTRIBUTING.md, a code of conduct, issue templates, and outlines for Homebrew, AUR
  and Scoop.

Known limits
- macOS is built and tested automatically on every change, but has not yet been checked by a person
  on a real Mac. Please report anything that does not work there.
- Windows has been checked on one real Windows 11 PC (install, doctor, agents and helpers, the
  service at login).
- Remote access has been checked on a real tailnet with a Linux computer running Masthead, an
  Android phone and a Windows device.
- Codex (CLI 0.172.0 or later) was checked for real: a Codex team with a helper and its report, a
  permission prompt (deny and allow), a picture, Stop all, and a Claude lead with a Codex helper. Not
  yet tried for real: stopping a single Codex helper, a Codex lead with Claude helpers, and "always"
  answers. With Codex a change of thinking time applies from the agent's next session, there are no
  background commands, Codex's highest effort levels are never used, and Codex's own sub-agents,
  image generation and goals are switched off so helpers start only through Masthead. Compaction
  runs as a separate turn. Masthead drives Codex's app-server interface, which Codex marks
  experimental. The page lets one team use only one agent program.
- Pausing at a usage limit is tested with a fake clock; it has not yet been seen at a real limit.
- Stopping an agent stops the commands it started (its whole process tree: `taskkill /T` on Windows);
  this is verified on Linux only.
- Tidying has been run on real Claude Code (Haiku) by a live test that is not part of CI. How much
  memory a compaction frees depends on the agent program and is not shown.

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
