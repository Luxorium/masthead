# 0.2.0: the page

Design for the web page (`web/`) in Masthead 0.2.0. Written by charlie from the 0.1.4 code on branch
`next` (478601f) and from `core.md` (foxtrot), `backends.md` (echo) and `tailscale.md` (golf).
Nothing here has been built or tried in a browser. Sizes: S = under a day, M = 1–3 days, L = a week.

The person's goals for 0.2.0, in the order this page weighs them: **suit anybody** (simple, minimal,
plain language, accessible), images visible in the app, remote use from a phone, more than one agent
backend with configurable tiers, and a page that stays fast with big teams. Masthead keeps its own
ink-and-paper look (serif headings, paper and ink tokens, one cobalt accent) and borrows only
principles from other chat products, never their look or marks.

---

## 0. Simple by default

A first-time, non-technical person should see a chat app: one message box, one obvious action, and
nothing that needs knowing what a tier, an effort level or a permission mode is. Everything about the
team is there when wanted and out of sight until then. Every other section of this document was
checked against this one; where they pull apart, this one wins (see 0.9).

### 0.1 What a first-time person sees

- **Centre:** the heading "What are we working on?", the message box with "Ask for anything", and
  under it three example prompts (0.5). The box has focus.
- **Under the box:** one quiet chip, "Folder: ~/projects/site", only because the folder decides what
  the agents may touch. Nothing else under the box until there is something to stop.
- **Left:** the list of chats (empty: "Your chats appear here"), a "New chat" button, and at the
  bottom the ⚙ settings button. On a phone this is a drawer behind ☰.
- **Right:** nothing. The team panel is closed and has no toggle until the main assistant starts a
  helper.
- **Header:** the chat title, and later a "Team" button (0.2). No path, no tabs, no panel toggle.

Controls visible and focusable on first load: today 24 (sidebar 3, header 3, team panel 15 with
steppers and selects, composer 3). Target: **7** (New chat, settings, folder chip, three examples,
the box; the send button is disabled until there is text).

### 0.2 Progressive disclosure

- **The team appears when it exists.** When the main assistant starts its first helper, a "Team · 2
  working" button appears in the header. It opens the team view (today's team panel and map merged,
  0.8). Nothing about tiers is shown before then.
- **Simple / Advanced** is one switch in Settings > General ("Show team controls"). Simple
  (default): the team view shows who is doing what, with Stop; limits, thinking time, models and
  profiles live in Settings only. Advanced: the team view opens beside the chat on wide screens and
  shows per-level limits and thinking time inline, as the 0.1.x panel does. No other behaviour
  differs between the two; it is only what is on screen.
- **Approval cards are never hidden.** A question or a permission request always shows, in plain
  words, in Simple too.
- Model names, effort, limits, permission mode, profiles, backends and remote access are all in the
  settings view (section 5), each with a one-line explanation.

### 0.3 Sensible defaults

