# Updating, and where your data is kept

[Back to the guide](README.md)

## Where things are kept

Everything stays on your computer. Masthead sends nothing anywhere except through the agent program
you use (Claude Code or Codex) and, if you switch on remote access, to your own approved devices
over Tailscale.

| | Settings | Chats and the local secret |
|---|---|---|
| Windows | `%APPDATA%\Masthead` | `%LOCALAPPDATA%\Masthead` |
| macOS | `~/Library/Application Support/Masthead` | the same folder |
| Linux | `~/.config/masthead` | `~/.local/share/masthead` |

In these folders:

- `settings.json` holds your settings and teams.
- `conversations` holds your chats.
- `secret` is the key that lets your browser use Masthead. Keep it private; do not share it.

Claude Code keeps its own records of each chat in its own folder (`~/.claude`); Masthead picks them up
again when you continue a chat.

## Making a backup

1. Wait until no helper is working, then run `masthead stop`.
2. Copy both folders for your system (above) somewhere safe.
3. Run `masthead` again.

When a new version changes how chats or settings are stored, Masthead converts them the first time it
starts and keeps the old file next to the new one, with `.bak` at the end. Your own copy is still the
safest way back.

## Updating

Updating restarts Masthead, which stops any helper that is working. Wait until they have finished.
When updating from 0.2.0, a main assistant that was in the middle of a task does not carry on by
itself afterwards: send it any message.

New versions are listed on the [releases page](https://github.com/Luxorium/masthead/releases).
Masthead is not on the npm registry; it may be later.

**If you installed with the install command:** run the install command from
[Installing Masthead](installing.md) again, with the new version's address from the releases page
(the `.tgz` file listed under the release), then `masthead stop` and `masthead`. If you use the
service, run `masthead service install` instead of `masthead`; it restarts the service with the new
version.

**Once after updating to 0.2.1 or later, if you use the service:** run `masthead service install`
(or `scripts/install.sh` again). It rewrites the service so that one program running out of memory no
longer stops Masthead. `masthead doctor` and `masthead service status` say when the service is out
of date.

**If you installed from source:**

1. In the `masthead` folder you downloaded: `git fetch --tags`, then `git checkout v<new version>`
   (for example `git checkout v0.2.1`).
2. Windows and macOS (and Linux if you installed with npm):
   1. `npm ci`
   2. `npm pack`
   3. `npm i -g --os=none --cpu=none ./luxorium-masthead-<version>.tgz`
   4. `masthead stop`, then `masthead`. If you use the service, run `masthead service install` instead
      of `masthead`; it restarts the service with the new version.
3. Linux with `scripts/install.sh`: run `scripts/install.sh` again. If helpers are working it asks
   first (`--force` skips the question).

Your chats and settings are kept when you update.
