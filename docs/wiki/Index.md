# Index

Every page in this wiki for Masthead 0.2.0, grouped. Start at [Home](Home.md). The plain-language user guide is separate, in [`docs/guide/`](../guide/README.md).

## Start here

- [Home](Home.md): what Masthead is, a diagram of the whole, known limitations in 0.2.0, a map of the wiki.
- [Architecture](Architecture.md): the folders, which part owns what, the seams, and how a message travels from the page to an agent and back.
- [Glossary](Glossary.md): every term used in the code and the wiki, in alphabetical order.
- [Code coverage map](Code-Coverage-Map.md): every source file and the page and section that explains it.
- [Project documents](Project-Documents.md): `README.md`, `AGENTS.md` and `CLAUDE.md` at the top of the project.

## Security and safety

- [Security model](Security-Model.md): who can reach the server (local and remote listeners, the local secret, device checks) and what it does not defend against.
- [Safety model](Safety-Model.md): how the agent team is kept bounded, visible and stoppable, and what that does not protect against.
- [Permissions and questions](Permissions-and-Questions.md): how Claude Code's and Codex's approval requests and the lead's questions reach the person, and permission modes.

## How it works

- [State machine](State-Machine.md): one `AgentState` per agent, changed only by `step()` in `server/core/machine.ts`; events, effects and the shell around it.
- [Agent life cycle](Agent-Life-Cycle.md): one agent from start to end from the runtime's and backend's side: processes, turns, background work, resume.
- [Team rules](Team-Rules.md): the rules of a team and where each is enforced in `Conversation`.
- [Slot scheduling](Slot-Scheduling.md): per-tier limits across all conversations and fair sharing of free places.
- [Thinking effort](Thinking-Effort.md): effort levels, ceilings, requests, approvals and known limitations.
- [Backend interface](Backend-Interface.md): the seam in `server/backends/types.ts` and the registry; what a backend does and does not do.

## Team profiles and settings

- [Team profiles and settings](Team-Profiles-and-Settings.md): profiles as data, settings version 2, the built-in Claude and Codex profiles, migration from 0.1.x.
- [Configuration and settings](Configuration-and-Settings.md): every setting and environment variable, and when each takes effect.

## Interfaces and operation

- [Browser/server protocol](Browser-Server-Protocol.md): the WebSocket at `/ws` and the `/blob` routes; protocol version 2 and the version 1 adapter.
- [Command-line launcher](Command-Line-Launcher.md): the `masthead` command, signing the browser in, `service` and `doctor`.
- [Storage on disk](Storage-on-Disk.md): where settings and data live, their format, safe writing, what a 0.1.x install keeps.
- [Platforms](Platforms.md): everything the code does differently on Linux, macOS and Windows, and what still needs a real machine.
- [Remote access](Remote-Access.md): using Masthead from another device on your own Tailscale network: the switch, pairing, roles, tokens.
- [Using Masthead from your phone](Using-Masthead-From-Your-Phone.md): the first real use of remote access, step by step.
- [Building, testing and installing](Building-Testing-Installing.md): npm scripts, build output, the checks before a change is done, installing on each system.
- [Live tests](Live-Tests.md): the tests that drive the real agent CLIs, per backend, and what they cost.

## Server source by folder

### core

- [server/core/conversation.ts](Source-Core-Conversation.md): one conversation and its team; the shell around the state machine that owns the team rules.
- [server/core/machine.ts](Source-Core-Machine.md): the pure life-cycle state machine, `step(state, event, ctx)`.
- [server/core/scheduler.ts](Source-Core-Scheduler.md): slots per tier across all conversations, and who goes next.
- [server/core/prompts.ts](Source-Core-Prompts.md): the system-prompt text Masthead adds and the envelopes for reports and messages.
- [server/core/tools.ts](Source-Core-Tools.md): the backend-neutral team tools (`spawn_agent`, `send_message`, …) and `TeamActions`.

### runtime and backends

- [server/runtime/agent.ts](Source-Runtime.md): one team member on any backend; turns neutral session events into items, drafts, status and usage.
- [Claude Code backend](Source-Backend-Claude.md): `server/backends/claude/`, one Agent SDK `query()` per session.
- [Codex backend](Source-Backend-Codex.md): `server/backends/codex/`, the signed-in Codex CLI through `codex app-server`; what is experimental.
- [Fake backend](Source-Backend-Fake.md): `server/backends/fake/`, the scripted backend for unit tests, the browser test and CI.

