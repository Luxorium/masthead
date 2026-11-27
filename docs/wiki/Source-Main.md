# server/main.ts

**Role:** the program's entry point and the `masthead` command. It is the `bin` in `package.json`, compiled to `dist/server/main.js`, and starts with a `#!/usr/bin/env node` line. The installed `masthead` launcher written by `scripts/install.sh` runs this same file. How to use the command is on [Command-line launcher](Command-Line-Launcher.md); this page walks through the code.

## Module-level set-up

- **Warning filter.** Before anything else, `process.emitWarning` is replaced by a wrapper that drops warnings with the code `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` and passes every other warning on. The comment gives the reason: Masthead approves its own tools ahead of the permission callback on purpose (`allowedTools: ['mcp__masthead']`), so the SDK's notice about that is noise. With this filter the warning stays quiet however the file is started. The `--disable-warning` flag that `npm start`, the launcher script and the detached start also pass is now redundant.
- `here`: the folder of the running file. `webDir = here/../web`; for the compiled file that is `dist/web`, where Vite puts the built page.
- `url(p)`: `http://127.0.0.1:<p>`.

## Functions

| Function | What it does |
|---|---|
| `port()` | Reads `--port N`, else `MASTHEAD_PORT`, else 7717. If the value is not a whole number from 1024 to 65535, prints "Invalid port" and exits with code 2. |
| `health(p)` | Sends `GET /api/health` with a 1.5-second timeout. Returns `{version, pid}` only if the reply's `name` is `masthead`, otherwise null. |
| `hasUnit()` | True if `systemctl --user cat masthead.service` succeeds. |
| `runServer()` | Creates `App` and calls `serve()`, adding the Vite origins on port 7718 when `MASTHEAD_DEV=1`. Reports a port that is already in use, installs SIGINT/SIGTERM handlers, and prints the address. Its `shutdown` function runs only once: `app.shutdown()`, then the process exits after 300 ms. |
| `start(p)` | If the server already answers, there is nothing to do. Otherwise it starts the systemd unit, or spawns a detached `node --disable-warning=… <this file> serve --port p`. Then it checks health every 250 ms, up to 40 times. |
| `openBrowser(target)` | Runs `xdg-open` or `gio open`, detached. Prints the address if neither exists. |
| `main()` | Picks the command and runs it (below). |

### Choosing the command

```ts
const args = process.argv.slice(2);
const cmd = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--port') ?? 'open';
```

The command is the first argument that is neither an option nor the value after `--port`. So `masthead --port 8000 serve` and `masthead serve --port 8000` both run `serve`.

At the bottom of the file:

- `--version` anywhere prints the version.
- `--help` or `-h` anywhere replaces all the arguments with `help`, then runs `main()`, which prints the usage.
- Otherwise `main()` runs.

## Control flow of `masthead` (open)

1. `existsSync(webDir/index.html)`, or exit 1 with "The web page has not been built. Run: npm run build".
2. `start(p)`, or exit 1 with "Masthead did not start. Try `masthead serve` to see why."
3. Print the address, and call `openBrowser()` unless `--no-browser` was given.

## Control flow of `masthead stop`

1. If the server does not answer: print "Masthead is not running." and stop.
2. If the systemd unit exists, run `systemctl --user stop masthead.service`.
3. If the server still answers, send `POST /api/shutdown` with the header `x-masthead: 1` (errors are ignored).
4. Check health up to 20 times, 250 ms apart, until the server stops answering.
5. If it still answers, print "Masthead is still running." and exit 1. Otherwise print "Masthead stopped."

## Related pages

[Command-line launcher](Command-Line-Launcher.md) · [server/http.ts](Source-Http.md) · [Installing](Source-Install-Scripts.md)
