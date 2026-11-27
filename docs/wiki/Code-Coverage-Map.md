# Code coverage map

Every source file of Masthead 0.2.0 and the wiki page and section that explains it. This is a map for readers ("where is this file explained?"), not test coverage; for what the tests exercise see [Tests](Source-Tests.md).

`node docs/check-coverage.mjs` checks this page against the tree: it lists source files with no row, rows for files that no longer exist, and links to pages or headings that do not exist. A row whose path ends in `/**` covers every file under that folder (used for generated code). Run it after adding, moving or deleting a file, and before a release.

## Server: team rules (`server/core/`)

| File | Explained on | Also see |
|---|---|---|
| `server/core/conversation.ts` | [server/core/conversation.ts](Source-Core-Conversation.md): [ConversationHost](Source-Core-Conversation.md#conversationhost), [Clock](Source-Core-Conversation.md#clock), [Creating, restoring, saving](Source-Core-Conversation.md#creating-restoring-saving), [Actions by the person](Source-Core-Conversation.md#actions-by-the-person), [AgentHost implementation](Source-Core-Conversation.md#agenthost-implementation), [The state machine](Source-Core-Conversation.md#the-state-machine), [Clocks and the shared timer](Source-Core-Conversation.md#clocks-and-the-shared-timer), [Waiting for an answer](Source-Core-Conversation.md#waiting-for-an-answer), [TeamActions implementation](Source-Core-Conversation.md#teamactions-implementation), [Constants](Source-Core-Conversation.md#constants) | [State machine](State-Machine.md), [Team rules](Team-Rules.md) |
| `server/core/machine.ts` | [server/core/machine.ts](Source-Core-Machine.md): [Types](Source-Core-Machine.md#types), [Constants](Source-Core-Machine.md#constants), [Helpers](Source-Core-Machine.md#helpers), [step()](Source-Core-Machine.md#stepprev-ev-ctx) | [State machine](State-Machine.md) |
| `server/core/prompts.ts` | [server/core/prompts.ts](Source-Core-Prompts.md): [withArticle](Source-Core-Prompts.md#witharticlelabel), [PromptCaps](Source-Core-Prompts.md#type-promptcaps), [systemAppend](Source-Core-Prompts.md#systemappendopts), [reportEnvelope](Source-Core-Prompts.md#reportenvelopefrom-tier-status-text), [messageEnvelope](Source-Core-Prompts.md#messageenvelopefrom-tier-text-hint), [Escaping](Source-Core-Prompts.md#escaping-private-helpers) | [Safety model](Safety-Model.md) |
| `server/core/scheduler.ts` | [server/core/scheduler.ts](Source-Core-Scheduler.md): [SlotCancelled](Source-Core-Scheduler.md#class-slotcancelled-extends-error), [TierOff](Source-Core-Scheduler.md#class-tieroff-extends-error), [class Scheduler](Source-Core-Scheduler.md#class-scheduler) | [Slot scheduling](Slot-Scheduling.md) |
| `server/core/tools.ts` | [server/core/tools.ts](Source-Core-Tools.md): [TeamActions](Source-Core-Tools.md#teamactions), [teamToolDefs](Source-Core-Tools.md#teamtooldefsagent-team), [send_message and wait](Source-Core-Tools.md#send_message-and-wait) | [Team rules](Team-Rules.md) |

## Server: runtime and backends

| File | Explained on | Also see |
|---|---|---|
| `server/backends/claude/env.ts` | [env.ts](Source-Backend-Claude.md#envts) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/claude/mcp.ts` | [mcp.ts](Source-Backend-Claude.md#mcpts) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/claude/session.ts` | [session.ts](Source-Backend-Claude.md#sessionts) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/codex/cli.ts` | [Detection](Source-Backend-Codex.md#detection-detect), [Process-tree stop](Source-Backend-Codex.md#process-tree-stop) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/codex/families.ts` | [The generated Codex team](Source-Backend-Codex.md#the-generated-codex-team) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/codex/generate-protocol.mjs` | [What is experimental](Source-Backend-Codex.md#what-is-experimental) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/codex/index.ts` | [How Codex is driven](Source-Backend-Codex.md#how-codex-is-driven), [Events](Source-Backend-Codex.md#events) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/codex/protocol/**` | [What is experimental](Source-Backend-Codex.md#what-is-experimental) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/codex/rpc.ts` | [How Codex is driven](Source-Backend-Codex.md#how-codex-is-driven) | [Backend-Interface](Backend-Interface.md) |
| `server/backends/codex/testing/fake-app-server.ts` | [What was verified and how](Source-Backend-Codex.md#what-was-verified-and-how) | [Source-Tests](Source-Tests.md) |
| `server/backends/fake/index.ts` | [FakeBackend](Source-Backend-Fake.md#fakebackend-indexts), [FakeSession](Source-Backend-Fake.md#fakesession-indexts) | [Source-Tests](Source-Tests.md) |
| `server/backends/fake/script.ts` | [The script](Source-Backend-Fake.md#the-script-scriptts-plan), [Selection](Source-Backend-Fake.md#selection) | [Source-Tests](Source-Tests.md) |
| `server/backends/proctree.ts` | [server/backends/proctree.ts](Backend-Interface.md#serverbackendsproctreets) | [Source-Backend-Claude](Source-Backend-Claude.md) |
| `server/backends/registry.ts` | [server/backends/registry.ts](Backend-Interface.md#serverbackendsregistryts), [The generated Codex team](Source-Backend-Codex.md#the-generated-codex-team) | [Source-Backend-Codex](Source-Backend-Codex.md) |
| `server/backends/types.ts` | [server/backends/types.ts](Backend-Interface.md#serverbackendstypests) | [Source-Runtime](Source-Runtime.md) |
| `server/runtime/agent.ts` | [class Agent](Source-Runtime.md#class-agent-line-113), [Every rule kept from 0.1.x and where it lives now](Source-Runtime.md#every-rule-kept-from-01x-and-where-it-lives-now) | [Agent-Life-Cycle](Agent-Life-Cycle.md) |

## Server: app, transport and remote access

| File | Explained on | Also see |
|---|---|---|
| `server/app/app.ts` | [Source-App](Source-App.md): [handle](Source-App.md#handleclient-raw-the-gate), [remoteMessage](Source-App.md#remotemessage-remote-access-and-profile-messages), [dispatch](Source-App.md#dispatch-the-version-1-messages), [Validation helpers](Source-App.md#validation-helpers), [compaction](Source-App.md#compact-and-the-compaction-hooks) | [Security model](Security-Model.md) |
| `server/app/clients.ts` | [Source-Clients](Source-Clients.md): [admit](Source-Clients.md#admitclient-msg-the-gate), [Sessions](Source-Clients.md#sessions-version-0-1-and-2), [Rings](Source-Clients.md#rings-seq-byte-cap-and-epoch), [Drafts](Source-Clients.md#drafts-deltas-and-draft_end) | [Browser/server protocol](Browser-Server-Protocol.md) |
| `server/remote/access.ts` | [Source-Remote-Access](Source-Remote-Access.md): [setEnabled](Source-Remote-Access.md#setenabledon), [reconcile](Source-Remote-Access.md#reconcile), [state](Source-Remote-Access.md#state) | [Remote access](Remote-Access.md) |
| `server/remote/authorise.ts` | [Source-Remote-Access](Source-Remote-Access.md): [authorise](Source-Remote-Access.md#authorisefacts-deps), [allowedMessage](Source-Remote-Access.md#allowedmessagerole-type-and-the-role-table) | [Security model](Security-Model.md) |
| `server/remote/registry.ts` | [Source-Remote-Registry](Source-Remote-Registry.md): [Asking](Source-Remote-Registry.md#asking-requestid-address), [Checking a token](Source-Remote-Registry.md#checking-a-token-checknodeid-token-address-and-owneroftoken), [Audit log](Source-Remote-Registry.md#audit-log-audite-and-readauditlimit--100) | [Remote access](Remote-Access.md) |
| `server/remote/tailscale.ts` | [Source-Remote-Tailscale](Source-Remote-Tailscale.md): [The only commands](Source-Remote-Tailscale.md#the-only-commands-addcommand-and-removecommand), [serveStateFrom](Source-Remote-Tailscale.md#servestatefromjson-dnsname-port-target), [CachedWhois](Source-Remote-Tailscale.md#class-cachedwhois) | [Remote access](Remote-Access.md) |
| `server/transport/auth.ts` | [Source-Transport-Auth](Source-Transport-Auth.md): [loadSecret](Source-Transport-Auth.md#loadsecretfile--secret_file), [proofOf](Source-Transport-Auth.md#proofofsecret-port-nonce), [makePrivate](Source-Transport-Auth.md#makeprivatefile-platform-run-env) | [Security model](Security-Model.md) |
| `server/transport/blobs.ts` | [Source-Blobs](Source-Blobs.md): [BlobTokens](Source-Blobs.md#class-blobtokens), [handleBlobGet](Source-Blobs.md#handleblobgetreq-res-url-blobs-tokens-get-blobconvidsha256ttoken), [handleBlobPost](Source-Blobs.md#handleblobpostreq-res-url-blobs-authorised-convexists-post-blobconvconvid) | [Security model](Security-Model.md) |
| `server/transport/http.ts` | [Source-Http](Source-Http.md): [serve](Source-Http.md#serveapp-opts-promiseserver), [attach](Source-Http.md#attachapp-ws-tokens-remote), [serveStatic](Source-Http.md#servestaticroot-pathname-req-res-csp--csp) | [Security model](Security-Model.md) |
| `server/transport/remote.ts` | [Source-Transport-Remote](Source-Transport-Remote.md): [serveRemote](Source-Transport-Remote.md#serveremoteapp-access-opts), [chooseTarget](Source-Transport-Remote.md#choosetargetenv-datadir-platform-uid-home), [startRemote](Source-Transport-Remote.md#startremoteapp-access-opts) | [Remote access](Remote-Access.md) |

## Server: settings and storage

| File | Explained on | Also see |
|---|---|---|
| `server/paths.ts` | [server/paths.ts](Source-Paths.md): [appDirs](Source-Paths.md#appdirsplatform-env-home), [Constants](Source-Paths.md#constants) | [Platforms](Platforms.md#folders), [Source-Settings](Source-Settings.md) |
| `server/settings/settings.ts` | [server/settings/settings.ts and server/paths.ts](Source-Settings.md) | [Team profiles and settings](Team-Profiles-and-Settings.md), [Configuration and settings](Configuration-and-Settings.md) |
| `server/storage/atomic.ts` | [server/storage/](Source-Storage.md) | [Source-Storage-Format](Source-Storage-Format.md), [Storage on disk](Storage-on-Disk.md) |
| `server/storage/blobs.ts` | [server/storage/](Source-Storage.md) | [Source-Blobs](Source-Blobs.md), [Storage on disk](Storage-on-Disk.md) |
| `server/storage/images.ts` | [server/storage/](Source-Storage.md) | [Source-Blobs](Source-Blobs.md), [Storage on disk](Storage-on-Disk.md) |
| `server/storage/migrate.ts` | [server/storage/](Source-Storage.md) | [Source-Storage-Format](Source-Storage-Format.md), [Storage on disk](Storage-on-Disk.md) |
| `server/storage/store.ts` | [server/storage/](Source-Storage.md) | [Storage on disk](Storage-on-Disk.md) |
| `server/storage/transcript.ts` | [server/storage/](Source-Storage.md) | [Source-Storage-Format](Source-Storage-Format.md), [Storage on disk](Storage-on-Disk.md) |

## Server: launcher, service and platform

| File | Explained on | Also see |
|---|---|---|
| `server/cli.ts` | [server/cli.ts](Source-Cli.md): [signInDir](Source-Cli.md#signindirenv-datadir-platform), [onPath](Source-Cli.md#onpathcmd-env-platform-exists), [openSignedIn](Source-Cli.md#opensignedinopts) | [Platforms](Platforms.md#opening-the-browser-signed-in) |
| `server/doctor.ts` | [masthead doctor](Source-Doctor.md): [The checks](Source-Doctor.md#the-checks-in-order), [Output and exit code](Source-Doctor.md#output-and-exit-code) | [Command-line launcher](Command-Line-Launcher.md#doctor) |
| `server/main.ts` | [server/main.ts](Source-Main.md): [runServer()](Source-Main.md#runserver), [serviceCommand](Source-Main.md#servicecommandp), [doctorCommand](Source-Main.md#doctorcommandp) | [Command-line launcher](Command-Line-Launcher.md) |
| `server/service/awake.ts` | [Service](Source-Service.md): [Keep awake](Source-Service.md#keep-awake-awakets) | [Platforms](Platforms.md#keep-awake) |
| `server/service/common.ts` | [Service](Source-Service.md) | [Platforms](Platforms.md#background-service) |
| `server/service/index.ts` | [Service](Source-Service.md) | [Platforms](Platforms.md#background-service) |
| `server/service/launchd.ts` | [Service](Source-Service.md): [launchd.ts](Source-Service.md#launchdts) | [Platforms](Platforms.md#background-service) |
| `server/service/systemd.ts` | [Service](Source-Service.md): [systemd.ts](Source-Service.md#systemdts) | [Platforms](Platforms.md#background-service) |
| `server/service/taskscheduler.ts` | [Service](Source-Service.md): [taskscheduler.ts](Source-Service.md#taskschedulerts) | [Platforms](Platforms.md#background-service) |
| `server/service/types.ts` | [Service](Source-Service.md) | [Platforms](Platforms.md#background-service) |

## Shared

| File | Explained on | Also see |
|---|---|---|
| `shared/protocol-v2.ts` | [shared/protocol.ts and shared/protocol-v2.ts](Source-Shared-Protocol.md) | [Browser/server protocol](Browser-Server-Protocol.md), [Source-Clients](Source-Clients.md) |
| `shared/protocol.ts` | [shared/protocol.ts and shared/protocol-v2.ts](Source-Shared-Protocol.md) | [Team profiles and settings](Team-Profiles-and-Settings.md) |
| `shared/toolline.ts` | [shared/toolline.ts](Source-Shared-Toolline.md) | |

## Web page

| File | Explained on | Also see |
|---|---|---|
| `web/index.html` | [Web Front End](Source-Web-Front-End.md#the-page-shell-indexhtml) |  |
| `web/public/favicon.svg` | [Web Styles](Source-Web-Styles.md#webpublicfaviconsvg) |  |
| `web/src/App.svelte` | [Web Front End](Source-Web-Front-End.md#layout-appsvelte) |  |
| `web/src/app.css` | [Web Styles](Source-Web-Styles.md#websrcappcss) |  |
| `web/src/lib/Composer.svelte` | [Web Components](Source-Web-Components.md#composersvelte) |  |
| `web/src/lib/FirstRun.svelte` | [Web Components](Source-Web-Components.md#firstrunsvelte) |  |
| `web/src/lib/FolderPicker.svelte` | [Web Components](Source-Web-Components.md#folderpickersvelte) |  |
| `web/src/lib/PermissionCard.svelte` | [Web Components](Source-Web-Components.md#permissioncardsvelte) |  |
| `web/src/lib/SettingsMenu.svelte` | [Web Components](Source-Web-Components.md#settingsmenusvelte) |  |
| `web/src/lib/SettingsView.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#settingsviewsvelte) |  |
| `web/src/lib/Sidebar.svelte` | [Web Components](Source-Web-Components.md#sidebarsvelte) |  |
| `web/src/lib/StopControl.svelte` | [Web Components](Source-Web-Components.md#stopcontrolsvelte) |  |
| `web/src/lib/TeamPanel.svelte` | [Web Components](Source-Web-Components.md#teampanelsvelte) |  |
| `web/src/lib/Transcript.svelte` | [Web Components](Source-Web-Components.md#transcriptsvelte) |  |
| `web/src/lib/UsageMeter.svelte` | [Web Components](Source-Web-Components.md#usagemetersvelte) |  |
| `web/src/lib/images.ts` | [Web Images](Source-Web-Images.md#imagests) |  |
| `web/src/lib/images/ImageViewer.svelte` | [Web Images](Source-Web-Images.md#imageviewersvelte) |  |
| `web/src/lib/images/Thumbs.svelte` | [Web Images](Source-Web-Images.md#thumbssvelte) |  |
| `web/src/lib/markdown.ts` | [Web Front End](Source-Web-Front-End.md#rendering-markdown-safely-markdownts) |  |
| `web/src/lib/remote/DeviceRequestCard.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#devicerequestcardsvelte) |  |
| `web/src/lib/remote/RemoteSection.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#remotesectionsvelte) |  |
| `web/src/lib/remote/RemoteSignIn.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#remotesigninsvelte) |  |
| `web/src/lib/remote/text.ts` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#remotetextts) |  |
| `web/src/lib/remote/types.ts` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#remotetypests) |  |
| `web/src/lib/settings/BackendsSection.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#backendssectionsvelte) |  |
| `web/src/lib/settings/ProfileChip.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#profilechipsvelte) |  |
| `web/src/lib/settings/ProfilesSection.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#profilessectionsvelte) |  |
| `web/src/lib/settings/TeamEditor.svelte` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#teameditorsvelte) |  |
| `web/src/lib/settings/logic.ts` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#settingslogicts) |  |
| `web/src/lib/settings/text.ts` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#settingstextts) |  |
| `web/src/lib/settings/types.ts` | [Web Settings and Remote](Source-Web-Settings-and-Remote.md#settingstypests) |  |
| `web/src/lib/signin.ts` | [Web Front End](Source-Web-Front-End.md#signing-in) |  |
| `web/src/lib/state/pure.ts` | [Web Store](Source-Web-Store.md#pure-helpers-websrclibstatepurets) |  |
| `web/src/lib/store.svelte.ts` | [Web Store](Source-Web-Store.md#web-store-websrclibstoresveltets) |  |
| `web/src/lib/team/CompactCard.svelte` | [Web Components](Source-Web-Components.md#compactcardsvelte) |  |
| `web/src/lib/team/CompactProgress.svelte` | [Web Components](Source-Web-Components.md#compactprogresssvelte) |  |
| `web/src/lib/team/Expander.svelte` | [Web Components](Source-Web-Components.md#expandersvelte) |  |
| `web/src/lib/team/TeamOutline.svelte` | [Web Components](Source-Web-Components.md#teamoutlinesvelte) |  |
| `web/src/lib/team/TierControls.svelte` | [Web Components](Source-Web-Components.md#tiercontrolssvelte) |  |
| `web/src/lib/team/outline.ts` | [Web Components](Source-Web-Components.md#outlinets) |  |
| `web/src/lib/text.ts` | [Web Text](Source-Web-Text.md#textts) |  |
| `web/src/lib/tiers.ts` | [Web Styles](Source-Web-Styles.md#tier-colours-tiersts) |  |
| `web/src/lib/tools.ts` | [Web Front End](Source-Web-Front-End.md#toolsts) |  |
| `web/src/lib/transcript/DraftView.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/transcript/InboundItem.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/transcript/NoticeItem.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/transcript/StatusLine.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/transcript/TextItem.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/transcript/ThinkingItem.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/transcript/ToolItem.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/transcript/UserItem.svelte` | [Web Components](Source-Web-Components.md#transcript-items) |  |
| `web/src/lib/ui.svelte.ts` | [Web Front End](Source-Web-Front-End.md#simple-and-advanced-uisveltets) |  |
| `web/src/lib/words.ts` | [Web Text](Source-Web-Text.md#wordsts) |  |
| `web/src/main.ts` | [Web Front End](Source-Web-Front-End.md#the-entry-script-maints) |  |
| `web/test/compact.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/device.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/no-inline-text.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/draft.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/markdown.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/permission-card.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/pure.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/remote-section.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/remote-signin.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/restricted-device.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/settings-components.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/settings-fixtures.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/settings-logic.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/setup.ts` | [Web Tests](Source-Web-Tests.md#vitestconfigts-and-setupts) |  |
| `web/test/signin.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/store-v2.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/store.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/team-outline.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/team-shots.mjs` | [Web Tests](Source-Web-Tests.md#team-screenshots-team-shotsmjs) |  |
| `web/test/text.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/tiers.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/transcript.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/test/words.test.ts` | [Web Tests](Source-Web-Tests.md#test-files) |  |
| `web/vitest.config.ts` | [Web Tests](Source-Web-Tests.md#vitestconfigts-and-setupts) |  |

## Build, install, packaging and CI

| File | Explained on | Also see |
|---|---|---|
| `.github/workflows/ci.yml` | [CI](Source-CI.md): [When it runs](Source-CI.md#when-it-runs), [Job test](Source-CI.md#job-test-check-tests-build-and-a-pack-and-install), [Job browser](Source-CI.md#job-browser-the-real-page-on-the-fake-backend) | [Platforms](Platforms.md#what-ci-proves-and-what-needs-a-real-machine) |
| `.github/workflows/release.yml` | [CI](Source-CI.md): [The release workflow](Source-CI.md#the-release-workflow) | [Building, testing and installing](Building-Testing-Installing.md#installing-from-a-release) |
| `package-lock.json` | [Build configuration](Source-Build-Config.md): [package-lock.json](Source-Build-Config.md#package-lockjson) | [CI](Source-CI.md#why-a-plain-npm-ci) |
| `package.json` | [Build configuration](Source-Build-Config.md): [package.json](Source-Build-Config.md#packagejson), [Optional packages](Source-Build-Config.md#optional-packages), [Scripts](Source-Build-Config.md#scripts), [Dependencies](Source-Build-Config.md#dependencies) | [Building, testing and installing](Building-Testing-Installing.md#npm-scripts) |
| `packaging/README.md` | [Installing](Source-Install-Scripts.md): [The packaging files](Source-Install-Scripts.md#the-packaging-files) | |
| `packaging/aur/PKGBUILD` | [Installing](Source-Install-Scripts.md): [The packaging files](Source-Install-Scripts.md#the-packaging-files) | |
| `packaging/homebrew/masthead.rb` | [Installing](Source-Install-Scripts.md): [The packaging files](Source-Install-Scripts.md#the-packaging-files) | |
| `packaging/masthead.desktop` | [Installing](Source-Install-Scripts.md): [The packaging files](Source-Install-Scripts.md#the-packaging-files) | |
| `packaging/masthead.svg` | [Installing](Source-Install-Scripts.md): [The packaging files](Source-Install-Scripts.md#the-packaging-files) | |
| `packaging/scoop/masthead.json` | [Installing](Source-Install-Scripts.md): [The packaging files](Source-Install-Scripts.md#the-packaging-files) | |
| `scripts/ci-e2e.mjs` | [CI](Source-CI.md): [scripts/ci-e2e.mjs step by step](Source-CI.md#scriptsci-e2emjs-step-by-step) | [Building, testing and installing](Building-Testing-Installing.md#browser-test-on-the-fake-backend) |
| `scripts/install.sh` | [Installing](Source-Install-Scripts.md): [What install.sh does](Source-Install-Scripts.md#what-installsh-does) | [Building, testing and installing](Building-Testing-Installing.md#installing-from-source) |
| `scripts/path.sh` | [Installing](Source-Install-Scripts.md): [path.sh](Source-Install-Scripts.md#pathsh) | |
| `scripts/uninstall.sh` | [Installing](Source-Install-Scripts.md): [What uninstall.sh does](Source-Install-Scripts.md#what-uninstallsh-does) | |
| `svelte.config.js` | [Build configuration](Source-Build-Config.md): [svelte.config.js](Source-Build-Config.md#svelteconfigjs) | |
| `tsconfig.server.json` | [Build configuration](Source-Build-Config.md): [tsconfig.server.json](Source-Build-Config.md#tsconfigserverjson) | |
| `tsconfig.web.json` | [Build configuration](Source-Build-Config.md): [tsconfig.web.json](Source-Build-Config.md#tsconfigwebjson) | |
| `vite.config.ts` | [Build configuration](Source-Build-Config.md): [vite.config.ts](Source-Build-Config.md#viteconfigts) | [Building, testing and installing](Building-Testing-Installing.md#development-set-up) |
| `web/vitest.config.ts` | [Build configuration](Source-Build-Config.md): [web/vitest.config.ts](Source-Build-Config.md#webvitestconfigts) | [Tests](Source-Tests.md) |

## Tests

| File | Explained on | Also see |
|---|---|---|
| `test/compact-app.test.ts` | [Tests](Source-Tests.md), [Source-App](Source-App.md): [compaction](Source-App.md#compact-and-the-compaction-hooks) | [Remote access](Remote-Access.md) |
| `test/compact.live.ts` | [Claude Code: test/compact.live.ts](Live-Tests.md#claude-code-testcompactlivets) | [Source-Runtime](Source-Runtime.md#compaction-compact) |
| `test/ui.e2e.mjs` | [Web tests](Source-Web-Tests.md) | [Tests](Source-Tests.md) |
| `test/agent.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/app.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/awake-app.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/awake.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/backend-conformance.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/backpressure.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/characterisation.test.ts` | [Tests](Source-Tests.md) | [Storage on disk](Storage-on-Disk.md) |
| `test/codex-app.live.ts` | [Codex: `test/codex-app.live.ts`](Live-Tests.md#codex-testcodex-applivets) | [Source-Backend-Codex](Source-Backend-Codex.md#running-the-codex-live-tests) |
| `test/codex-proctree.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/codex-team.live.ts` | [Codex: `test/codex-team.live.ts](Live-Tests.md#codex-testcodex-teamlivets) | [Source-Tests](Source-Tests.md) |
| `test/codex.live.ts` | [Codex: `test/codex.live.ts](Live-Tests.md#codex-testcodexlivets) | [Source-Tests](Source-Tests.md) |
| `test/codex.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/conversation.test.ts` | [Tests](Source-Tests.md) | [server/core/conversation.ts](Source-Core-Conversation.md) |
| `test/doctor.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/fake-backend.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/fixtures/**` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/http.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/launcher.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/live.e2e.ts` | [Claude Code: `test/live.e2e.ts](Live-Tests.md#claude-code-testlivee2ets) | [Source-Tests](Source-Tests.md) |
| `test/machine.test.ts` | [Tests](Source-Tests.md) | [State machine](State-Machine.md) |
| `test/platform.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/proctree.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/prompts.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/protocol-v1.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/protocol-v2.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/registry.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/remote-wiring.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/remote.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/send-images.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/service.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/settings.test.ts` | [Tests](Source-Tests.md) | [Source-Settings](Source-Settings.md) |
| `test/storage-wiring.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/storage.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |
| `test/unit.test.ts` | [Server tests (`npm test`)](Source-Tests.md#server-tests-npm-test) | [Source-Tests](Source-Tests.md) |

## Related pages

[Architecture](Architecture.md) · [Index](Index.md) · [Tests](Source-Tests.md)
