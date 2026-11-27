# server/cli.ts

**Role:** the command-line parsing and the sign-in step for `masthead`. It is kept apart from [server/main.ts](Source-Main.md) so it can be tested without starting a server, opening a browser or calling systemd (`test/launcher.test.ts`). The parsing functions have no side effects: each takes its input as an argument and returns a value or throws. The sign-in functions write and remove files in the folder they are given, and run commands only through the `Opener` they are given. How the person uses the command is on [Command-line launcher](Command-Line-Launcher.md).

> Checked against the 0.2.0 source on branch `next` (2026-11-27). The behaviour described here is read from the code, not verified by running.

It imports `DEFAULT_PORT` (7717) and `mastheadCommand` from [server/paths.ts](Source-Paths.md), `makeDirPrivate`, `proofOk` and the `Runner` type from [server/transport/auth.ts](Source-Transport-Auth.md), `randomBytes` from `node:crypto`, file functions from `node:fs` and `join`, `posix` and `win32` from `node:path`.

## Exports at a glance

| Name | Kind | Used by `main.ts` for |
|---|---|---|
| `UsageError` | class | Telling a typing mistake (exit 2) apart from a real failure. |
| `parsePort(args, env)` | function | The port `serve` serves on (`port()` in `main.ts`). |
| `requestedPort(args, env)` | function | The port explicitly asked for, or null (used by `parsePort` and `commandPort`). |
| `commandPort(cmd, args, env, installed)` | function | The port the other commands talk to (`portFor()` in `main.ts`): as asked, else the installed service's. |
| `parseCommand(args)` | function | Which command to run. |
| `unitPortFrom(showOutput)` | function | Whether the installed systemd unit serves the asked-for port. |
| `parseDevWebPort(env)` | function | The Vite page's port in development mode. |
| `signInUrl(base, secret)` | function | The address that signs a browser in. |
| `signInDir(env, dataDir, platform)` | function | Where sign-in files go. |
| `openersFor(platform)` | function | Which programs open a file in the browser on this platform. |
| `onPath(cmd, env, platform, exists)` | function | Whether a program is on `PATH` (the opener and the keep-awake tool). |
| `removeLaterArgs(file, ms)` | function | Arguments for a Node process that removes the sign-in file later. |
| `SIGN_IN_STALE_MS` | constant | Age (2 minutes) after which a leftover sign-in file is removed. |
| `writeSignInFile(dir, target, now, platform, run)` | function | Writing the private sign-in page (used by `openSignedIn()`). |
| `noBrowserCommand(base, platform)` | function | The `masthead --no-browser` hint, with the right command name and port. |
| `OPENER_WAIT_MS` | constant | How long (3 seconds) `openSignedIn()` waits for the opener before counting it as having opened the browser. |
| `serverProves(base, port, secret, fetchFn)` | function | Checking that the server on the port knows the secret before it is sent the key. |
| `Opener` | interface | What `openSignedIn()` needs to run commands and print. |
| `openSignedIn(opts)` | function | Opening the browser, signed in, without the key on a command line. |

`checkPort(raw)`, `htmlAttr(s)` (escapes `&`, `"`, `<` and `>` for an HTML attribute), `PORT_COMMANDS` and `SIGN_IN_PREFIX` (`sign-in-`) are private.

## UsageError

`class UsageError extends Error {}`. It marks a mistake in how the command was typed. `port()` and `portFor()` in `main.ts` catch it, print its message as it is, and exit with code 2. Any other error is not caught there and crashes as usual. Keeping a separate class means a bug never gets reported as "you typed it wrong".

## checkPort (private)

Turns a string into a port number or throws a `UsageError`.

- The string must be digits only (`/^\d+$/`). So `7720` passes, but `+7720`, `7720.0`, ` 7720` and `0x1E28` do not.
- The number must be from 1024 to 65535. Ports below 1024 need root on Linux, so they are refused up front on every platform.
- Leading zeros are accepted: `07720` is 7720.
- The message is `Invalid port: <raw> (use a number from 1024 to 65535).`

## parsePort(args, env)

`requestedPort` returns the port asked for, or null when none was; `parsePort` is `requestedPort(...) ?? DEFAULT_PORT`. The order:

1. The first `--port N` in `args` (the next argument is the value).
2. The first `--port=N` in `args`. Steps 1 and 2 are one scan, so whichever form comes first wins.
3. `env.MASTHEAD_PORT`, if it is set and not empty.
4. `parsePort`: `DEFAULT_PORT` (7717); `requestedPort`: null.

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

## commandPort(cmd, args, env, installed)

The port a command works on. An explicit `--port` or `MASTHEAD_PORT` (`requestedPort`) wins. Otherwise, for `open`, `status`, `stop`, `service` and `doctor` (`PORT_COMMANDS`), it asks `installed()` and uses the installed background service's port when there is one, so `masthead stop` finds a service installed with `--port 7727`. Any other command, no service, or `installed()` throwing gives `DEFAULT_PORT`. `main.ts` passes `serviceFor(process.platform)?.status()`. A bad `--port` still throws `UsageError`.

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

