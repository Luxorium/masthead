# Changelog

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
