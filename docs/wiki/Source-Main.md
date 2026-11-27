# server/main.ts

**Role:** the program's entry point and the `masthead` command. It is the `bin` in `package.json`, compiled to `dist/server/main.js`, and starts with a `#!/usr/bin/env node` line. The installed `masthead` launcher written by `scripts/install.sh` runs this same file. How to use the command is on [Command-line launcher](Command-Line-Launcher.md); this page walks through the code.

## Module-level set-up

- **Warning filter.** Before anything else, `process.emitWarning` is replaced by a wrapper that drops warnings with the code `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` and passes every other warning on. The comment gives the reason: Masthead approves its own tools ahead of the permission callback on purpose (`allowedTools: ['mcp__masthead']`), so the SDK's notice about that is noise. With this filter the warning stays quiet however the file is started. The `--disable-warning` flag that `npm start`, the launcher script and the detached start also pass is now redundant.
- `here`: the folder of the running file. `webDir = here/../web`; for the compiled file that is `dist/web`, where Vite puts the built page.
- `url(p)`: `http://127.0.0.1:<p>`.

## Functions

| Function | What it does |
|---|---|
| `port()` | `parsePort(argv, env)` from `server/cli.ts`; on a `UsageError` it prints the message and exits with code 2. |
| `health(p)` | Sends `GET /api/health` with a 1.5-second timeout. Returns `{version, pid}` only if the reply's `name` is `masthead`, otherwise null. |
| `unitServes(p)` | True if `systemctl --user show -p LoadState -p Environment masthead.service` succeeds and `unitPortFrom()` reads port `p` from it: the installed service is the one that serves this port. |
| `secretOrExit()` | `loadSecret()`, or print "Could not read or create …/secret" and exit 1. |
| `runServer()` | Creates `App`, loads the secret (`secretOrExit()`) and calls `serve()` with it, adding the Vite origins on port 7718 when `MASTHEAD_DEV=1`. Reports a port that is already in use, installs SIGINT/SIGTERM handlers, and prints the address and how to sign in (in development mode, `http://localhost:7718/?key=<secret>`). Its `shutdown` function runs only once: `app.shutdown()`, then the process exits after 300 ms. |
| `start(p)` | If the server already answers, there is nothing to do. Otherwise it starts the systemd unit if `unitServes(p)`, or else spawns a detached `node --disable-warning=… <this file> serve --port p`. Then it checks health every 250 ms, up to 40 times. |
| `openBrowser(target)` | Runs `xdg-open` or `gio open`, detached. Prints the address if neither exists. |
| `main()` | Picks the command and runs it (below). |

### Choosing the command

```ts
const cmd = parseCommand(process.argv.slice(2));
```

`parseCommand()` (in `server/cli.ts`) returns the first argument that is neither an option nor the value after `--port`, or `open`. So `masthead --port 8000 serve` and `masthead serve --port 8000` both run `serve`.

At the bottom of the file:

- `--version` anywhere prints the version.
- `--help` or `-h` anywhere replaces all the arguments with `help`, then runs `main()`, which prints the usage.
- Otherwise `main()` runs.

## Control flow of `masthead` (open)

1. `existsSync(webDir/index.html)`, or exit 1 with "The web page has not been built. Run: npm run build".
2. `start(p)`, or exit 1 with "Masthead did not start. Try `masthead serve` to see why."
3. Print the address, and unless `--no-browser` was given, call `openBrowser()` on `<address>/?key=<secret>` (`secretOrExit()`). The code comment there says the server swaps the key for a cookie; it does not: the page keeps it in `localStorage` (see [Security model](Security-Model.md#4-the-local-secret)).

## Control flow of `masthead stop`

1. If the server does not answer: print "Masthead is not running." and stop.
2. If `unitServes(p)`, run `systemctl --user stop masthead.service`.
3. If the server still answers, send `POST /api/shutdown` with `x-masthead: 1` and `x-masthead-key` set to `readSecret()` (empty if there is none). A network error is ignored; a `403` means the server holds another secret, so it prints that and exits 1.
4. Check health up to 20 times, 250 ms apart, until the server stops answering.
5. If it still answers, print "Masthead is still running." and exit 1. Otherwise print "Masthead stopped."

## `server/cli.ts`

The command-line parsing, kept apart from `main.ts` so it can be tested without starting anything (`test/launcher.test.ts`).

| Export | What it does |
|---|---|
| `UsageError` | A mistake in how the command was typed; `main.ts` prints its message and exits 2. |
| `parsePort(args, env)` | The first `--port N` or `--port=N` in `args`, else `env.MASTHEAD_PORT`, else 7717. A value must be digits only and 1024–65535; `--port` with no value, an empty value or one starting with `-` is a `UsageError`. |
| `parseCommand(args)` | The first argument that is neither an option nor the value after `--port`; `open` if there is none. |
| `unitPortFrom(showOutput)` | Reads the output of `systemctl --user show -p LoadState -p Environment masthead.service`: null unless `LoadState=loaded`; otherwise the `MASTHEAD_PORT=` value in `Environment=` if it is a valid port, else 7717. |

## Related pages

[Command-line launcher](Command-Line-Launcher.md) · [server/http.ts](Source-Http.md) · [Installing](Source-Install-Scripts.md)
