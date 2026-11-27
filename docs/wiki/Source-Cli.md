# server/cli.ts

**Role:** the command-line parsing and the sign-in step for `masthead`. It is kept apart from [server/main.ts](Source-Main.md) so it can be tested without starting a server, opening a browser or calling systemd (`test/launcher.test.ts`). The parsing functions have no side effects: each takes its input as an argument and returns a value or throws. The sign-in functions write and remove files in the folder they are given, and run commands only through the `Opener` they are given. How the person uses the command is on [Command-line launcher](Command-Line-Launcher.md).

> Checked against the 0.1.4 source. The behaviour described here is read from the code, not run (`npm test` passes).

It imports `DEFAULT_PORT` (7717) from [server/config.ts](Source-Config.md), `randomBytes` from `node:crypto`, file functions from `node:fs` and `join` from `node:path`.

## Exports at a glance

| Name | Kind | Used by `main.ts` for |
|---|---|---|
| `UsageError` | class | Telling a typing mistake (exit 2) apart from a real failure. |
| `parsePort(args, env)` | function | The port every command talks to or serves on. |
| `parseCommand(args)` | function | Which command to run. |
| `unitPortFrom(showOutput)` | function | Whether the installed systemd unit serves the asked-for port. |
| `parseDevWebPort(env)` | function | The Vite page's port in development mode. |
| `signInUrl(base, secret)` | function | The address that signs a browser in. |
| `signInDir(env, dataDir)` | function | Where sign-in files go. |
| `SIGN_IN_STALE_MS` | constant | Age (2 minutes) after which a leftover sign-in file is removed. |
| `writeSignInFile(dir, target, now)` | function | Writing the private sign-in page (used by `openSignedIn()`). |
| `OPENER_WAIT_MS` | constant | How long (3 seconds) `openSignedIn()` waits for the opener before counting it as having opened the browser. |
| `serverProves(base, port, secret, fetchFn)` | function | Checking that the server on the port knows the secret before it is sent the key. |
| `Opener` | interface | What `openSignedIn()` needs to run commands and print. |
| `openSignedIn(opts)` | function | Opening the browser, signed in, without the key on a command line. |

`checkPort(raw)` and `htmlAttr(s)` (escapes `&`, `"`, `<` and `>` for an HTML attribute) are private helpers.

## UsageError

`class UsageError extends Error {}`. It marks a mistake in how the command was typed. `port()` in `main.ts` catches it, prints its message as it is, and exits with code 2. Any other error is not caught there and crashes as usual. Keeping a separate class means a bug never gets reported as "you typed it wrong".

## checkPort (private)

Turns a string into a port number or throws a `UsageError`.

- The string must be digits only (`/^\d+$/`). So `7720` passes, but `+7720`, `7720.0`, ` 7720` and `0x1E28` do not.
- The number must be from 1024 to 65535. Ports below 1024 need root on Linux, so they are refused up front.
- Leading zeros are accepted: `07720` is 7720.
- The message is `Invalid port: <raw> (use a number from 1024 to 65535).`

## parsePort(args, env)

The port asked for, in this order:

1. The first `--port N` in `args` (the next argument is the value).
2. The first `--port=N` in `args`. Steps 1 and 2 are one scan, so whichever form comes first wins.
3. `env.MASTHEAD_PORT`, if it is set and not empty.
4. `DEFAULT_PORT` (7717).

Edge cases:

| Input | Result |
|---|---|
| `--port` at the end, or followed by an empty string or something starting with `-` | `UsageError`: `--port needs a number, e.g. --port 7720.` |
| `--port=` (empty) | `UsageError`: `Invalid port:  (use a number from 1024 to 65535).` |
| `--port 80` | `UsageError` (below 1024). |
| `MASTHEAD_PORT=abc` | `UsageError`, even for `masthead status`. A bad variable is never silently ignored. |
| `MASTHEAD_PORT=` (empty) | Ignored; the default is used. |
| `--port 7720` and `MASTHEAD_PORT=7730` | 7720: the option wins. |

