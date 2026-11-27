# Troubleshooting

[Back to the guide](README.md)

## Start with `masthead doctor`

Open a terminal and run `masthead doctor`. It checks your set-up and prints one line per check:

- `[ OK ]`: fine.
- `[WARN]`: worth a look, but Masthead works.
- `[FAIL]`: needs fixing. The line under it, starting `fix:`, says what to do.

| Check | If it fails, what it says to do |
|---|---|
| **Node.js** | "Install Node.js 22 or newer." |
| **Claude Code** | Not found: "Install Claude Code (https://code.claude.com/docs/en/setup) and sign in by running `claude` once." Found but its version could not be read: "Check that `<path> --version` works." |
| **Config folder**, **Data folder** | "does not exist yet (made on first start)" is fine. Not a folder: "Move … out of the way." Not writable: "Make … writable by your user." |
| **Secret** | "does not exist yet (made on first start)" is fine. A folder: "Remove …; a new secret is made on the next start." Readable by others (macOS, Linux): "Restart Masthead: a secret others could read is replaced with a new one (sign in again with masthead)." Windows, reachable by others: "Delete … and restart Masthead; a new private secret is made." |
| **Port 7717** (or the port your service uses) | "in use by another program": "Stop that program, or use another port: masthead --port <n>." "served by this Masthead" is fine. |
| **Service** | "not installed" is fine if you start Masthead yourself; to start it at login: `masthead service install`. Installed but not running: `masthead service install`. |
| **SDK private binary** | A `[WARN]`, not a failure: an unused private copy of Claude Code was installed with Masthead. Harmless, but you can reinstall without it: run the install command from [Installing Masthead](installing.md) again (it includes `--os=none --cpu=none`). |
| **Keep awake** | The tool that keeps the computer awake was not found, so it may sleep while agents work. On Linux: "Install systemd (systemd-inhibit), or keep the computer awake yourself". See [Keeping the computer awake](keeping-awake.md). |

## Common problems

**Another device cannot open the `….ts.net` address at all ("server not found", "can't resolve").**
That device's Tailscale is not using Tailscale DNS ("Use Tailscale DNS" off, `accept-dns=false`), so
it cannot look up `….ts.net` names. You can recognise it when the computer's own Tailscale address
(`100.x.y.z`, in the Tailscale app) answers a ping but the name does not. Fix it on that device: in the
Tailscale app turn on **Use Tailscale DNS** (Windows: tray icon → Preferences; phones: settings), or
run `tailscale set --accept-dns=true`. Then open the address again.

**Windows: "masthead.ps1 cannot be loaded because running scripts is disabled on this system."**
Stock Windows PowerShell does not run npm's `masthead.ps1`. Type `masthead.cmd` instead (for
example `masthead.cmd doctor`), or use Command Prompt, where plain `masthead` works. To make plain
`masthead` work in PowerShell for good, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
once (optional). `masthead doctor` on Windows prints its fixes with `masthead.cmd`.

**"SDK private binary" after installing with `--omit=optional`.** npm ignores `--omit=optional` for a
global install, so the unused private copy of Claude Code comes along anyway. Reinstall with
`npm i -g --os=none --cpu=none <package or .tgz>`: no platform package matches "none", so it is
skipped.

### The browser did not open, or opened without signing in

The page says "Open Masthead with the `masthead` command (`masthead.cmd` in Windows PowerShell) or
its launcher entry to sign this browser in", or "Masthead did not accept this browser's key. Open it
with the `masthead` command (`masthead.cmd` in Windows PowerShell) to sign in again".

1. Run `masthead` again.
2. Still not signed in? Run `masthead --no-browser` in a terminal. It prints a **sign-in address**.
3. Copy that address into your browser. Keep it private: anyone with it can use your Masthead.

This happens most with browsers installed as a snap or flatpak on Linux, which cannot open the small
sign-in file Masthead hands them.

### "Port 7717 is already in use", "Another Masthead (or another program) is using port 7717" or "Masthead did not start"

Another program, or another copy of Masthead, uses the port.

1. Run `masthead status`. If Masthead is already running, just run `masthead` to open it.
2. If another program uses the port, stop it, or use another port: `masthead --port 7790`
   (use the same `--port` with `masthead status` and `masthead stop`). If you installed the service
   with `masthead service install --port 7790`, the other commands use its port by themselves.
3. If the service runs on another port and you also started a second Masthead by hand on 7717,
   plain `masthead status` and `masthead stop` look only at the service's port. Add `--port 7717`
   to reach the other one.

### "Masthead needs Claude Code to work"

Masthead could not find Claude Code, or Claude Code is not signed in.

1. Install Claude Code ([setup](https://code.claude.com/docs/en/setup)).
2. Run `claude` once in a terminal and sign in.
3. Restart Masthead: `masthead stop`, then `masthead`.
4. Press **Reload this page**.

If you installed Claude Code while Masthead was running as a service, run `masthead service install`
again so the service finds it. `masthead doctor` shows where Masthead looks.

### "Masthead isn't answering" or "Not connected"

The page lost Masthead. Run `masthead status`; if it is not running, run `masthead`. If it does not
start, run `masthead serve` in a terminal to see why.

### "You've reached your Claude usage limit."

Your Claude plan's limit was reached. Helpers pause (**Paused until … · usage limit**) and carry on by
themselves when it resets. Nothing is lost.

### Something else

- Check [GitHub issues](https://github.com/Luxorium/masthead/issues), or open a new one with what you
  did, what you saw and the output of `masthead doctor`.
- Report security problems privately, as [SECURITY.md](../../SECURITY.md) describes.