Nothing needs configuring to get a first answer. Defaults stay as in 0.1.4 (automatic thinking time,
lean helpers, the built-in Claude profile, the person's own Claude Code permission settings) with one
open question: whether new installs should default to "Always ask me" instead of "As set in Claude
Code" (decision D2). The folder defaults to the last one used, else the home folder.

### 0.4 Plain language

Labels in the UI today and what replaces them. Model names stay visible where a choice is made
(settings, Advanced), never as the only label.

| Today | Replacement |
|---|---|
| lead / "The one you talk to" | main assistant (shown by its name, e.g. Alpha) |
| sub-agent, agent (for helpers) | helper |
| tier, Opus / Sonnet / Haiku boxes | levels, each called by its model name ("Opus 5.5", "Sonnet 5.5"), in Simple too (decision D3); the word "tier" goes |
| Effort / Effort up to / Low Medium High Extra | Thinking time / Up to: Short, Medium, Long, Longest |
| Automatic effort | Let them decide how long to think |
| At once · 2 now · 1 queued | Helpers at a time · 2 working · 1 waiting its turn |
| Lean Opus / Lean Sonnet and Haiku | Keep helpers light (skip your connected services) |
| Permissions: Use my Claude Code settings / Ask me first / Accept file edits, ask for the rest / Auto (a classifier decides) / Bypass all checks | When to ask you: As set in Claude Code / Always ask / Ask, except for file edits / Decide automatically / Never ask (risky) |
| Fold agent reports | Show helper reports as one line |
| Longest run for a sub-agent | Longest a helper may work |
| Context · Lead: 24k of 1.00M tokens | Memory used: 2% (tokens in Advanced) |
| Team map / Chat tabs | one "Team" button; the chat is always the main view |
| Queued / Waiting / Waiting on its agents | Waiting its turn / Waiting for helpers |
| Task from Alpha / Report from Bravo / Message from | Asked by Alpha / Bravo finished / Bravo says |
| Stop this turn (■) | Stop |
| Stop everything | Stop all |
| Always allow | Allow for this session |
| Skip (question) | Don't answer |
| Usage: Current session (5 hours), Weekly, all models | Usage: This session, This week |
| "Claude Code not found" | "Masthead needs Claude Code to work" (onboarding, 0.6) |

All strings move to one file (`web/src/lib/text.ts`, section 6.5), which makes this table the file's
review checklist.

### 0.5 Empty state that teaches

Under the box on a new chat, three example prompts as buttons. A click puts the text in the box (it
does not send), so the person sees what a good request looks like and can edit it:

- "Look through this folder and tell me what this project does."
- "Find and fix the failing tests, then explain what was wrong."
- "Write a short README for this project."

When the folder has no files the first one becomes "Start a small website here with a home page and
a contact form." The prompts are fixed text in `text.ts`; no model call.

### 0.6 First run, at most three steps

Shown only when something is missing; a person with Claude Code installed and signed in sees none of
it and lands on 0.1.

1. **An agent to work with.** "Masthead needs Claude Code (or another supported coding agent) on this
   computer." Status per backend from `state.backends`, the install and sign-in command to copy, and
   "Check again" (needs a server re-detect message; echo).
2. **A folder.** "Which folder should the agents work in?" The folder picker, with the home folder
   preselected and one sentence on why it matters.
3. **Ask.** The normal empty state.

Remote devices skip 1 and 2 (they use the computer's settings) and see golf's pairing screen first.

### 0.7 Errors: what happened, and one next action

Each error the page shows gets a plain sentence and one button or instruction. Examples:

| Today | Becomes |
|---|---|
| "Not connected to Masthead. Is it still running?" | "Masthead isn't running on this computer. Start it from the app menu or with `masthead`." + Try again |
| "The message is too long." | "That message is too long to send (over 400,000 characters). Attach it as a file in the folder and mention its name." |
| "That conversation no longer exists." | "This chat was deleted in another window." + Go to chats |
| "<x> is not a PNG, JPEG, GIF or WebP image…" | "Only pictures can be attached (PNG, JPEG, GIF, WebP). For other files, put them in the folder and mention them." |
| usage limit reached banner | "You've reached your Claude usage limit. It resets at 11:00." (+ "Helpers will carry on then" once pausing ships) |
| Sign-in refused | as in 0.1.4: one sentence and "Open Masthead with the `masthead` command" + Try again |

Rule: no error without a next action; no raw exception text as the only content (it goes behind
"Details").

### 0.8 Removed or merged

- Header path → removed (the folder chip under the box and the chat's settings show it).
- Chat / Team map tabs and the ◧ panel toggle → one "Team" button that opens the team view.
- Team panel and team map → one team view with two layouts: a list (default, works on phones) and
  the map (wide screens, Advanced or on request).
- Per-tier limits and effort selectors in the panel → settings (inline only in Advanced).
- Context section → one "Memory used" line in the team view; tokens in Advanced.
- Usage section in the team panel → a small usage line in the sidebar footer that expands; the
  warning banner stays.
- Version and Claude Code path in the settings popup → Settings > About.
- Settings popup → a settings view (5.3).
- The sidebar footer's connection dot → shown only when disconnected (the banner says it anyway).

### 0.9 How we know it worked

No telemetry: Masthead is local and sends nothing about its users. Measured in the browser test and
by watching people:

- Controls focusable on first load: 24 → ≤ 7 (counted by the browser test).
- Actions from first load to a sent message: type + Enter (1 action), checked by the test.
- Time to first visible token after Enter (test, against the fake backend: page cost only).
- Jargon words visible on first load and in Simple: 0 (the test greps rendered text for "tier",
  "Opus", "Sonnet", "Haiku", "effort", "sub-agent", "lead").
- Errors without a next action: 0 (a unit test over `text.ts` error entries).
- Hallway test: three people who have never used a coding agent each get a first answer without
  help, and can stop a helper, in under five minutes.
- Accessibility checks pass (6.4).

---

## 1. Images in the app

Today a tool result that contains an image is stored and shown as the text "[image]"
(`toolResultText`, `server/agent.ts` 129–140), and images the person attaches are sent to the model
and kept only as a count (`Item.user.images: number`). 0.2.0 stores them and shows them.

### 1.1 Storage (server; sent to foxtrot)

- Blob files beside the conversation: `<data>/conversations/<convId>/blobs/<sha256>.<ext>`,
  content-addressed, written atomically, de-duplicated within the conversation.
- Accepted: PNG, JPEG, GIF, WebP. The type comes from the file's magic bytes, never from the client
  or the SDK's `media_type`; a mismatch is rejected. **No SVG** (it can carry script).
- Width and height read from the header (a small header parser, no native image library). Caps:
  10 MB per file, 8192 px a side, 40 megapixels (decompression-bomb guard), 500 MB per conversation.
- Sources: the person's uploads; image blocks in tool results (each stored as a blob, its ref put on
  the tool item instead of "[image]"); later, images produced by a backend in text.
- What the model receives is unchanged: user images still go as base64 blocks, built from the stored
  file.
- No server-side thumbnails in 0.2.0 (they need a native dependency such as sharp). The page scales
  with CSS and lazy loading; revisit if phones struggle.
- Deleting a conversation deletes its folder, blobs included.

### 1.2 Item shape (agreed with foxtrot)

`BlobRef = { blob: sha256hex, mediaType, w, h, bytes }`.
`user` items: `images: BlobRef[]` (replacing the count; old items with a number show "2 images
attached" as today). `tool` items: `images?: BlobRef[]` beside `result`.

### 1.3 Fetching: a per-socket blob token

The page signs in with a key sent as a WebSocket subprotocol, so a plain `<img src>` carries no
credential. Chosen: the `state` message carries a **`blobToken`**, random per socket and valid while
that socket is open (plus about 60 s). Images are `<img src="/blob/<convId>/<hash>?t=<token>"
loading="lazy" decoding="async" width height>`. Both parts are validated and the server looks only
inside that conversation's folder (no hash index, no path from the client) and answers with the sniffed `Content-Type`, `X-Content-Type-Options: nosniff`,
`Content-Disposition: inline`, `Cache-Control: private, max-age=31536000, immutable` and
`Content-Security-Policy: default-src 'none'; sandbox`. CSP for the page stays `img-src 'self' data:
blob:`; `/blob/` is same-origin. Remote devices (golf) get their own token the same way over their
socket. When the token changes on reconnect, the page rewrites the query; cached images stay cached
because the browser cache key includes the query only for the first fetch (acceptable: one re-fetch
per reconnect at worst, mitigated by `immutable`).

Rejected:
- **fetch with a header → object URL:** no browser cache or native lazy loading, object-URL
  lifetimes to manage, more code, slower on phones.
- **A cookie:** adds a CSRF surface the subprotocol design avoids, and golf's remote devices
  authenticate per socket too.
- **Signed per-blob URLs with expiry:** more server state for nothing over a per-socket token.
- **data: URLs in items:** bloats transcripts and every socket message.

### 1.4 Upload

Paste, drop or "+" uploads each image at once with `POST /blob?conv=<convId>` (header `X-Masthead-Key`, or the
device token on remote; raw bytes) and gets a `BlobRef`; the thumbnail shows a progress ring and an
inline error on failure. `send` carries refs, not base64, so sending is instant and the 48 MB socket
frame limit stops mattering (it matters on phones over Tailscale). On the new-chat screen there is no
conversation yet, so the first message sends its images as base64 in the `send` itself (within the
0.1.4 caps: 5 MB each, 30 MB total); the server stores them as blobs of the new conversation before
delivering, and keeps accepting this permanently for `convId: null`. For existing chats base64 in the
socket stays as a fallback for one release. The page still checks type and
size before uploading. Optional (decision D4): downscale on the client to 2000 px on the long edge
when a photo is over 4 MB (the model downsizes anyway); off by default.

### 1.5 Showing images

- **Transcript:** the person's bubble shows its images as a row of thumbnails (max 160 px high, aspect
  kept, `object-fit: contain`). A tool line with images shows its thumbnails under the line even when
  the line is collapsed, because the image is usually the point (a screenshot). More than four: four
  and "+3".
- **Viewer:** clicking a thumbnail opens a dialog with the full image, its size, ← → between the
  images of that item, "Open in new tab" and Esc/close. Focus is trapped and returns to the thumbnail.
  Pinch-zoom on phones is the browser's own (the image is shown at natural size inside a scrollable
  box).
- **Reports and messages** between agents are text; an agent cannot reference a blob, and Markdown
  images from other sites stay blocked by the CSP (`img-src 'self'`), so no tracking pixels.
- **Hover previews and the team list** show "2 images" as text, not the images (cheap, and previews
  are small).
- **Composer:** thumbnails as today, now with upload state.

### 1.6 Safety

SVG never accepted; type by magic bytes; dimension and size caps before decoding; images only ever
rendered through `<img>` (never as a document, `<object>` or `<iframe>`), so a malformed file cannot
run script; the blob response itself is sandboxed by its own CSP in case it is opened directly;
`nosniff`; no client path reaches the file system. Agent Markdown keeps escaping raw HTML (0.1.1), so
an agent cannot inject an `<img>` pointing at a blob with a stolen token.

Sizes: page S–M (thumbnails, viewer, upload with progress), server M (foxtrot: blob store, route,
tool-result images). Depends on core steps 5 and 6.

---

## 2. Protocol with the server (agreed with foxtrot; foxtrot records it in core.md 7)

Version 2, negotiated: `{t:'hello', protocol: 2, caps}` → `{t:'state', protocol: 2, …}` or
`{t:'error', code:'protocol'}`. The page sends caps `drafts-delta`, `items-paging`, `blobs`,
`resync`. Errors carry `code` (`protocol`, `refused`, `not_found`, `too_large`, `invalid`) plus
`message` and `ref?`.

- **Global stream, always:** conversation list, settings, approval **summaries** for every
  conversation (`{id, convId, agentName, kind}`, for badges), usage, backends, `blobToken`.
- **Per conversation, after `{t:'subscribe', convId, since?}`** until `unsubscribe`: agents, items,
  drafts, full approval requests. The page subscribes to the open conversation only.
- **Resync:** every per-conversation event carries `seq`. On reconnect the page re-subscribes with
  `since`; the server replays from a ring buffer of the last 500 events of that conversation, or
  sends a fresh snapshot when `since` is older. The page keeps its loaded transcript pages either
  way, and after a snapshot fetches only items newer than its last item id.
- **Drafts as deltas:** `{t:'draft', convId, agentId, seq, kind, append}`, coalesced per 70 ms,
  subscribers only; joining mid-draft gives the whole draft once. A gap in `seq` → `{t:'draft_sync'}`
  for the full text. `draft_end` names the item that replaces the draft, so the swap does not flicker.
- **Paged transcripts:** `{t:'items', convId, agentId, before?, limit}` → `{items, cursor, more}`,
  newest page first. Live `item` events clip heavy fields (tool input/result over 16 KiB → head with
  `truncated: true`); `{t:'item_full', …}` fetches one whole item when the person opens it.
- **Capabilities and profiles:** `state.backends[] {id, label, available, version, caps}`;
  `conversation` messages carry the profile snapshot (ordered tiers with id, label, colour slot).
- **Settings:** partial patches, as in 0.1.4 (`SettingsPatch`), extended to the v2 shape.
- **Blobs:** `GET /blob/<convId>/<hash>?t=<blobToken>`, `POST /blob?conv=<convId>` (section 1).
- A v1 adapter on the server keeps a tab from before the upgrade working until it reloads.

All of the above is recorded by foxtrot in core.md sections 6.2 and 7 as agreed.

**What the store becomes** (today one 600-line class in `store.svelte.ts`):

| Module | Holds |
|---|---|
| `lib/net/connection.ts` | socket, sign-in key and candidate, health check, back-off, hello/caps, `seq` bookkeeping, request refs |
| `lib/state/app.svelte.ts` | global stream: conversations, settings, approval summaries, usage, backends, blob token |
| `lib/state/conversation.svelte.ts` | one class per subscribed conversation: agents, profile snapshot, full approvals, drafts, transcripts (`{pages, more, loading, cursor}` per agent) |
| `lib/state/composer.svelte.ts` | unsent drafts per chat and helper, pending sends by ref, uploads |
| `lib/state/ui.svelte.ts` | which chat and helper are open, team view open, drawer state, theme |
| `lib/state/reduce.ts` | pure functions `(state, msg) → state` for each server message, unit-tested without a browser |

---

## 3. Rendering performance

### 3.1 What is slow today (from the code)

- The draft is sent whole every 70 ms and re-rendered whole: `marked` + highlight.js + DOMPurify on
  the full text for each update (`Transcript.svelte`, `{@html renderMarkdown(draft.text)}`). Cost
  grows with length; a 20 KB answer with code blocks parses 14 times a second.
- Every item of a transcript is rendered, and each text item's Markdown is parsed again whenever the
  list is rebuilt (reload, reconnect, opening the chat).
- Hover previews fetch the whole transcript of an agent to show six lines.
- The team map re-renders every second for elapsed times.

### 3.2 Measure first

A perf harness, `web/perf/` (dev only): the real components fed synthetic data — a 2,000-item
transcript with 200 code blocks and 50 large tool results, a 30 KB draft streamed in 70 ms deltas, and
a 120-agent team. Playwright runs it and prints numbers; no telemetry. Targets:

| Measure | Target |
|---|---|
| Main-thread time per draft update (p95) | < 4 ms |
| Opening a long chat to first paint of the newest page | < 150 ms |
| Typing latency in the box while a draft streams | < 16 ms |
| DOM nodes for a 2,000-item chat | < 5,000 |
| Team view with 120 agents, one status change | < 8 ms |

### 3.3 Changes

- **Incremental Markdown for drafts:** split the draft into finished blocks and a tail at block
  boundaries (blank line outside a code fence, closed fence). Finished blocks are rendered once and
  cached by text; only the tail is re-rendered, in `requestAnimationFrame`, at most once per frame.
  An unclosed code fence in the tail is shown as escaped plain text in the code style until it
  closes (no highlight.js per token). The same safety pipeline (0.1.1) runs on every block.
  Rejected: streaming Markdown libraries (new dependency and a second sanitiser path to audit).
- **Memoised Markdown for items:** `renderMarkdown` cached by item id and text (LRU of ~500), so
  rebuilds do not re-parse.
- **Windowing without full virtualisation:** render the newest ~60 items; a sentinel at the top loads
  or reveals the previous page as the reader scrolls up (paging from section 2). Each item block gets
  `content-visibility: auto` with `contain-intrinsic-size`, so off-screen items cost almost nothing.
  Over ~400 rendered items, the oldest collapse into "Show earlier" again. Rejected: a virtual list
  with absolute positioning (variable heights jump, find-in-page and screen readers break, much more
  code).
- **Big tool outputs** arrive clipped (section 2) and are fetched whole only when opened.
- **Previews** ask for one page of six items (`limit: 6`) instead of the whole transcript.
- **Team view** for big teams: finished subtrees collapse to "+12 finished"; live agents first; the
  elapsed-time clock updates only the time text nodes.

---

## 4. Responsive layout

### 4.1 Problems today (with golf's list in tailscale.md 5)

Panels decided once from `innerWidth`; overlays without backdrops that stay open after a choice;
`height: 100%` so the keyboard covers the box; hover-only previews, Stop label, delete × and Copy;
inputs under 16 px (iOS zooms); tap targets of 20–32 px; a crowded 48 px header; the settings popup
at `100vh`; no safe-area insets; the map scrolls sideways.

### 4.2 Layout per width (re-evaluated with `matchMedia`, not once)

| Width | Layout |
|---|---|
| ≥ 1280 px | Sidebar 264 px · chat · team view 340 px when open (Advanced opens it by default when there is a team) |
| 900–1279 px | Sidebar · chat. Team view is a drawer from the right with a backdrop |
| 600–899 px (tablet portrait) | Chat only. Sidebar and team view are drawers with backdrops; a choice closes the drawer |
| < 600 px (phone) | Chat full width. Top bar 56 px: ☰, title, Team button (when there is a team), ⋯ (settings, rename, delete). Approval cards are a bottom sheet over the box. Settings full screen |

Everywhere: `height: 100dvh`; `viewport-fit=cover` and `env(safe-area-inset-bottom)` under the box;
inputs 16 px; under `(pointer: coarse)` every target is at least 44 × 44 px (round buttons, steppers,
icons, the image remove button); nothing hover-only (the delete action moves into the chat's ⋯ menu,
Copy is always visible on touch, Stop always shows its word on touch). Drawers close on Esc,
backdrop tap and choice, and trap focus while open.

### 4.3 Team view on small screens

Under 900 px the team is an indented list, not the horizontal tree: one row per helper with its
name, level colour, what it is doing and Stop. Tapping a row opens a sheet with the preview (last
lines), "Open chat" and "Stop". The map layout is offered on wide screens only.

### 4.4 Composer and cards

The box stays docked above the keyboard (`100dvh` plus `visualViewport` resize on iOS). The addressee
line ("To India · Sonnet 5.5" with Back) stays on one line and truncates the name. Cards in the bottom
sheet keep Deny/Allow at full width, Allow last (thumb side); the 0.1.1 focus rule stays.

---

## 5. Configurable tiers, backends and settings

### 5.1 Tiers from data

Tiers are hard-coded today: CSS classes `tier-lead/-opus/-sonnet/-haiku` with fixed colours, the team
panel's four boxes, `TIER_LABEL`. In 0.2.0 the conversation's profile snapshot drives everything:

- **Palette:** `web/src/lib/palette.ts` maps the profile's colour slot (`amber, violet, blue, teal,
  rose, green, slate, orange`) to a light and a dark value, each checked for 4.5:1 text contrast on
  its background and 3:1 for borders (a unit test computes it). Elements set `--tier` from the slot
  (`style:--tier`); the `.tier-*` classes go. A profile can only pick a slot, never a raw colour, so
  contrast always holds.
- **Team view and settings** list the profile's tiers in order (1 to 5, `MAX_TIERS` from core.md),
  each with its model name, helpers at a time and thinking time. No fixed four boxes.
- **Names:** a level is called by its model name ("Opus 5.5"), from the profile's tier label, in
  Simple and Advanced alike (decision D3).

### 5.2 Profile per conversation

On the new-chat screen, a second chip beside the folder, "Team: Claude", only when more than one
profile exists (so a person with one backend never sees it). The chat's settings show the profile it
uses; changing it for a running chat is not offered (core.md 4.4).

### 5.3 A settings view instead of a popup

The popup already holds seven controls and will not fit profiles, backends and remote access.
Settings become a view (`#/settings/<section>`) that replaces the chat area on wide screens and is
full screen on phones, with a section list:

- **General:** folder for new chats, when to ask you, longest a helper may work, show helper reports
  as one line, Simple/Advanced ("Show team controls").
- **Team profiles:** the list; each profile's levels (add/remove up to 5, model from the backend's
  list, thinking time, helpers at a time, keep light, colour slot); duplicate; reset a built-in one.
