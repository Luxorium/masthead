# Code coverage map

Every tracked source file of Masthead 0.1.3, and the wiki page and section that explains it. This is a map for readers ("where is this file explained?"), not test coverage; for which code the tests exercise, see [Tests](Source-Tests.md#not-covered-by-the-unit-tests).

The list of files is `git ls-files server shared web/src web/index.html web/public scripts packaging test vite.config.ts svelte.config.js tsconfig.*.json package.json`, taken at 0.1.3. A file added later and missing here is a gap in the wiki.

## Server

| File | Explained on | Also see |
|---|---|---|
| `server/agent.ts` | [server/agent.ts](Source-Agent.md): [AgentHost](Source-Agent.md#agenthost), [TurnOutcome](Source-Agent.md#turnoutcome), [Channel](Source-Agent.md#channelt), [Helpers](Source-Agent.md#helpers), [class Agent](Source-Agent.md#class-agent), [launch() in detail](Source-Agent.md#launch-in-detail) | [Agent life cycle](Agent-Life-Cycle.md) |
| `server/conversation.ts` | [server/conversation.ts](Source-Conversation.md): [ConversationHost](Source-Conversation.md#conversationhost), [Creating, restoring, saving](Source-Conversation.md#creating-restoring-saving), [Actions by the person](Source-Conversation.md#actions-by-the-person), [AgentHost implementation](Source-Conversation.md#agenthost-implementation), [Reports](Source-Conversation.md#reports), [Waiting for an answer](Source-Conversation.md#waiting-for-an-answer), [TeamActions implementation](Source-Conversation.md#teamactions-implementation) | [Team rules](Team-Rules.md), [Thinking effort](Thinking-Effort.md) |
| `server/scheduler.ts` | [server/scheduler.ts](Source-Scheduler.md): [SlotCancelled](Source-Scheduler.md#class-slotcancelled-extends-error), [TierOff](Source-Scheduler.md#class-tieroff-extends-error), [class Scheduler](Source-Scheduler.md#class-scheduler) | [Slot scheduling](Slot-Scheduling.md) |
| `server/tools.ts` | [server/tools.ts](Source-Tools.md): [TeamActions](Source-Tools.md#teamactions), [teamTools](Source-Tools.md#teamtoolsagent-team), [send_message and wait](Source-Tools.md#send_message-and-wait) | [Team rules](Team-Rules.md) |
| `server/prompts.ts` | [server/prompts.ts](Source-Prompts.md): [withArticle](Source-Prompts.md#witharticlelabel), [systemAppend](Source-Prompts.md#systemappend-tier-name-parentname-settings-effort-), [reportEnvelope](Source-Prompts.md#reportenvelopefrom-tier-status-text), [messageEnvelope](Source-Prompts.md#messageenvelopefrom-tier-text-hint), [Escaping](Source-Prompts.md#escaping) | [Safety model](Safety-Model.md) |
| `server/store.ts` | [server/store.ts](Source-Store.md): [Types](Source-Store.md#types), [Id safety](Source-Store.md#id-safety), [class Store](Source-Store.md#class-store) | [Storage on disk](Storage-on-Disk.md) |
| `server/config.ts` | [server/config.ts](Source-Config.md): [Constants](Source-Config.md#constants), [Functions](Source-Config.md#functions) | [Configuration and settings](Configuration-and-Settings.md), [Security model](Security-Model.md) |
| `server/app.ts` | [server/app.ts](Source-App.md): [ConversationHost implementation](Source-App.md#conversationhost-implementation), [Saving](Source-App.md#saving), [Tabs](Source-App.md#tabs), [dispatch()](Source-App.md#dispatch), [Validation helpers](Source-App.md#validation-helpers) | [Browser/server protocol](Browser-Server-Protocol.md), [Permissions and questions](Permissions-and-Questions.md) |
| `server/http.ts` | [server/http.ts](Source-Http.md): [serve()](Source-Http.md#serveapp-opts-promiseserver), [serveStatic()](Source-Http.md#servestaticroot-pathname-req-res) | [Security model](Security-Model.md) |
| `server/main.ts` | [server/main.ts](Source-Main.md): [Functions](Source-Main.md#functions), [open](Source-Main.md#control-flow-of-open), [stop](Source-Main.md#control-flow-of-stop) | [Command-line launcher](Command-Line-Launcher.md#commands) |
| `server/cli.ts` | [server/cli.ts](Source-Cli.md#exports-at-a-glance) | [Command-line launcher](Command-Line-Launcher.md) |

## Shared

| File | Explained on | Also see |
|---|---|---|
| `shared/protocol.ts` | [shared/protocol.ts](Source-Shared-Protocol.md): [Version](Source-Shared-Protocol.md#version), [Tiers](Source-Shared-Protocol.md#tiers), [Agent names](Source-Shared-Protocol.md#agent-names), [Effort](Source-Shared-Protocol.md#effort), [Settings](Source-Shared-Protocol.md#settings), [Agents](Source-Shared-Protocol.md#agents), [Transcripts](Source-Shared-Protocol.md#transcripts) | [Browser/server protocol](Browser-Server-Protocol.md) |
| `shared/toolline.ts` | [shared/toolline.ts](Source-Shared-Toolline.md): [ToolLine](Source-Shared-Toolline.md#toolline), [toolLine()](Source-Shared-Toolline.md#toollinename-input-live--false) | |

## Web page

| File | Explained on |
|---|---|
| `web/index.html` | [Web front end: the page shell](Source-Web-Front-End.md#the-page-shell-indexhtml) |
| `web/src/main.ts` | [Web front end: the entry script](Source-Web-Front-End.md#the-entry-script-maints) |
| `web/src/App.svelte` | [Web front end: layout](Source-Web-Front-End.md#layout-appsvelte); grid in [Web styles](Source-Web-Styles.md#layout-regions-websrcappsvelte) |
| `web/src/app.css` | [Web styles](Source-Web-Styles.md#websrcappcss) |
| `web/public/favicon.svg` | [Web styles](Source-Web-Styles.md#webpublicfaviconsvg) |
| `web/src/lib/store.svelte.ts` | [Web store](Source-Web-Store.md) |
| `web/src/lib/markdown.ts` | [Web front end: rendering Markdown safely](Source-Web-Front-End.md#rendering-markdown-safely-markdownts) |
| `web/src/lib/tools.ts` | [Web front end: tools.ts](Source-Web-Front-End.md#toolsts) |
| `web/src/lib/Sidebar.svelte` | [Web components](Source-Web-Components.md#sidebarsvelte) |
| `web/src/lib/Transcript.svelte` | [Web components](Source-Web-Components.md#transcriptsvelte) |
| `web/src/lib/Composer.svelte` | [Web components](Source-Web-Components.md#composersvelte) |
| `web/src/lib/FolderPicker.svelte` | [Web components](Source-Web-Components.md#folderpickersvelte) |
| `web/src/lib/PermissionCard.svelte` | [Web components](Source-Web-Components.md#permissioncardsvelte) |
| `web/src/lib/TeamPanel.svelte` | [Web components](Source-Web-Components.md#teampanelsvelte) |
| `web/src/lib/SettingsMenu.svelte` | [Web components](Source-Web-Components.md#settingsmenusvelte) |
| `web/src/lib/StopControl.svelte` | [Web components](Source-Web-Components.md#stopcontrolsvelte) |
| `web/src/lib/TeamMap.svelte` | [Web components](Source-Web-Components.md#teammapsvelte) |

## Build, install and packaging

| File | Explained on | Also see |
|---|---|---|
| `package.json` | [Build configuration](Source-Build-Config.md#packagejson) | [npm scripts](Building-Testing-Installing.md#npm-scripts), [development set-up](Building-Testing-Installing.md#development-set-up) |
| `tsconfig.server.json` | [Build configuration](Source-Build-Config.md#tsconfigserverjson) | |
| `tsconfig.web.json` | [Build configuration](Source-Build-Config.md#tsconfigwebjson) | [Web styles](Source-Web-Styles.md#tsconfigwebjson) |
| `vite.config.ts` | [Build configuration](Source-Build-Config.md#viteconfigts) | [Web styles](Source-Web-Styles.md#viteconfigts) |
| `svelte.config.js` | [Build configuration](Source-Build-Config.md#svelteconfigjs) | [Web styles](Source-Web-Styles.md#svelteconfigjs) |
| `scripts/install.sh` | [Installing: what install.sh does](Source-Install-Scripts.md#what-installsh-does) | [Building, testing and installing](Building-Testing-Installing.md) |
| `scripts/uninstall.sh` | [Installing: what uninstall.sh does](Source-Install-Scripts.md#what-uninstallsh-does) | |
| `packaging/masthead.desktop` | [Installing: the packaging files](Source-Install-Scripts.md#the-packaging-files) | |
| `packaging/masthead.svg` | [Installing: the packaging files](Source-Install-Scripts.md#the-packaging-files) | |

## Tests

| File | Explained on |
|---|---|
| `test/unit.test.ts` | [Tests: unit tests](Source-Tests.md#unit-tests) |
| `test/agent.test.ts` | [Tests: unit tests](Source-Tests.md#unit-tests) |
| `test/conversation.test.ts` | [Tests: unit tests](Source-Tests.md#unit-tests) |
| `test/app.test.ts` | [Tests: unit tests](Source-Tests.md#unit-tests) |
| `test/http.test.ts` | [Tests: unit tests](Source-Tests.md#unit-tests) |
| `test/launcher.test.ts` | [Tests: unit tests](Source-Tests.md#unit-tests) |
| `test/live.e2e.ts` | [Tests: live end-to-end run](Source-Tests.md#live-end-to-end-run-testlivee2ets) |
| `test/ui.e2e.mjs` | [Tests: the browser test](Source-Tests.md#the-26-checks) |

## Related pages

[Home](Home.md) · [Index](Index.md) · [Architecture](Architecture.md)
