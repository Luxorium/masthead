# Index

Every page in this wiki, grouped. Start at [Home](Home.md).

## Start here

- [Home](Home.md): what Masthead is, a diagram of the whole, known limitations, a map of the wiki.
- [Architecture](Architecture.md): the layers, the server's objects and how events flow.
- [Glossary](Glossary.md): every term, defined.

## How it works

- [Agent life cycle](Agent-Life-Cycle.md): statuses, turns, processes, sessions, and what moves an agent between them.
- [Team rules](Team-Rules.md): tiers, names and titles, limits, reports, waiting, messaging, stopping.
- [Slot scheduling](Slot-Scheduling.md): per-tier limits and fair queueing.
- [Thinking effort](Thinking-Effort.md): effort levels, ceilings, requests, approvals and limitations.
- [Permissions and questions](Permissions-and-Questions.md): permission modes, approval requests, the lead's questions, the cards on the page.

## Interfaces and operation

- [Browser/server protocol](Browser-Server-Protocol.md): every message type in both directions, how the page uses them, and transcript items.
- [Configuration and settings](Configuration-and-Settings.md): every setting and environment variable, and when each takes effect.
- [Command-line launcher](Command-Line-Launcher.md): the `masthead` command.
- [Storage on disk](Storage-on-Disk.md): where files live, their format, and safe writing.
- [Security model](Security-Model.md): what the local server defends against (including the local secret) and what it does not.
- [Building, testing and installing](Building-Testing-Installing.md): npm scripts, output, the checks before a change is done.
- [Tests](Source-Tests.md): the unit tests, the live run, and the browser test.
- [Installing](Source-Install-Scripts.md): `scripts/install.sh`, `scripts/uninstall.sh` and `packaging/`.
- [Project documents](Project-Documents.md): `README.md`, `AGENTS.md`, `CLAUDE.md`.

## Server and shared source

- [shared/protocol.ts](Source-Shared-Protocol.md): types shared by server and browser; agent names; model names.
- [shared/toolline.ts](Source-Shared-Toolline.md): readable one-line descriptions of tool calls.
- [server/config.ts](Source-Config.md): paths, settings, finding Claude Code, the agents' environment.
- [server/scheduler.ts](Source-Scheduler.md): the slot scheduler.
- [server/store.ts](Source-Store.md): conversations on disk.
- [server/prompts.ts](Source-Prompts.md): system prompt additions and envelopes.
- [server/agent.ts](Source-Agent.md): one agent and its Claude Code session.
- [server/tools.ts](Source-Tools.md): the team tools.
- [server/conversation.ts](Source-Conversation.md): one conversation and the team rules.
- [server/app.ts](Source-App.md): the application, tabs, saving and approvals.
- [server/http.ts](Source-Http.md): HTTP, the WebSocket and the security checks.
- [server/main.ts](Source-Main.md): entry point and launcher, and `server/cli.ts` (command-line parsing).
- [Build configuration](Source-Build-Config.md): `package.json`, the tsconfig files, the Vite and Svelte config.

## Web source

- [Web front end](Source-Web-Front-End.md): files, layout (`App.svelte`), safe Markdown rendering.
- [Web store](Source-Web-Store.md): `store.svelte.ts`, the page's state and every protocol message.
- [Web components](Source-Web-Components.md): Sidebar, Transcript, Composer, FolderPicker, PermissionCard, TeamPanel, TeamMap, SettingsMenu.

## Walkthroughs

- [Sending a message](Walkthrough-Sending-a-Message.md): browser → lead → Claude Code → screen.
- [An agent starting another](Walkthrough-Starting-an-Agent.md): `spawn_agent` to a running child.
- [A report coming back](Walkthrough-Report-Coming-Back.md): a child finishing and waking its parent.
- [An effort request](Walkthrough-Effort-Request.md): `set_effort` to approval.
- [Stopping an agent](Walkthrough-Stopping-an-Agent.md): by the person, by an agent, at shutdown; interrupting the lead.
- [Restarting with saved conversations](Walkthrough-Restarting-the-App.md): shutdown, restore, resume.