- **Backends:** each detected agent (Claude Code, Codex…), version, status, path override, "Check
  again" (echo's detection).
- **Remote access:** golf's switch, state, command to copy, devices with role and revoke.
- **Appearance:** theme System / Light / Dark, text size (Normal/Large), reduce motion (System/On).
- **About:** versions, paths, licence, links to the wiki.

Each control has a one-line explanation in plain words (0.4). Changes save as made (patches), as
today.

### 5.4 Theme

`data-theme="light|dark"` on `<html>`, or none for System (the existing `prefers-color-scheme` block).
Stored in `localStorage` per device, not on the server: a phone and a desktop may want different
themes, and the choice must apply before the socket connects (an inline-free early script is not
allowed by the CSP, so `main.ts` sets it before mounting).

### 5.5 Onboarding with no backend

Section 0.6 step 1. If no backend is available, the page shows that screen instead of the empty
chat, with status per backend from `state.backends` and "Check again". Needs a server message to
re-run detection (echo).

---

## 6. Component structure, state and tests

### 6.1 Splits

- `Transcript.svelte` (390 lines) → `TranscriptView` (scrolling, windowing, pinned-to-bottom) and one
  component per item kind: `UserItem`, `TextItem`, `ThinkingItem`, `ToolItem`, `InboundItem`,
  `NoticeItem`, plus `DraftView` (incremental rendering).
