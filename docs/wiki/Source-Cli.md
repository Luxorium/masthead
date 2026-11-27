# server/cli.ts

**Role:** the command-line parsing for `masthead`. It is kept apart from [server/main.ts](Source-Main.md) so it can be tested without starting a server, opening a browser or calling systemd (`test/launcher.test.ts`). It has no side effects: every function takes its input as an argument and returns a value or throws. How the person uses the command is on [Command-line launcher](Command-Line-Launcher.md).

> Checked against the 0.1.3 source. The behaviour described here is read from the code, not run (`npm test` passes).

It imports one thing: `DEFAULT_PORT` (7717) from [server/config.ts](Source-Config.md).

## Exports at a glance

| Name | Kind | Used by `main.ts` for |
|---|---|---|
| `UsageError` | class | Telling a typing mistake (exit 2) apart from a real failure. |
| `parsePort(args, env)` | function | The port every command talks to or serves on. |
| `parseCommand(args)` | function | Which command to run. |
| `unitPortFrom(showOutput)` | function | Whether the installed systemd unit serves the asked-for port. |

`checkPort(raw)` is a private helper.

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

## Related pages

[Command-line launcher](Command-Line-Launcher.md) · [server/main.ts](Source-Main.md) · [server/config.ts](Source-Config.md) · [Tests](Source-Tests.md) · [Installing](Source-Install-Scripts.md)
