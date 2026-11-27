# Masthead

Masthead is a local web app for working with a team of Claude agents instead of a single chat.
You talk to one lead agent. When the work calls for it, the lead brings in more agents, and those
can bring in their own:

| Tier | Model | Started by |
|---|---|---|
| Lead | Fable 5.2 | you |
| Second | Opus 5.5 | the lead |
| Third | Sonnet 5.5 | an Opus agent |
| Fourth | Haiku 5.5 | a Sonnet agent |

A panel on the right sets how many agents of each tier may run at once. Agents report back to
whoever started them, can message each other by name, and start at low thinking effort, raising it
only when the work needs it.

Masthead runs the Claude Code that is already installed and signed in on your machine. It has no
login of its own and never sees your credentials.

## Requirements

- Linux
- Node.js 22 or newer
- [Claude Code](https://code.claude.com/docs), installed and signed in (`claude` works in a terminal)

## Install

```sh
git clone <this repository> masthead
cd masthead
scripts/install.sh
masthead
```

The script builds the app, installs it under `~/.local/lib/masthead`, adds a `masthead` command to
`~/.local/bin`, registers a user service that starts at login, and adds a launcher entry. It needs
no root. Run it again to update; if agents are working it asks before restarting (or pass `--force`).
`scripts/uninstall.sh` removes it and keeps your conversations.

`masthead` opens the app in your browser at `http://127.0.0.1:7717` and signs that browser in (see
Security). A tab opened some other way asks you to open it with `masthead` once.

| Command | What it does |
|---|---|
| `masthead` | Start it if needed and open the browser, signed in |
| `masthead serve` | Run the server in this terminal |
| `masthead status` | Say whether it is running |
| `masthead stop` | Stop it; agents that are working are stopped too |

`--port N` or `MASTHEAD_PORT` changes the port. The installed service always serves 7717; on any
other port `masthead` starts and stops a separate copy of its own. That copy reads its secret from
its own data folder, so stop it with the same `XDG_DATA_HOME` it was started with.

## Using it

- **Conversations** are on the left. A new one starts in the folder you pick under the message box;
  the agents work in that folder.
- **The team panel** on the right holds the limits. "At once" is how many agents of that tier may
  run at the same time across every conversation; more than that wait in a queue. Setting a tier to
  Off stops the tier above from starting any.
- **Effort.** With automatic effort on, every agent starts at Low. The lead raises its own when a
  task needs careful thought. Any other agent has to ask the agent that started it, and an agent can
  set the effort of anyone below it. "Effort up to" is the ceiling for a tier. The levels are Low,
  Medium, High and Extra.
- **The team map** shows the agents as a tree with what each one is doing. Click an agent to read
  its transcript, or to message it directly.
- **Approvals.** When an agent wants to do something that needs your say, a card appears above the
  message box. "Permissions" in the team panel chooses how often that happens; by default it follows
  your own Claude Code settings.
- **Stopping.** The square button stops the lead's current turn. "Stop everything" also stops every
  agent it started. Each agent has its own stop button.

Closing the browser tab stops nothing: agents keep working and the page catches up when you return.
Stopping Masthead itself stops them.

## Where things are kept

| What | Where |
|---|---|
| Settings | `~/.config/masthead/settings.json` |
| Conversations | `~/.local/share/masthead/conversations/` |
| The local secret | `~/.local/share/masthead/secret` |
| Claude Code's own session files | `~/.claude/` (Masthead resumes these by id) |

## Security

The server listens on `127.0.0.1` only. It can run commands as you, so it also refuses requests that
a web page elsewhere could trick your browser into sending: the `Host` header must name the server,
and only Masthead's own page may open the live connection.

On top of that, the live connection and `masthead stop` need a secret. It is created once in
`~/.local/share/masthead/secret`, which only you can read, so other users on the machine cannot
drive Masthead. `masthead` opens the page with the secret in the address; the page keeps it for that
address, removes it from the address bar and sends it when it connects. Any program running as you
can still read the secret, as it could run `claude` itself.

## Usage and limits

Every agent uses your Claude plan or API key exactly as Claude Code does. A large team spends usage
quickly; the limits and the low default effort are there to keep that in hand.

## Development

```sh
npm install
npm run check        # type-check server and page
npm test             # unit tests
npm run build
npm start            # serve the build on port 7717
npm run test:live    # end-to-end against the real Claude Code, using Haiku for every tier
```

`npm run dev:web` serves the page with hot reload on port 7718; start the server with
`MASTHEAD_DEV=1 npm start` beside it. The server prints the address of the dev page with its key. The design of the code is described in `docs/wiki/`.

Masthead is an independent project. It is not made or endorsed by Anthropic.