- `Composer.svelte` (400 lines) → `ComposerBox`, `AttachmentTray` (uploads), `AddresseeBar`,
  `ExamplePrompts`, `ComposerMeta`.
- `App.svelte` → `Shell` (layout, drawers), `TopBar`, `Banners`, `SignIn` (local key and golf's
  pairing).
- `TeamPanel` + `TeamMap` → `TeamView` with `TeamList` and `TeamMap` layouts and a shared
  `AgentRow`/`AgentCard`; tier settings move to the settings view.
- `SettingsMenu` → `SettingsView` with one component per section.
- The store → the modules in section 2.

### 6.2 Shared primitives

`Button`, `IconButton` (label required, 44 px on coarse pointers), `Dialog` and `Sheet` (focus trap,
Esc, return focus), `Drawer`, `Menu`, `Switch`, `Select`, `Field` (label + help line), `Chip`,
`TierBadge`, `StatusDot` (with text for screen readers), `Meter`, `BlobImage`, `ImageViewer`,
`StopControl` (exists), `Toast`. Each owns its accessibility; feature components stop hand-rolling
roles and focus.

### 6.3 Tests

- **Unit (node, no browser):** the reducers (`reduce.ts`), `settingsPatch`, `statusWords`,
  `shortReason`, the key/candidate logic (with a fake `location`/`localStorage`), incremental Markdown
  block splitting, the palette contrast check, `text.ts` completeness.
