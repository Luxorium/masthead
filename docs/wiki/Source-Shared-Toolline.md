# shared/toolline.ts

**Role:** turns a tool call into a short, readable line: a verb and, when there is one, what it acted on. It lives in `shared/` because both sides use it: the server for an agent's activity line (`describeTool()` in `server/agent.ts`), and the page for transcripts and approval cards (re-exported by `web/src/lib/tools.ts`). Like `shared/protocol.ts`, it imports no Node or browser APIs.

## `ToolLine`

`{ verb: string; target?: string }`.

## `toolLine(name, input, live = false)`

`live` chooses wording for something happening now ("Reading x") over something finished ("Read x"). The server passes `true` for the activity line; the transcript and the team map pass `!item.done` for a tool item, so a running call reads in the present tense and a finished one in the past; the approval card uses the default (past tense) wording. A unit test in `test/unit.test.ts` checks both forms.

| Tool name | Finished / live verb | Target |
|---|---|---|
| `Read` | Read / Reading | `file_path` |
| `Edit`, `NotebookEdit` | Edited / Editing | `file_path` or `notebook_path` |
| `Write` | Wrote / Writing | `file_path` |
| `Bash` | Ran / Running | `command`, on one line |
| `Grep` | Searched for / Searching for | `pattern` |
| `Glob` | Looked for files / Looking for files | `pattern` |
| `WebSearch` | Searched the web / Searching the web | `query` |
| `WebFetch` | Fetched / Fetching | `url` |
| `TodoWrite`, `TaskCreate`, `TaskUpdate` | Updated its task list / Updating its task list | none |
| `Skill` | Used skill / Using skill | `skill` |
| `ToolSearch` | Looked up a tool / Looking up a tool | `query` |
| `AskUserQuestion` | Asked you a question / Asking you a question | none |
| `mcp__masthead__spawn_agent` | Started an agent: / Starting an agent: | `title`, else `name` |
| `mcp__masthead__send_message` | Messaged / Messaging | `to` |
| `mcp__masthead__list_agents` | Checked the team / Checking the team | none |
| `mcp__masthead__stop_agent` | Stopped agent / Stopping agent | `name` |
| `mcp__masthead__set_effort` | Asked for effort / Asking for effort | `level` |
| `mcp__masthead__set_agent_effort` | Set *name* to / Setting *name* to | "*level* effort" |
| any other `mcp__server__tool` | Used / Using *tool* | the server name |
| anything else | Used / Using *name* | first of `description`, `file_path`, `path`, `command`, `query` |

Helpers: `str()` accepts only non-empty strings; `oneLine()` collapses whitespace and cuts to 120 characters with `…`.

## Related pages

[server/agent.ts](Source-Agent.md) · [Web front end](Source-Web-Front-End.md) · [shared/protocol.ts](Source-Shared-Protocol.md)
