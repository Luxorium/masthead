# Masthead 0.2.0: plan

Written 2026-11-27 by the lead from six designs in this folder: `core.md` (foxtrot), `backends.md`
(echo), `codex.md` (bravo), `tailscale.md` (golf), `web.md` (charlie), `distribution.md` (delta).
Those files hold the detail and the evidence; this page is the order of work and the decisions.

## What 0.2.0 is

Masthead for anybody, not one person's machine: simple by default, on Linux, macOS and Windows,
installed from a package, able to run a team on Claude Code or on Codex, reachable from the user's
other devices over their own Tailscale, and showing images. Underneath, a new base: team rules as a
tested state machine, backends behind one interface, team profiles instead of fixed tiers, versioned
settings, storage and protocol.

## Decided by the person

- Codex, Tailscale access, images, prepackaged installs, macOS and Windows are all in 0.2.0.
- Ships as staged pre-releases (0.2.0-alpha.N, -beta.N); public users stay on 0.1.4 until final.
- Agents keep the names Alpha, Bravo … in Simple mode; levels are called by model name.
- Tailscale: Masthead itself turns `tailscale serve` on and off from a switch in settings (the user
  must be the Tailscale operator). It must never reset or touch other serve entries.
- A newly approved remote device may do everything the local browser can. (The lead's note: this
  includes changing the permission mode. The role can still be lowered per device, shutting Masthead
  down stays local-only for technical reasons, and the page says plainly what approving a device means.)
- New installs follow the user's own CLI settings for when agents ask before acting.

## Decided by the lead (recommendations taken)

Tiers capped at 5 per profile. Mixed backends inside one team: later. Old protocol kept for one release.
Way back from an upgrade: backup files. Remote devices cannot approve other devices; tokens last 30
days, renewed on use; other tailnets' users and tagged devices refused by default; private socket, with
a loopback port only as fallback. Large photos shrunk in the browser. Theme stored per device. Page
text gathered in one file, no translations yet. No telemetry. Single-file installers with Node inside:
0.3.0.

## Gates before anything is published outside GitHub pre-releases

These are the person's, and nobody has done them:

1. **Anthropic's terms.** The Agent SDK page says third-party developers may not offer claude.ai
   login, including agents built on the SDK, unless approved; the legal page allows an end user signing
   in to the unmodified Claude Code binary with their own subscription. Masthead is the second case by
   design but uses the SDK to drive it. Write to Anthropic before a wide launch (`distribution.md`).
2. **OpenAI's terms** for driving a signed-in Codex: nothing found either way; not fully read.
3. **The name.** `masthead` is taken on npm (proposal: `@luxorium/masthead`); a MASTHEAD trademark
   exists for business/financial services and there is a company Masthead Data. No check has been done.
4. **Codex's own sub-agents** could not be switched off in tests (`codex.md`). Until solved, a Codex
   team cannot guarantee the tier rules. Blocker for the Codex stage, not for the others.

## Stages

Every step keeps the unit tests, the live run and the browser run green before the next begins.
Cross-review (nobody reviews their own code) before each pre-release tag.

**Stage A: the new base, same behaviour → 0.2.0-alpha.1**
- Core 0 characterisation tests; Core 1 move files into folders (alone: it touches every server file).
- Core 2 backend seam and runtime (echo); Core 3 state machine (foxtrot).
- Platform fixes for macOS and Windows; package clean-up; CI on three systems; `masthead service`
  and `masthead doctor` (delta). Fake backend so CI needs no account (echo, after Core 2).
- Web W1 simple layout and plain language; W2 phone layout and accessibility; W3 rendering speed;
  W4 split components and store (charlie).

**Stage B: data and protocol → alpha.2**
- Core 4 settings v2 and team profiles; Core 5 storage format 2 and image files; Core 6 protocol v2;
  Core 7 prompts and tools neutral.
- Web W5 protocol v2; W6 images; W7 tiers from data.

**Stage C: remote access → alpha.3**
- Tailscale: `remote/` module, device approval, tokens, roles, audit log; W9 remote sign-in and
  device management in the page.

**Stage D: Codex → beta.1**
- Codex adapter on `codex app-server`; model catalogue; Codex profile; W8 settings view and profile
  editing. Needs gate 4 solved or an enforced fallback.

**Then:** full review, docs and wiki, migration test from 0.1.4 data, packages, 0.2.0.

## Ownership while building

One owner per file at a time, set by the lead in each brief. Agents do not commit; the lead commits at
each green checkpoint on branch `next`. Opus agents may use Sonnet agents, and those Haiku agents, for
separable work, with exact file lists.