- **Component tests:** Vitest with `@testing-library/svelte` and happy-dom for primitives, the
  composer (send/restore/uploads), approval cards (focus rule, duplicate questions) and the
  transcript window. Markdown safety tests run here too (DOMPurify needs a DOM). New dev
  dependencies; decision D6.
- **Browser run:** `test/ui.e2e.mjs` split by area (`sign-in`, `settings`, `chat`, `team`, `images`,
  `phone`) with a shared fixture. A **fast suite against core's fake backend** (core.md step 0) costs
  no usage and runs on every change, including a phone viewport (390 × 844, touch) and both themes;
  the existing Haiku run stays as the slow end-to-end check.
- **Perf harness** (3.2) run on demand, numbers recorded in the release notes.

### 6.4 Accessibility baseline

| Area | Baseline | Cost |
|---|---|---|
| Keyboard only | Every action reachable; visible focus everywhere; skip link to the box; dialogs, sheets and drawers trap focus and return it; no hover-only control; Esc closes the top layer | M (mostly falls out of 6.2) |
| Screen readers | Landmarks (nav, main, complementary); every icon button labelled; a polite live region announcing finished replies, approvals and status changes (not each token); status dots carry text; the transcript is a list with headings per speaker | M |
| Contrast | WCAG AA in both themes: 4.5:1 body text, 3:1 large text and UI borders. `--faint` and some muted text likely fail today and must be measured and darkened/lightened | S |
| Motion | `prefers-reduced-motion` turns off the pulse, the streaming cursor blink and smooth scrolling; Appearance can force it | S |
| Zoom and text size | Usable at 200 % zoom and with Large text; no fixed heights that clip | S |
| Checks | axe-core in the browser run (dev dependency) with zero serious violations as a gate | S |

