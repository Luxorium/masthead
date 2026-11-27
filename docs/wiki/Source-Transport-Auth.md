# server/transport/auth.ts

**Role:** the local secret and the proof built from it. The secret is a file only the person can read. The [local listener](Source-Http.md) needs it to open the socket, upload pictures and shut down, and the launcher uses a proof to check that a server knows it before sending it there. The file also holds the helpers that make a file private on each platform. Why the secret exists is on [Security model](Security-Model.md#the-local-secret).

> Checked against the 0.2.0 source on branch `next`. Behaviour described here is read from the code, not run. `test/platform.test.ts` and `test/http.test.ts` cover parts of it; the tests were not run for this page.

## Formats

- `SECRET_FORMAT` (private): `/^[0-9a-f]{64}$/`, 32 bytes as lowercase hex. A secret file holding anything else counts as no secret.
- `NONCE_FORMAT` (exported): the same pattern, for the launcher's proof nonce. `/api/proof` in [http.ts](Source-Http.md#http-requests-handlerequest) answers `400` to any other nonce.

## proofOf(secret, port, nonce)

The server's proof that it knows the secret: HMAC-SHA256 keyed with the secret over the text `masthead-proof\n<port>\n<nonce>`, as lowercase hex. The doc comment gives the reasons. The HMAC reveals nothing about the secret. The port is part of it so a program holding port N cannot pass the launcher's question on to a real Masthead on another port and replay its answer. Used by `/api/proof` in [http.ts](Source-Http.md#http-requests-handlerequest), with the port the server actually listens on.

## proofOk(secret, port, nonce, answer)

The launcher's side, used by `server/cli.ts`. It returns false unless `answer` is a string of 64 lowercase hex characters. Otherwise it decodes both `answer` and the expected `proofOf()` from hex and compares them with `crypto.timingSafeEqual`. The format check guarantees both buffers are 32 bytes, so the comparison cannot throw on a length difference.

## readSecret(file = SECRET_FILE)

Reads the file, trims it, and returns it if it matches `SECRET_FORMAT`. Any read error, or any other content, gives null. `SECRET_FILE` is `secret` in the data folder (`server/paths.ts`). `server/main.ts` uses it where it only needs to read an existing secret.

## loadSecret(file = SECRET_FILE)

Returns the secret, creating it once when it is missing. The doc comment says it is kept across restarts so a signed-in browser stays signed in, and that creation is atomic so a launcher and a server starting together end up with the same secret. Step by step:

1. Create the folder (`recursive`, mode `0700`).
2. If `readSecret()` finds a valid secret: call `makePrivate(file)` (which tightens a file whose mode lets others in) and return it.
3. Otherwise make 32 random bytes as hex, and write them with a newline to a temporary file `<file>.<pid>.<8 hex>.tmp` (mode `0600`), then `makePrivate(tmp)`.
4. Put it in place:
   - If `file` exists (present but not a valid secret), `renameRetry(tmp, file)` replaces it.
   - If not, `linkSync(tmp, file)` makes a hard link. This fails with `EEXIST` if another process created the file meanwhile, which is how two starters agree.
5. If that throws:
   - With a code from `NO_LINKS` (`EPERM`, `ENOTSUP`, `EXDEV`, `EINVAL`, `ENOSYS`: file systems that cannot make hard links) and no `file` yet, it writes the file directly with flag `wx` (exclusive create) and `makePrivate()`s it. An `EEXIST` there means another process won and is ignored; any other error is thrown.
   - `EEXIST` is ignored (another process won).
   - Anything else is thrown.
6. The temporary file is always removed (`unlinkSync` in `finally`; an error there is ignored, since a rename has already moved it).
7. The file is read back with `readSecret()`. Whatever won the race is returned. If nothing valid is there, it throws `Could not create <file>.`

Covered by "platform: the secret is created once and read back the same".

## Runner

`type Runner = (cmd, args) => number | null`: runs a command and returns its exit status. The real one, `realRunner`, is `spawnSync` with `stdio: 'ignore'` and `windowsHide: true`. Tests pass their own.

## makePrivate(file, platform?, run?, env?)

Makes `file` readable only by the person.

- **POSIX:** if the mode has any group or other bits (`mode & 0o077`), `chmod` it to `0600`. A file that is already private is left alone.
- **Windows:** modes mean nothing there, so it runs `icacls <file> /inheritance:r /grant:r <user>:F`. That removes inherited permissions and leaves one full-control entry for the current user. The user is `USERDOMAIN\USERNAME`, or just `USERNAME` when there is no domain. With no `USERNAME` nothing runs. The exit status is not checked: the doc comment says a failure is not fatal because the data folder under `%LOCALAPPDATA%` is per-user anyway.

Covered by "platform: the secret is made private with modes on POSIX and with icacls on Windows".

## renameRetry(from, to, platform?)

`renameSync`, retried while Windows reports the target busy (codes in `BUSY`: `EPERM`, `EBUSY`, `EACCES`, as when antivirus or the search indexer briefly holds a file). It makes up to ten tries, waiting 20, 40, … 180 ms between them (`Atomics.wait`, a synchronous sleep), about 0.9 s in all. On any other platform, or with any other code, the first error is thrown. Covered by "platform: renames are retried only on Windows, and only while the target is busy".

Within the server only `loadSecret()` calls this copy. `server/storage/atomic.ts` has its own `renameRetry()` with the same logic plus an injectable `rename`, which the storage code uses.

## Related pages

[Security model](Security-Model.md#the-local-secret) · [server/transport/http.ts](Source-Http.md) · [server/transport/remote.ts](Source-Transport-Remote.md) · [server/main.ts](Source-Main.md) · [Command-line launcher](Command-Line-Launcher.md) · [Storage on disk](Storage-on-Disk.md)
