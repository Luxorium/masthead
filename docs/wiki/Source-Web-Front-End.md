# Web front end

The page you use in the browser. It is a **Svelte 5** app in `web/`, built by Vite into `dist/web/` and served by the Masthead server. **Svelte** compiles components (`.svelte` files holding markup, script and style together) into plain JavaScript. Svelte 5 marks reactive state with **runes**: `$state` (a value the page redraws when it changes), `$derived` (a value computed from others) and `$effect` (code that reruns when what it reads changes).

The page holds no authority. Everything it shows comes from the server over one WebSocket, and everything it does is a protocol message ([Browser/server protocol](Browser-Server-Protocol.md)), apart from image uploads and the remote-device sign-in, which use HTTP. This page describes version 0.2.0.

The 0.2.0 aim for the page (`docs/plans/0.2.0/web.md` section 0) is "simple by default": a first-time person sees a chat app with one message box, and nothing about tiers, effort or permissions until they want it. The code follows this with a Simple/Advanced switch, a team view that appears only once helpers exist, plain words in one file, and errors rewritten with a next step.

## Files

| File | What it is | Page |
|---|---|---|
| `web/index.html` | The page shell | [below](#the-page-shell-indexhtml) |
| `web/public/favicon.svg` | The icon | [Styles](Source-Web-Styles.md#webpublicfaviconsvg) |
| `web/src/main.ts` | Entry script | [below](#the-entry-script-maints) |
| `web/src/App.svelte` | Layout, banners, sign-in screens | [below](#layout-appsvelte) |
| `web/src/app.css` | Colours, palette, shared classes | [Styles](Source-Web-Styles.md#websrcappcss) |
| `web/src/lib/store.svelte.ts` | All server state; protocol client | [Web store](Source-Web-Store.md) |
| `web/src/lib/state/pure.ts` | Pure store helpers | [Web store](Source-Web-Store.md#pure-helpers-websrclibstatepurets) |
| `web/src/lib/signin.ts` | Key, device token, whoami | [below](#signing-in) |
| `web/src/lib/ui.svelte.ts` | Simple/Advanced, theme, widths, panels | [below](#simple-and-advanced-uisveltets) |
| `web/src/lib/text.ts`, `words.ts` | Every word the page shows | [Text and words](Source-Web-Text.md) |
| `web/src/lib/tiers.ts` | Tier colours and profiles | [Styles](Source-Web-Styles.md#tier-colours-tiersts) |
| `web/src/lib/markdown.ts` | Safe Markdown, draft rendering | [below](#rendering-markdown-safely-markdownts) |
| `web/src/lib/tools.ts` | Tool-line words | [below](#toolsts) |
| `web/src/lib/images.ts`, `images/*.svelte` | Pictures | [Images](Source-Web-Images.md) |
| `web/src/lib/*.svelte`, `transcript/`, `team/` | Components | [Web components](Source-Web-Components.md) |
| `web/src/lib/SettingsView.svelte`, `settings/`, `remote/` | Settings view, teams, agent programs, remote access | [Settings and remote access](Source-Web-Settings-and-Remote.md) |
| `web/vitest.config.ts`, `web/test/*` | Page tests | [Page tests](Source-Web-Tests.md) |

## Signing in

`web/src/lib/signin.ts` holds what the page needs to sign in, with no Svelte state, so it is tested on its own.

### The key on this computer

The page itself holds no secret and is served to anyone who may reach the server; the socket is what needs a key. `masthead` opens `http://127.0.0.1:PORT/#key=<secret>`. The key is in the URL fragment, which the browser never sends to the server or its logs. `?key=` from older launchers still works.

- `takeKey()` reads `key` from the fragment or the query and removes it from the address bar at once with `history.replaceState`, so it is not left in history or bookmarks. The rest of the fragment is kept as written (for example `#/c/<id>`), because `URLSearchParams` would re-encode it. It returns `{ key, untried }`.
- A key from the address is only a **candidate**. It replaces the key stored in `localStorage` under `masthead.key` only once a socket opened with it (`keepCandidate()`). `dropCandidate()` forgets a refused one. So a link to `…/#key=junk` cannot sign a browser out ([Connecting](Source-Web-Store.md#connecting)).
- `storedKey()` reads `localStorage` again each time, because another tab may have signed in with a newer key. If storage is refused (private mode), the key still works for this page load.
- `serverUp()` asks `/api/health`, which needs no key, to tell "refused" from "server down".
- `idFromHash()` reads `#/c/<id>`. `hasCandidate()` and `resetSignin()` are for tests.

The socket is opened with the subprotocols `masthead` and `key.<secret>`; the server checks the key and answers with plain `masthead`.

### Remote devices

A phone or other computer reaches Masthead only through the person's own Tailscale `serve`, over https ([Remote access](Remote-Access.md)). The local page is always plain http, so `isRemoteDevice()` is simply `location.protocol === 'https:'`.

- **Device token.** A device never has the key. Once the person approves it on the computer, it gets a token, kept in `localStorage` under `masthead.device` (`deviceToken()`, `saveDeviceToken()`, `forgetDeviceToken()`). The socket uses the subprotocol `device.<token>`. Image uploads send it in the `x-masthead-device` header.
- **`whoami()`** asks `/api/remote/whoami` with the token and returns `{state:'approved', role}`, `{state:'unknown'}` (no token, revoked or expired), `{state:'refused'}` (by policy), or `null` when it could not ask. A missing role reads as `read`.
- **Forget this device.** `forgetDevice()` removes the token and any pairing request in progress (`sessionStorage` key `masthead.pairing`). The store's `forgetThisDevice()` also tells the server (`forget_me`) and goes back to the pairing screen. The button is in Settings > This device, shown only on a device.
- **Roles.** `full`, `approve` or `read` (`DeviceRole`). The store turns them into `mayAct` and `mayAnswer` ([Web store](Source-Web-Store.md#connecting)). A device that may not send sees one plain line in place of the message box.

The pairing screen is `remote/RemoteSignIn.svelte` ([Settings and remote access](Source-Web-Settings-and-Remote.md#remotesigninsvelte)).

## The page shell (`index.html`)

`web/index.html` is the HTML Vite starts from. It sets `lang="en"`, UTF-8, a viewport with `viewport-fit=cover` (so the page can reach under a phone's rounded corners and home bar; the dock pads itself with `env(safe-area-inset-bottom)`), `color-scheme: light dark`, the title "Masthead" and the SVG icon. The body is one `<div id="app">` and the module script `/src/main.ts`.

## The entry script (`main.ts`)

`web/src/main.ts` mounts `App` into `#app` with Svelte's `mount`, and imports `app.css` and highlight.js's `github-dark` theme. Code blocks stay dark in both schemes so that theme fits ([Styles](Source-Web-Styles.md#light-and-dark)).

## `tools.ts`

One line: it re-exports `toolLine` and the `ToolLine` type from `shared/toolline.ts` ([Tool lines](Source-Shared-Toolline.md)). `toolLine(name, input, running?)` turns a tool call into a verb and a target, such as "Reading" and a file path. `ToolItem`, `TeamMap` and `PermissionCard` use it.

## Layout (`App.svelte`)

`App.svelte` is the root. On mount it calls `store.connect()` and listens for `hashchange`: a pasted sign-in address goes to `store.keyFromAddress()`, and `#/c/<id>` of a known chat opens it. An effect sets the tab title to "<chat title> · Masthead".

### Signed-out screen

- `signedOut` is `'device'` or `'withdrawn'`: the remote pairing screen, `RemoteSignIn`, with `withdrawn` set in the second case.
- Any other `signedOut` (`'nokey'`, `'refused'`): a centred box with "Masthead" and `T.signIn.open`. For `'refused'` it adds `T.signIn.refused` and a Try again button (`store.retryConnect()`). Backticks in these strings are shown as `<code>` by a small `code` snippet.

### Signed-in layout

From top to bottom, inside `div.shell`:

- A skip link, "Skip to the message box", to `#message` (the composer's textarea), and a polite live region (see [Accessibility](#accessibility)).
- `Sidebar` (the chat list), when `ui.sidebarOpen`.
- `main`, made `inert` while a drawer is open:
  - **Header:** ☰ (shown when the chat list is hidden or the screen is narrow), the chat title (a button; clicking it renames in place, Enter saves, Escape cancels, blur saves), or "New chat". Then, only when the chat has helpers, the **Team** button: "Team · 2 working" ("Team · 2" on a phone), which toggles the team panel.
  - **Banners:** "Lost the connection to Masthead. Reconnecting…" while disconnected after a first state; the usage banner (`store.rateLimit`): "You've reached your Claude usage limit." or "You are close to…", the reset time, and Dismiss.
  - **The view**, first match wins: `SettingsView` when `ui.settingsOpen`; `FirstRun` when the state says no backend can run (`!store.canRun`); `TeamMap` when `store.view === 'map'`, the chat has helpers and the screen is not narrow (with approval cards under it); otherwise the breadcrumbs (when a helper is on screen: the chain of agents and "Back to Alpha"), `Transcript`, and the dock.
  - **Dock:** remote device requests (`DeviceRequestCard`, local page only), approval cards (`PermissionCard`, if `mayAnswer`), and the `Composer` (if `mayAct`) inside `{#key store.composerKey}`, so each chat and helper gets its own composer with its own unsent text. Without `mayAct`, a note says what the device's role allows.
- `TeamPanel`, when the chat has helpers and `ui.teamOpen`.
- A backdrop button while a drawer is open; tapping it closes the drawers.
- The toast (`role="alert"`), showing `friendlyError(store.error)` ([Text](Source-Web-Text.md#friendlyerror)).

The map view's dock has approval cards but no device-request cards.

**When the team panel opens.** `hasTeam` is true when any agent other than the lead exists. In Simple, the panel stays closed until the person presses Team. In Advanced on a wide screen, an effect opens it when the first helper starts, unless the person has already opened or closed it (`ui.teamTouched`).

## Simple and Advanced (`ui.svelte.ts`)

`web/src/lib/ui.svelte.ts` holds page-only state that is not the server's business. It is kept per device in `localStorage`, because a phone and a desktop may want different things. One instance, `ui`, is exported.

| Field | Meaning |
|---|---|
| `advanced` | "Show team controls" (Settings > General). Stored as `masthead.advanced` = `'1'`/`'0'`; Simple (off) is the default. |
| `theme` | `'system'`, `'light'` or `'dark'`, stored as `masthead.theme`. `applyTheme()` sets `data-theme` on `<html>`, or removes it for system. |
| `teamOpen`, `teamTouched` | Whether the team panel is open, and whether the person opened or closed it themselves (then the page leaves it alone). |
| `narrow` | Width under 900 px (`max-width: 899px`). |
| `wide` | Width 1280 px or more. |
| `phone` | Width under 600 px. |
| `sidebarOpen` | The chat list is shown; starts closed on narrow screens. |
| `settingsOpen` | The settings view replaces the chat. |

The three widths are live `matchMedia` queries, re-evaluated on change, not read once. Where `matchMedia` is missing (tests) they read false.

Methods: `openSettings()` (closes the chat-list drawer on narrow screens), `closeSettings()` (focus returns to the ⚙ button, `#settings-gear`), `setAdvanced()`, `setTheme()`, `toggleTeam(open?)`.

What Advanced changes, and nothing else (the plan says it is only what is on screen):

- The team panel shows the levels with helpers at a time and thinking time (`TierControls`), and the memory line shows tokens.
- The team panel opens by itself on wide screens when the first helper starts.
- Under the message box, a line with the model, its thinking time and the "when to ask" mode.
- Settings > General shows "Let them decide how long to think".

Approval cards show in both modes.

## Layout per width

The grid columns come from the script, not from CSS: chat list `264px` when it is open and the screen is not narrow, the chat `minmax(0, 1fr)`, and the team panel `340px` when it is open and the screen is wide. The team panel's own `aside` is 316 px wide, so it does not fill that column (not checked in a browser).

| Width | Chat list | Team panel |
|---|---|---|
| 1280 px and wider | Column | Column beside the chat |
| 900–1279 px | Column | Drawer from the right |
| Under 900 px | Drawer from the left, starts closed; choosing a chat closes it | Drawer from the right |
| Under 600 px (phone) | As above | As above; header 56 px, shorter Team label |

A drawer is the `aside` made `position: fixed` with a shadow, at most 88% of the width. While one is open, `main` is `inert`, a backdrop covers the chat, and Escape closes it (unless a `role="dialog"` element is open). The team map is not offered on narrow screens. The phone layout is exercised by the browser test at 390 × 844; the other widths were only read from the code.

## Accessibility

- **Skip link** (`a.skip`, `app.css`): off screen until focused, then jumps to the message box.
- **Live region:** a polite `.sr-only` region announces "Alpha replied." when the lead stops running, and "Question from Bravo" or "Permission request from Bravo" when a new card appears in the open chat.
- **Focus:** approval and device-request cards take focus when they appear, unless the person pressed a key in the last 1.5 s, has text in the field they are in, or is already on another card. Focus goes to the card, not to Allow, so a stray Enter answers nothing. The settings view focuses its first control and Escape closes it; the image viewer focuses itself and gives focus back to the thumbnail. `:focus-visible` draws a 2 px accent outline.
- **Coarse pointers (touch):** `.btn` and many component controls get at least 44 px height; inputs, selects and textareas get 16 px text so iOS does not zoom. Stop buttons show their word on touch screens (there is no hover).
- **Reduced motion:** animations and transitions are cut to 0.01 ms and smooth scrolling is turned off; the running dot does not pulse.
- **Contrast:** `--faint` is the lightest grey that the comment says still passes WCAG AA (4.6:1 on `--bg`); palette colours are each at least 4.5:1 on the background per their comment.
- **Labels:** icon buttons have `aria-label`s; the transcript's live controls use `aria-expanded`; usage bars are `role="progressbar"`.
- **Checked by:** the browser test runs axe-core's WCAG 2 A/AA rules on the first load, the settings view, a chat with the team panel and the phone layout, and fails on serious or critical problems ([Page tests](Source-Web-Tests.md#browser-test-testuie2emjs)).

The contrast figures come from code comments and were not measured here.

## Rendering Markdown safely (`markdown.ts`)

Agents write Markdown, and their output is untrusted: it can quote web pages, files and tool results that an attacker wrote. `markdown.ts` turns it into HTML that cannot run script, restyle the page or imitate Masthead's own controls. How this fits the rest of Masthead's protections: [Safety model](Safety-Model.md). It exports `renderMarkdown`, `splitDraft`, `renderDraft` and `handleCopyClick`. `TextItem`, `ThinkingItem`, `InboundItem` and `DraftView` render with it; `Transcript` sets the copy handler.

`renderMarkdown(text)` runs these steps, in this order:

1. **Parse.** A private `Marked` instance parses the text with `gfm: true` (tables, strikethrough, task lists, autolinks) and `breaks: false` (a single line break is not a `<br>`).
2. **Raw HTML becomes text.** The renderer's `html` hook gets every piece of HTML written in the Markdown, block or inline, and returns it escaped (`&`, `<`, `>`, `"`), wrapped in `<p>` when it is a block. So a hand-written `<a style=…>Allow</a>` or `<div class="code-block"><button data-copy>` appears literally as text. Only markup that marked and this renderer generate reaches the next step. A side effect: `<br>`, `<details>` or `<kbd>` written by an agent show as text.
3. **Code blocks.** The `code` hook takes the first word of the info string as the language. If highlight.js (its `common` build) knows it, the code is highlighted, which escapes it; otherwise, or if highlighting throws, the code is escaped. The block is `<div class="code-block">` with an optional `<span class="code-lang">`, a `<button class="code-copy" type="button" data-copy>Copy</button>`, and `<pre><code class="hljs">…</code></pre>`.
4. **Sanitize with DOMPurify**, as a second line of defence: DOMPurify's defaults (no `<script>`, no event-handler attributes, no `javascript:` URLs), plus `FORBID_TAGS: ['style', 'form', 'input', 'iframe']` (so GFM task-list checkboxes are dropped), `FORBID_ATTR: ['style', 'id', 'name']`, and `ADD_ATTR: ['data-copy']`.
5. **Class filter.** An `uponSanitizeAttribute` hook keeps only class names matching `OWN_CLASS`, `^(code-block|code-lang|code-copy|hljs(-[\w-]+)?|language-[\w-]+|[\w-]+_)$`: Masthead's code-block classes, highlight.js classes (including sub-scope classes such as `function_`) and `language-…`. If none match, the attribute is removed. Step 2 already keeps agent text out of `class`; this makes sure classes such as `btn primary` or `toast` could not be borrowed even if that changed.
6. **Links.** An `afterSanitizeAttributes` hook sets `target="_blank"` and `rel="noopener noreferrer"` on every `<a>`.

The hooks are added once, when the module loads, to DOMPurify's shared instance; nothing else in the page uses DOMPurify.

The server's Content-Security-Policy (`img-src 'self' data: blob:`) stops a Markdown image from loading anything from another site, so it cannot be a tracking pixel ([Security model](Security-Model.md)). Pictures the person sends and tool images are not Markdown; they are `<img>` elements pointing at `/blob/…` ([Images](Source-Web-Images.md)).

The result is inserted with `{@html}`. Everything else from agents or tools (the person's own messages, tool input and results, notices, card text, map previews) is inserted as text, which Svelte escapes.

**Drafts.** `renderDraft(text)` renders a reply that grows every 70 ms. `splitDraft(text)` cuts it into finished blocks (each ending at a blank line outside a code fence, or where a fence closes) and the unfinished tail, and says whether the tail is inside an open fence. Finished blocks go through `renderMarkdown`, so each is rendered once and then comes from the cache. The tail is rendered with the same steps each time; a tail inside an unclosed fence is shown as escaped plain code with no highlighting until the fence closes. Because blocks are rendered apart, a list broken by a blank line can look split until the reply ends; the finished item is then rendered whole.

**`handleCopyClick(ev)`** is one click handler, set on the transcript column, that serves every Copy button. It finds the nearest `[data-copy]`, copies the text of the `<code>` in the same block with `navigator.clipboard.writeText`, and shows "Copied" for 1.2 s. Clipboard access needs a secure context; `127.0.0.1`, `localhost` and the https remote address count as one (not checked in a browser).

## Rendering speed

Measures in the code that keep big chats and big teams quick:

- **Markdown cache.** `renderMarkdown` keeps up to 500 results by their text, most recently used last. Transcripts are rebuilt on reload, reconnect and when a chat is opened; without the cache every text item would be parsed, highlighted and sanitised again.
- **Incremental drafts.** `renderDraft` renders only the unfinished tail per update (above). `DraftView` renders at most once per animation frame however fast updates come. The server sends draft deltas, not the whole text ([Draft deltas](Source-Web-Store.md#draft-deltas)).
- **Windowing.** `Transcript` renders only the newest 80 items; "Show earlier" adds 80 at a time and keeps the reading position. Each item except tool lines has `content-visibility: auto` with `contain-intrinsic-size: auto 120px`, so off-screen items skip layout and paint. Tool lines are left out because their negative margins need normal flow.
- **Paging from the server.** The store loads 100 items at a time and asks for older pages only when the window reaches the start of what is loaded ([Paged transcripts](Source-Web-Store.md#paged-transcripts)).
- **Clipped items.** Very long tool input or results arrive cut to 16 KiB and are fetched whole only when opened ([Clipped items](Source-Web-Store.md#clipped-items)).
- **One chat at a time.** In version 2 the page subscribes only to the open chat, so other chats' drafts and items do not reach it.
- **Images** load lazily, decode asynchronously and carry their width and height, so the layout does not jump.

`web/test/draft.test.ts` checks that a draft update costs far less than a full re-render; `transcript.test.ts` checks the windowing. Nothing here was timed in a browser.

## Related pages

[Web store](Source-Web-Store.md) · [Web components](Source-Web-Components.md) · [Text and words](Source-Web-Text.md) · [Images](Source-Web-Images.md) · [Settings and remote access](Source-Web-Settings-and-Remote.md) · [Styles and web build files](Source-Web-Styles.md) · [Page tests](Source-Web-Tests.md) · [Browser/server protocol](Browser-Server-Protocol.md) · [Security model](Security-Model.md) · [Safety model](Safety-Model.md) · [Build configuration](Source-Build-Config.md)