Total about 1.5 weeks spread over the steps, mostly inside the component splits.

### 6.5 Translatable text: structure now, translations later

Recommendation: **now**, but only the structure. All user-visible strings move to
`web/src/lib/text.ts` (one object; functions for plurals and names, `Intl.PluralRules` where needed;
dates already use `toLocaleString`). No library and no translations in 0.2.0. Reasons: the plain-
language rewrite (0.4) touches every string anyway, so doing it into one file costs little extra
(about 200 strings, M spread over the splits); one file makes wording reviews and the jargon test
possible; translating later becomes a data task. Rejected: a full i18n library now (weight and
ceremony for one language); leaving strings inline (the rewrite would have to be done twice).

---

## 7. Order of work

Each step keeps the page working, passes `npm run check`, the unit tests and the browser run.

| Step | What | Needs from the server | Size |
|---|---|---|---|
| W0 | Perf harness, test fixtures, `text.ts` skeleton; fast browser suite on the fake backend once core step 0 exists | core 0 (fake backend) for the fast suite only | M |
| W1 | Simple by default, part 1: plain labels through `text.ts`, example prompts, header decluttered, one Team button, team view hidden until a helper exists, errors with one next action, Simple/Advanced switch | none (v1 protocol) | M |
| W2 | Responsive and accessibility: `matchMedia` layout, drawers with backdrops, `100dvh`, safe areas, 44 px targets, 16 px inputs, no hover-only controls, contrast fixes, reduced motion, theme choice | none | M–L |
| W3 | Rendering: memoised Markdown, incremental draft rendering, `content-visibility`, client-side windowing over the full transcript | none (works on v1) | M |
| W4 | Component splits and primitives (6.1, 6.2), store split into modules with pure reducers and their tests, component tests | none | L |
| W5 | Protocol v2 client: hello/caps, subscribe/unsubscribe, draft deltas, resync by seq, paged transcripts, clipped items, approval summaries | core 6 (same step; v1 adapter covers old tabs) | M |
| W6 | Images: `BlobImage`, viewer, upload via `POST /blob`, tool-result images, attachment history | core 5 (blobs) and 6 (route, item shape) | M |
| W7 | Tiers from data: palette, team view and map for 1–5 tiers, profile chip on new chats | core 4 (profiles, snapshot in `conversation`) | M |
| W8 | Settings view with sections; profile editor; backends section and no-backend onboarding | core 9 (user profiles), echo's detection and re-detect message | L |
| W9 | Remote: pairing screen, device approval card, Remote access section, phone pass on a real device | golf's remote server, after W5 | M |