and returns the port the installed unit serves, or null when there is no unit. Linux only: `unitServes()` in `main.ts` does not call it on other platforms. `server/service/systemd.ts` has its own `unitPortFrom()` that does the same with `portOf()` ([server/service](Source-Service.md#systemdts)). `main.ts` (`unitServes()`) runs the command and compares the result with the asked-for port. This is how the launcher decides that **only the unit's own port goes through systemctl**; any other port gets a server of its own.

Steps:

1. Find the line `LoadState=…`. Unless it is exactly `loaded` (after trimming), return null. A unit that was never installed shows `not-found`, so it is ignored.
2. Find the line `Environment=…` (empty if missing).
3. Look for `MASTHEAD_PORT=<digits>` at the start of that value, after whitespace, or after a `"`. systemd shows each variable as `NAME=value`, separated by spaces, and quotes ones that contain spaces, so all three positions are covered. A name that only ends in `MASTHEAD_PORT` (for example `XMASTHEAD_PORT=1`) does not match.
4. No match: return `DEFAULT_PORT`. The unit's server reads the same variable, so with none set it serves 7717.
5. A match that fails `checkPort` (for example `MASTHEAD_PORT=80`): return `DEFAULT_PORT`. The `UsageError` is swallowed here because the person did not type it.

Edge cases (read from the code, not run against a real systemd):

- The regex reads digits only and has no end anchor, so `MASTHEAD_PORT=7720abc` reads as 7720.
- `scripts/install.sh` does not set `MASTHEAD_PORT` in the unit, so a unit it installed reports 7717. `masthead service install --port N` writes `MASTHEAD_PORT=N` when N is not 7717.

## parseDevWebPort(env)

`env.MASTHEAD_DEV_WEB_PORT` checked with `checkPort()`, or 7718 when it is unset or empty. A bad value throws the same `UsageError` as a bad port; `runServer()` in `main.ts` rewords it to `Invalid MASTHEAD_DEV_WEB_PORT: …` and exits 2. `vite.config.ts` reads the same variable for the page's own port.

## signInUrl(base, secret)

Returns `<base>/#key=<secret>`. The key is in the fragment, which browsers never send to a server, so it does not appear in a request, a server log or a `Referer` header. The page reads it with `takeKey()` in `web/src/lib/signin.ts`, which also still accepts `?key=`.

## signInDir(env, dataDir, platform)

`platform` defaults to `process.platform`. Paths are joined with the Windows rules on `win32` and POSIX rules elsewhere.

| Platform | Folder |
|---|---|
| Linux and other non-Windows | `$XDG_RUNTIME_DIR/masthead` when `XDG_RUNTIME_DIR` is an absolute path (normally a per-user tmpfs with mode `0700`), else `<dataDir>/open` |
| macOS | as above when `XDG_RUNTIME_DIR` is set (it usually is not); else `$TMPDIR/masthead` when `TMPDIR` is absolute (the per-user temporary folder, `0700`); else `<dataDir>/open` |
| Windows | always `<dataDir>/open` (`XDG_RUNTIME_DIR` is ignored) |

`main.ts` passes `DATA_DIR` ([server/paths.ts](Source-Paths.md)).

## openersFor(platform)

The programs that open a file in the default browser, in the order they are tried:

| Platform | Openers |
|---|---|
| `darwin` | `open` |
| `win32` | `explorer.exe` |
| anything else | `xdg-open`, then `gio` |

## onPath(cmd, env, platform, exists)

Whether `cmd` is on `PATH`, looked up here instead of through a shell (Windows has no `sh`).

- Splits `PATH` on `;` on Windows and `:` elsewhere. Empty and relative entries are skipped.
- On Windows the variable names are matched without regard to case (`Path` works), and a name without an extension is tried with each `PATHEXT` extension (default `.COM;.EXE;.BAT;.CMD`). A name with an extension, such as `explorer.exe`, is tried as it is.
- `exists(path)` is passed in: `main.ts` passes `existsSync`, tests pass a stand-in.

`main.ts` uses it for the opener (`systemOpener.has`) and for the keep-awake tool in `masthead doctor`.

## removeLaterArgs(file, ms)

Arguments for `node`: `-e <script> <file>`, where the script waits `ms` (default 60 000) and then `rmSync`s `process.argv[1]` with `force: true`, ignoring errors. No shell is involved, so it works on Windows too. The file name is an argument, not part of the script. Tested in `test/launcher.test.ts` (the file is really removed).

## writeSignInFile(dir, target, now)

1. Creates `dir` with mode `0700`, then makes it private with `makeDirPrivate(dir, platform, run)` from `server/transport/auth.ts`: `chmod 0700` off Windows (so a folder that already existed with looser rights is tightened); on Windows an `icacls` grant of full control to the current user's SID only, with inheritance removed. If that fails it throws `could not make <dir> private to you`. `platform` defaults to `process.platform`; `run` is the command runner, for tests.
2. Removes every `sign-in-*` file in it whose modification time is more than `SIGN_IN_STALE_MS` (2 minutes) before `now`. A file that vanished meanwhile is skipped.
3. Writes `sign-in-<12 random hex characters>.html` with mode `0600` and the flag `wx`, which fails if the name exists rather than writing through it (for example through a planted symlink).
4. The page: `<meta charset="utf-8">`, `<meta name="referrer" content="no-referrer">`, `<meta http-equiv="refresh" content="0; url=<target>">`, the title `Masthead` and a plain `Open Masthead` link to the target, in case the refresh does not run. The target is escaped with `htmlAttr()`.
5. Returns the file's path.

Whether a real browser follows the refresh from a `file://` page was not verified by running.

## serverProves(base, port, secret, fetchFn)

Asks the server at `base` to prove it knows `secret`, so that only a real Masthead with this data folder's secret is ever sent the key. It makes a fresh nonce, `randomBytes(32)` as 64 lowercase hex characters, and calls `fetchFn` on `<base>/api/proof?nonce=<nonce>` with a 1.5-second timeout (`AbortSignal.timeout(1500)`). `fetchFn` defaults to the global `fetch`; the tests pass a stand-in. It returns true only when the status is `200` and `proofOk(secret, port, nonce, body.proof)` in [server/transport/auth.ts](Source-Transport-Auth.md#proofoksecret-port-nonce-answer) holds: the proof must be 64 lowercase hex characters equal, compared in constant time, to HMAC-SHA256 keyed with the secret over `masthead-proof\n<port>\n<nonce>`. Every other outcome is false: no answer, a status other than 200 (an older Masthead without `/api/proof`), a body that is not JSON, a wrong proof, or a proof made for another port, which is what a program relaying the question to a Masthead on another port would return. Asking sends no secret. The server's side is on [server/transport/http.ts](Source-Http.md#http-requests-handlerequest); why it matters is on [Security model](Security-Model.md#the-local-secret). Tested in `test/launcher.test.ts`.

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

`opts` is `{ base, secret, dir, opener, tty, waitMs?, platform?, node? }`. `tty` says whether output goes to a terminal; `waitMs` defaults to `OPENER_WAIT_MS` (3000); `platform` defaults to `process.platform`; `node` (the program that runs the delayed removal) defaults to `process.execPath`. Returns true when the browser was opened, or the opener is still running after `waitMs`.

1. The target is `signInUrl(base, secret)`.
2. Picks the first of `openersFor(platform)` that `opener.has()` finds.
3. If one was found, writes the sign-in file with `writeSignInFile(dir, target)` (with the real platform, not `opts.platform`). If that throws, it logs `Could not write the sign-in file in <dir>: <reason>`.
4. If there is an opener and a file, it runs `<opener> <file>` (`gio open <file>` for `gio`). The opener gets the file's **path**, never the key, so the key is not in any process's arguments, which other users can read. It waits for the opener at most `waitMs`: some openers run the browser in the foreground, and one still running has opened it, so `masthead` never hangs on it. It counts as opened when the opener is still running after the wait, exits 0, or is `explorer.exe` with any exit code (the code comment: `explorer.exe` exits with 1 even when it opened the file, so only "could not start", a null code, is a failure there). When opened, it detaches `<node> removeLaterArgs(file)`, which removes the file a minute later; when `tty` it logs `If the browser did not open signed in, run: <noBrowserCommand>` (a confined browser may not have been able to read the file, which nothing here can see); and it returns true. On any other result it removes the file.
5. Otherwise (no opener, no file, or the opener failed) it returns false, and no file is left behind. What it logs depends on `tty`:
   - a terminal: `Open this address in your browser to sign it in (keep it private):` and the target on the next line, then `If the browser did not open signed in, run: <noBrowserCommand>`;
   - not a terminal: only ``Could not open the browser. Run `<noBrowserCommand>` in a terminal to get the sign-in address.`` The key is never written to output that may end up in a log other people can read.

`noBrowserCommand(base, platform)` is `masthead --no-browser` (`masthead.cmd` on Windows, through `mastheadCommand()`), with ` --port <n>` inserted when the port in `base` is not 7717. So in a terminal the output always ends with that hint. The tty and no-tty output and the wait (with a short `waitMs` and an opener that never exits) are tested in `test/launcher.test.ts`; the 3-second wait with a real browser was not verified by running.

A snap or flatpak browser may be unable to read a file in `$XDG_RUNTIME_DIR` or the data folder. Then `masthead --no-browser` in a terminal prints the address to paste.

## Related pages

[Command-line launcher](Command-Line-Launcher.md) · [server/main.ts](Source-Main.md) · [server/paths.ts](Source-Paths.md) · [server/transport/auth.ts](Source-Transport-Auth.md) · [Platforms](Platforms.md) · [Tests](Source-Tests.md) · [Installing](Source-Install-Scripts.md) · [Security model](Security-Model.md)
