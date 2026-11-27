# Security

Masthead runs a local server that can start agents acting as you, so security problems matter.

## Reporting a problem

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/Luxorium/masthead/security/advisories/new),
not as a public issue. Say what you found, how to reproduce it, and which version you used.
You can expect a first answer within a week.

Things that are in scope:

- anything that lets another user on the same machine, a web page, or a device on the network reach
  or drive the local server;
- leaks of the local secret (the `secret` file, the sign-in file, the sign-in address);
- ways for agent-written text to run script in the page;
- ways for an agent to get past the team rules (tiers, limits, stopping).

What Masthead does and does not defend against is described in
[docs/wiki/Security-Model.md](docs/wiki/Security-Model.md) and
[docs/wiki/Safety-Model.md](docs/wiki/Safety-Model.md). Problems in Claude Code itself belong with
Anthropic.

## Supported versions

Only the latest release gets security fixes.