`env` defaults to `{}`, so a test that passes no environment gets the default port.

## parseCommand(args)

The command is the first argument that does not start with `-` and is not the value right after `--port`. When there is none, the command is `open`.

| Arguments | Command |
|---|---|
| (none) | `open` |
| `--no-browser` | `open` |
| `--port 7720` | `open` (7720 is the port, not a command) |
| `serve --port 7720` or `--port 7720 serve` | `serve` |
| `--port=7720 stop` | `stop` (`--port=7720` is one argument, so `stop` is not taken as its value) |
| `frobnicate` | `frobnicate`, which `main.ts` answers with the usage text and exit 2 |

It does not check that the command exists. `main.ts` does that in its `switch`.

## unitPortFrom(showOutput)

Reads the output of:

```sh
systemctl --user show -p LoadState -p Environment masthead.service
```

and returns the port the installed unit serves, or null when there is no unit. `main.ts` (`unitServes()`) runs the command and compares the result with the asked-for port. This is how the launcher decides that **only the unit's own port goes through systemctl**; any other port gets a server of its own.

Steps:

1. Find the line `LoadState=…`. Unless it is exactly `loaded` (after trimming), return null. A unit that was never installed shows `not-found`, so it is ignored.
2. Find the line `Environment=…` (empty if missing).
3. Look for `MASTHEAD_PORT=<digits>` at the start of that value, after whitespace, or after a `"`. systemd shows each variable as `NAME=value`, separated by spaces, and quotes ones that contain spaces, so all three positions are covered. A name that only ends in `MASTHEAD_PORT` (for example `XMASTHEAD_PORT=1`) does not match.
4. No match: return `DEFAULT_PORT`. The unit's server reads the same variable, so with none set it serves 7717.
5. A match that fails `checkPort` (for example `MASTHEAD_PORT=80`): return `DEFAULT_PORT`. The `UsageError` is swallowed here because the person did not type it.

Edge cases (read from the code, not run against a real systemd):

- The regex reads digits only and has no end anchor, so `MASTHEAD_PORT=7720abc` reads as 7720.
- `scripts/install.sh` does not set `MASTHEAD_PORT` in the unit, so an installed unit normally reports 7717.

## parseDevWebPort(env)

`env.MASTHEAD_DEV_WEB_PORT` checked with `checkPort()`, or 7718 when it is unset or empty. A bad value throws the same `UsageError` as a bad port; `runServer()` in `main.ts` rewords it to `Invalid MASTHEAD_DEV_WEB_PORT: …` and exits 2. `vite.config.ts` reads the same variable for the page's own port.

## signInUrl(base, secret)

Returns `<base>/#key=<secret>`. The key is in the fragment, which browsers never send to a server, so it does not appear in a request, a server log or a `Referer` header. The page reads it with `takeKey()` in `web/src/lib/store.svelte.ts`, which also still accepts `?key=`.

## signInDir(env, dataDir)

`$XDG_RUNTIME_DIR/masthead` when `XDG_RUNTIME_DIR` is set and starts with `/` (normally a per-user tmpfs with mode `0700`), else `<dataDir>/open`. `main.ts` passes `DATA_DIR`.

## writeSignInFile(dir, target, now)

1. Creates `dir` with mode `0700` and then `chmod`s it to `0700`, so a folder that already existed with looser rights is tightened.
2. Removes every `sign-in-*` file in it whose modification time is more than `SIGN_IN_STALE_MS` (2 minutes) before `now`. A file that vanished meanwhile is skipped.
3. Writes `sign-in-<12 random hex characters>.html` with mode `0600` and the flag `wx`, which fails if the name exists rather than writing through it (for example through a planted symlink).
4. The page: `<meta charset="utf-8">`, `<meta name="referrer" content="no-referrer">`, `<meta http-equiv="refresh" content="0; url=<target>">`, the title `Masthead` and a plain `Open Masthead` link to the target, in case the refresh does not run. The target is escaped with `htmlAttr()`.
5. Returns the file's path.

