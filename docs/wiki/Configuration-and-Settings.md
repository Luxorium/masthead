# Configuration and settings

Masthead is configured in two ways: **settings**, which the person changes in the browser's sidebar and which are saved to disk, and **environment variables and command-line options**, which are read when the program starts. Code: `server/config.ts` and `Settings` in `shared/protocol.ts`.

## Settings

Saved in `~/.config/masthead/settings.json` (see [Storage on disk](Storage-on-Disk.md)). The page's team panel edits them; see [Web components](Source-Web-Components.md#teampanelsvelte). The shape is `Settings`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `tiers.lead.model` | string | `claude-fable-5-2` | Model id for the lead. Re-read every time the lead's process starts. The name shown for each tier everywhere comes from this id (`modelLabel()`). |
| `tiers.opus.model` | string | `claude-opus-5-5` | Model id for Opus agents, fixed when each agent is created. |
| `tiers.sonnet.model` | string | `claude-sonnet-5-5` | Same, Sonnet. |
| `tiers.haiku.model` | string | `claude-haiku-5-5` | Same, Haiku. |
| `tiers.<tier>.effort` | `low`/`medium`/`high`/`xhigh` | lead `xhigh`, opus `xhigh`, sonnet `high`, haiku `medium` | With automatic effort on: the highest level the tier may reach. Off: the level it runs at. See [Thinking effort](Thinking-Effort.md). |
| `tiers.<tier>.max` | integer 0–12 | lead 1 (ignored), opus 3, sonnet 4, haiku 4 | How many agents of the tier may run at once, app-wide. 0 switches the tier off. See [Slot scheduling](Slot-Scheduling.md). |
| `permissionMode` | `inherit`/`default`/`acceptEdits`/`auto`/`bypassPermissions` | `inherit` | Claude Code permission mode for all agents. `inherit` uses the person's own Claude Code settings. See [Permissions and questions](Permissions-and-Questions.md). |
| `autoEffort` | boolean | `true` | Automatic effort: agents start low and manage their effort with tools. |
| `leanSubagents` | boolean | `true` | Sonnet and Haiku agents skip the person's own MCP servers (`strictMcpConfig`), which keeps their context small. |
| `leanOpus` | boolean | `true` | Opus agents skip them too. The lead always loads them. |
| `collapseReports` | boolean | `false` | Reports from agents are shown folded shut in a transcript until the person opens them (a display setting only; `web/src/lib/Transcript.svelte`). |
| `defaultCwd` | absolute path | the home folder | The folder a new conversation starts in. Updated automatically when a new conversation is started in a different folder. |

An **MCP server** (Model Context Protocol) is an add-on that gives Claude Code extra tools. Masthead itself provides one, named `masthead`, holding the team tools; "lean" agents get only that one.

### How settings are checked

`sanitizeSettings(raw, base)` always returns valid settings, whatever it is given: it starts from a copy of `base` and copies over only fields that pass. For the settings file `base` is `defaultSettings()`; for settings sent by a browser it is the **current** settings, so a partial update (say `{collapseReports: true}`) changes only what it names and an invalid field keeps its current value. The checks:

- model: a string of 1–80 characters from letters, digits and `. _ - [ ] :`;
- effort: one of the four levels;
- max: a number, truncated and clamped to 0–12 (`MAX_PER_TIER`); the lead's `max` is never taken;
- permissionMode: one of the five choices;
- autoEffort, leanSubagents, leanOpus, collapseReports: booleans;
- defaultCwd: a string starting with `/`.

It is used both when loading the file (`loadSettings()`; an unreadable file gives the defaults) and when a browser sends new settings. The settings file used by `App` can be changed with its `settingsFile` option; the tests use this.

### When a change takes effect

`App.updateSettings()` saves the file (a failed write is logged once and the new settings still apply), calls `scheduler.limitsChanged()` so queued agents start if a limit went up, or fail if their tier went to 0, and broadcasts the new settings. Beyond that, each setting is read at a particular moment:

| Setting | Read when |
|---|---|
| `max` | Each time a slot is requested or freed. Lowering does not stop running agents (known limitation). Setting a tier to 0 fails the agents of that tier still waiting in the queue (`TierOff`, see [Slot scheduling](Slot-Scheduling.md)) and stops finished ones from being woken. |
| Lead model, permission mode, lean sub-agents and lean Opus, effort ceiling | Each time an agent's process is launched (`Agent.launch`). A running process keeps what it started with; lowering a ceiling does not lower running agents (known limitation). |
| Sub-agent model | When the agent is created (`spawn`). |
| `autoEffort` | Tool list: at launch. Tool behaviour, starting effort: at the moment of the call. |
| Child `max` in the prompt | At launch, when the system prompt is built. |
| `defaultCwd` | When a new conversation is started without a folder. |

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `MASTHEAD_PORT` | `port()` in `server/main.ts` | Port to use if `--port` is not given. Default 7717 (`DEFAULT_PORT`). Must be 1024–65535. |
| `MASTHEAD_CLAUDE` | `findClaude()` | Path to the `claude` program, tried first. |
| `MASTHEAD_DEV` | `runServer()` | `1` adds the Vite development server (port 7718) to the accepted Host and Origin values. See [Security model](Security-Model.md). |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | `server/config.ts` | Base folders for settings and data (conversations and the local secret). `masthead stop` reads the secret from `XDG_DATA_HOME`, so it must match the server's; the install script writes both into the service when they are set. |
| `PATH` | `findClaude()` | Searched for `claude`. |

### Finding Claude Code

`findClaude()` runs once, when `App` is created. It tries, in order: `$MASTHEAD_CLAUDE`; `claude` in each `PATH` folder; `~/.local/bin/claude`; `~/.claude/local/claude`; `/usr/local/bin/claude`; `/usr/bin/claude`. The first that exists is run with `--version` (15-second limit). The result (`path`, `version`, `error`) is sent to the page in `AppState.claude`. If none is found, starting a conversation fails with "Claude Code was not found. Install it and sign in with `claude`, then restart Masthead."

### The environment agents get

`agentEnv()` copies the server's environment for each Claude Code process, except a named list of variables that a running Claude Code session sets about itself (`SESSION_VARS`: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT` and ten session-describing `CLAUDE_CODE_*` names) and anything starting with `CLAUDE_CODE_BRIDGE_`. That way a Masthead server started from inside a Claude Code terminal still starts clean agents, while settings the person exports on purpose and credentials pass through untouched. It then sets `CLAUDE_AGENT_SDK_CLIENT_APP=masthead/0.1.1`, which identifies Masthead to the SDK. The full list is on [server/config.ts](Source-Config.md#agentenv).

## Command-line options

See [Command-line launcher](Command-Line-Launcher.md): `--port N`, `--no-browser`, `--version`, `--help`.

## Related pages

[server/config.ts](Source-Config.md) · [Storage on disk](Storage-on-Disk.md)
