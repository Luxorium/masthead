# shared/toolline.ts

**Role:** turns a tool call into one short line that a person can read: a verb, plus what the call acted on when there is something. The file is in `shared/` because both sides use it. The server uses it for an agent's activity line (`describeTool()` in `server/runtime/agent.ts`). The page uses it for transcripts, the team outline and approval cards, through the re-export in `web/src/lib/tools.ts`. Like `shared/protocol.ts`, it imports no Node or browser APIs and keeps no state.

## `ToolLine`

`{ verb: string; target?: string }`.

## `toolLine(name, input, live = false)`

`live` picks the wording for something happening now ("Reading x") over something already finished ("Read x").

| Tool name | Finished / live verb | Target |
|---|---|---|
| `Read` | Read / Reading | `file_path` |
| `Edit`, `NotebookEdit` | Edited / Editing | `file_path`, else `notebook_path` |
| `Write` | Wrote / Writing | `file_path` |
| `Bash` | Ran / Running | `command`, on one line |
| `Grep` | Searched for / Searching for | `pattern`, on one line |
| `Glob` | Looked for files / Looking for files | `pattern` |
| `WebSearch` | Searched the web / Searching the web | `query`, on one line |
| `WebFetch` | Fetched / Fetching | `url` |
| `TodoWrite`, `TaskCreate`, `TaskUpdate` | Updated its task list / Updating its task list | none |
| `Skill` | Used skill / Using skill | `skill` |
| `ToolSearch` | Looked up a tool / Looking up a tool | `query`, on one line |
| `AskUserQuestion` | Asked you a question / Asking you a question | none |
| `mcp__masthead__spawn_agent` | Started a helper: / Starting a helper: | `title`, else `name` |
| `mcp__masthead__send_message` | Messaged / Messaging | `to` |
| `mcp__masthead__list_agents` | Checked the team / Checking the team | none |
| `mcp__masthead__stop_agent` | Stopped helper / Stopping helper | `name` |
| `mcp__masthead__set_effort` | Asked for more thinking time: / Asking for more thinking time: | the level as thinking time |
| `mcp__masthead__set_agent_effort` | Set *name*'s thinking time to / Setting *name*'s thinking time to | the level as thinking time, or `?` |
| any other `mcp__<server>__<tool>` | Used / Using *tool* (or "a tool" when there is no tool part) | the server name |
| anything else | Used / Using *name* | the first of `description`, `file_path`, `path`, `command`, `query`, on one line |

Internal helpers:

- `str(v)` accepts only non-empty strings.
- `oneLine(s, max = 120)` collapses whitespace and cuts longer text to 119 characters plus `…` (120 in all). Only the targets marked "on one line" above go through it. File paths and URLs are kept whole.
- `thinking(level)` gives an effort level in the page's thinking-time words: `low` "short", `medium` "medium", `high` "long", `xhigh` "longest". An unknown level is shown as given.

A `null` or missing `input` is treated as `{}`. In `set_agent_effort`, a missing name reads "a helper". `set_effort` reads "Asked for more thinking time" even for the lead, whose call changes its effort directly without asking.

### Codex tool names

The Codex backend (`server/backends/codex/index.ts`) reports its own tools under names such as `shell`, `apply_patch`, `web_search` and `view_image`, and MCP calls as `mcp__<server>__<tool>`. The names `shell`, `apply_patch`, `web_search` and `view_image` are not in the table, so they get the fallback: "Used shell" with the `command` as target, "Used web_search" with the `query`, "Used view_image" with the `path`, and "Used apply_patch" with no target (its input is `{changes}`). A Codex dynamic tool with a namespace shows as `<namespace>.<tool>`. Masthead's own team tools are Codex "dynamic tools" with bare names (`spawn_agent`, …). The runtime renames them to `mcp__masthead__<name>` before they reach items and activity lines (`server/runtime/agent.ts`), so they get the same friendly lines as on Claude. See [Codex backend](Source-Backend-Codex.md).

## Callers

- `describeTool(name, input)` in `server/runtime/agent.ts` calls `toolLine(name, input, true)`. It joins verb and target into one string and cuts it to 89 characters plus `…` when longer than 90, for the agent's `activity` line.
- `web/src/lib/tools.ts` re-exports `toolLine` and `ToolLine`. `web/src/lib/transcript/ToolItem.svelte` and `web/src/lib/team/TeamOutline.svelte` pass `!item.done`, so a running call reads in the present tense and a finished one in the past. `web/src/lib/PermissionCard.svelte` uses the default, past-tense wording.
- `test/unit.test.ts` checks both tenses, the spawn title ("Starting a helper:"), `Bash` on one line, a foreign MCP tool, and an unknown tool with `null` input.

Not verified by running: this page was written from the code.

## Related pages

[Runtime agent](Source-Runtime.md) · [Web front end](Source-Web-Front-End.md) · [shared/protocol.ts](Source-Shared-Protocol.md) · [Core tools](Source-Core-Tools.md)