Whether a real browser follows the refresh from a `file://` page was not verified by running.

## serverProves(base, port, secret, fetchFn)

Asks the server at `base` to prove it knows `secret`, so that only a real Masthead with this data folder's secret is ever sent the key. It makes a fresh nonce, `randomBytes(32)` as 64 lowercase hex characters, and calls `fetchFn` on `<base>/api/proof?nonce=<nonce>` with a 1.5-second timeout (`AbortSignal.timeout(1500)`). `fetchFn` defaults to the global `fetch`; the tests pass a stand-in. It returns true only when the status is `200` and `proofOk(secret, port, nonce, body.proof)` in [server/config.ts](Source-Config.md) holds: the proof must be 64 lowercase hex characters equal, compared in constant time, to HMAC-SHA256 keyed with the secret over `masthead-proof\n<port>\n<nonce>`. Every other outcome is false: no answer, a status other than 200 (an older Masthead without `/api/proof`), a body that is not JSON, a wrong proof, or a proof made for another port, which is what a program relaying the question to a Masthead on another port would return. Asking sends no secret. The server's side is on [server/http.ts](Source-Http.md#http-requests); why it matters is on [Security model](Security-Model.md#4-the-local-secret). Tested in `test/launcher.test.ts`.

## Opener

```ts
interface Opener {
  has(cmd: string): boolean;                                // whether a command exists
  run(cmd: string, args: string[]): Promise<number | null>; // exit code, or null if it could not start; must not keep the process alive
  detach(cmd: string, args: string[]): void;                // start in the background and forget
  log(line: string): void;
}
```

`main.ts` passes `systemOpener`; the tests pass a fake that records calls.

## openSignedIn(opts)

`opts` is `{ base, secret, dir, opener, tty, waitMs? }`. `tty` says whether output goes to a terminal; `waitMs` defaults to `OPENER_WAIT_MS` (3000). Returns true when the browser was opened, or the opener is still running after `waitMs`.

1. The target is `signInUrl(base, secret)`.
2. Picks `xdg-open`, else `gio`, whichever `opener.has()` finds first.
3. If one was found, writes the sign-in file with `writeSignInFile(dir, target)`. If that throws, it logs `Could not write the sign-in file in <dir>: <reason>`.
4. If there is an opener and a file, it runs `xdg-open <file>` or `gio open <file>`. The opener gets the file's **path**, never the key, so the key is not in any process's arguments, which other users can read. It waits for the opener at most `waitMs`: some openers run the browser in the foreground, and one still running has opened it, so `masthead` never hangs on it. On exit code 0, or when the opener is still running after the wait, it detaches `sh -c 'sleep 60; rm -f -- "$1"' sh <file>`, which removes the file a minute later; when `tty` it logs `If the browser did not open signed in, run: masthead --no-browser` (a confined browser may not have been able to read the file, which nothing here can see); and it returns true. On any other result it removes the file.
5. Otherwise (no opener, no file, or the opener failed) it returns false, and no file is left behind. What it logs depends on `tty`:
   - a terminal: `Open this address in your browser to sign it in (keep it private):` and the target on the next line, then `If the browser did not open signed in, run: masthead --no-browser`;
   - not a terminal: only ``Could not open the browser. Run `masthead --no-browser` in a terminal to get the sign-in address.`` The key is never written to output that may end up in a log other people can read.

So in a terminal the output always ends with the `masthead --no-browser` hint. The tty and no-tty output and the wait (with a short `waitMs` and an opener that never exits) are tested in `test/launcher.test.ts`; the 3-second wait with a real browser was not verified by running.

A snap or flatpak browser may be unable to read a file in `$XDG_RUNTIME_DIR` or `~/.local/share`. Then `masthead --no-browser` in a terminal prints the address to paste.

## Related pages

[Command-line launcher](Command-Line-Launcher.md) · [server/main.ts](Source-Main.md) · [server/config.ts](Source-Config.md) · [Tests](Source-Tests.md) · [Installing](Source-Install-Scripts.md) · [Security model](Security-Model.md)