### app, transport and remote

- [server/app/app.ts](Source-App.md): `App`, the composition root: settings, conversations, scheduler, backends, approvals, remote access.
- [server/app/clients.ts](Source-Clients.md): the `Hub`: browser tabs, their protocol version, subscriptions and what each is sent.
- [server/transport/http.ts](Source-Http.md): the local listener on `127.0.0.1`: static page, `/api/*`, `/blob`, `/ws`, the local security checks.
- [server/transport/auth.ts](Source-Transport-Auth.md): the local secret, the proof built from it, and making files private per platform.
- [server/transport/remote.ts](Source-Transport-Remote.md): the private listener that only your own `tailscale serve` reaches.
- [server/remote/access.ts and authorise.ts](Source-Remote-Access.md): remote access as a whole, and the per-request decision of who a remote caller is.
- [server/remote/registry.ts](Source-Remote-Registry.md): approved devices: pairing codes, roles, tokens, expiry, revocation, audit log.
- [server/remote/tailscale.ts](Source-Remote-Tailscale.md): the Tailscale side, behind one interface; Masthead's own `tailscale serve` entry only.

### settings, storage and paths

- [server/settings/settings.ts](Source-Settings.md): default settings, checking and migrating settings, the built-in team profiles.
- [server/paths.ts](Source-Paths.md): where settings and data are kept on each platform; the default port.
- [server/storage/](Source-Storage.md): conversations, transcripts, images, format versions and crash-safe writes, file by file.
- [Storage format](Source-Storage-Format.md): the 0.2.0 format version and migration, paged transcript reading, Windows-safe renames.
- [Pictures (blobs)](Source-Blobs.md): `storage/images.ts`, `storage/blobs.ts` and `transport/blobs.ts`: storing and serving images by hash.

### launcher, service, doctor and CI

- [server/main.ts](Source-Main.md): the entry point and the `masthead` command.
- [server/cli.ts](Source-Cli.md): command-line parsing and the browser sign-in step, kept testable.
- [server/doctor.ts](Source-Doctor.md): `masthead doctor`, a fixed list of set-up checks.
- [server/service/](Source-Service.md): the login service per platform (systemd, launchd, Task Scheduler) and keep-awake.
- [Install scripts](Source-Install-Scripts.md): `scripts/install.sh`, `scripts/uninstall.sh` and `packaging/`.
- [Build configuration](Source-Build-Config.md): `package.json`, the tsconfig files, Vite, Svelte and Vitest config.
- [CI](Source-CI.md): `.github/workflows/ci.yml`, `scripts/ci-e2e.mjs`, and what a green run does and does not prove.

## Shared source

- [shared/protocol.ts](Source-Shared-Protocol.md): types and helpers shared by server and page (`protocol.ts`, `protocol-v2.ts`).
- [shared/toolline.ts](Source-Shared-Toolline.md): one readable line for a tool call.

## Web source

- [Web front end](Source-Web-Front-End.md): the Svelte 5 page in `web/`, its files and layout, safe Markdown rendering.
- [Web store](Source-Web-Store.md): `store.svelte.ts`, everything the page knows, kept in step over the WebSocket.
- [Web components](Source-Web-Components.md): the Svelte components in `web/src/lib/`.
- [Web styles](Source-Web-Styles.md): `app.css`, the layout grid, the tab icon and the page's build config.

## Walkthroughs

- [Sending a message](Walkthrough-Sending-a-Message.md): the person's message from the browser to the lead's backend and back to every tab.
- [An agent starting another](Walkthrough-Starting-an-Agent.md): `spawn_agent` from the lead to a running `bravo`.
- [A report coming back](Walkthrough-Report-Coming-Back.md): a child finishing and its report reaching a waiting parent.
- [An effort request](Walkthrough-Effort-Request.md): `set_effort` from a Sonnet agent to its parent's approval.
- [Stopping an agent](Walkthrough-Stopping-an-Agent.md): the five ways an agent is stopped, and interrupting the lead.
- [Restarting with saved conversations](Walkthrough-Restarting-the-App.md): shutdown while agents work, restore, and continuing.

## Tests

- [Tests](Source-Tests.md): what each file in `test/` and `web/test/` covers and how it runs.
- [Live tests](Live-Tests.md): the account-spending runs against real Claude Code and Codex.

Related pages: [Home](Home.md) · [Code coverage map](Code-Coverage-Map.md) · [Glossary](Glossary.md)