W1–W4 need nothing from the server and can start now; they also make every later step smaller. W5
must land with core step 6. Total about 7–9 weeks of page work for one agent, less with W1–W3 in
parallel.

---

## 8. Alternatives rejected

- **A rewrite in another framework or a component library.** Svelte 5 is fine; the problems are
  structure and wording. A component library would also bring someone else's look.
- **Keeping the settings popup and adding tabs.** It is a popover; profiles and devices need room
  and deep links.
- **Server-rendered or native mobile app.** The phone gets the same page over Tailscale; one code
  base.
- **Full list virtualisation.** See 3.3.
- **Per-tier CSS classes kept with generated names.** Colours must come from data with checked
  contrast; slots do that.
- **Hiding the team entirely in Simple.** People need to see that helpers are working and be able to
  stop them; Simple hides controls, not activity.

## 9. Risks

- **The v2 cutover** (W5) touches every state path at once. Mitigation: W4's pure reducers with
  tests first, the server's v1 adapter, and the fast browser suite.
- **Incremental Markdown** can mis-split constructs that span blocks (lists with blank lines,
  nested fences). Mitigation: a corpus of real agent output as unit tests; fall back to a full
  re-render when the split is unsure.
- **`content-visibility` scroll jumps** when estimated heights are wrong; tune
  `contain-intrinsic-size`, measure in the harness.
- **Plain-language labels drift from the wiki and prompts** (agents still say "sub-agent").
  Mitigation: the jargon test covers the page only; the wiki and prompts get a pass in the same
  release.
- **Contrast fixes change the look** slightly; keep the identity by adjusting only lightness.
- **Blob token in URLs** can appear in local history or screenshots; it is per socket and expires
  shortly after, and `Referrer-Policy: no-referrer` stays.

## 10. Decisions for the person

- **D1** Simple by default with an Advanced switch (recommended), or always show the team controls.
- **D2** Default "When to ask you" for new installs: "As set in Claude Code" (today) or "Always ask"
  (safer for newcomers, more cards).
- **D3 (decided by the person, 2026-11-27):** levels are called by model name ("Opus 5.5") in Simple mode too, not role names.
- **D4** Downscale large photos in the browser before upload (off by default, recommended) or never.
- **D5** Theme stored per device (recommended) or on the server for every device.
- **D6** Add Vitest, testing-library, happy-dom and axe-core as dev dependencies (recommended).
- **D7** Strings in one file now without translations (recommended), or leave until a translation is
  wanted.
- **D8 (decided by the person, 2026-11-27):** keep the phonetic agent names (Alpha, Bravo…) in Simple mode.