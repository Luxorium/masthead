# Page tests (web/vitest.config.ts, web/test/)

The tests for the page in Masthead 0.2.0: unit and component tests run by Vitest, and the browser test `test/ui.e2e.mjs`. How to run all tests and the latest results are on [Tests](Source-Tests.md); this page says what each page test file checks.

Run with `npm run test:web` (`vitest run --config web/vitest.config.ts`).

## `vitest.config.ts` and `setup.ts`

`web/vitest.config.ts` uses the Svelte Vite plugin with the project's `svelte.config.js` and `dev: true`, `root: 'web'`, and the `browser` resolve condition (so Svelte's browser build is used, which component tests need). Tests run in **happy-dom** by default and match `test/**/*.test.ts`. Its comment names three kinds: pure helpers, the store driven by fake server messages, and components rendered into happy-dom. The real page against a real server is the browser test's job.

Files that need DOMPurify (`markdown.test.ts`, `draft.test.ts`, `transcript.test.ts`) switch to **jsdom** with a `// @vitest-environment jsdom` line: DOMPurify does not work properly under happy-dom (it keeps `javascript:` links).

`web/test/setup.ts` unmounts rendered components after each test (`cleanup()` from `@testing-library/svelte`), so one test's DOM never leaks into the next.

## Test files

| File | What it checks |
|---|---|
| `signin.test.ts` | A key from the fragment is a candidate and leaves the address; the rest of the fragment is kept; a candidate is stored only once accepted; a dropped candidate falls back to the stored key. |
| `device.test.ts` | Remote devices: a brief refusal keeps the token while the server still knows the device; the token is forgotten only when the server says it is no longer valid; Forget this device tells the server, clears the token and the pairing, and signs out. Roles: a `read` device gets no Stop button and may neither act nor answer; `approve` may answer but not act; this computer may do both. |
| `store.test.ts` | Version 1 store: pending approvals are replaced by every state; a refused message goes back to its composer, but not over newer typing; the usage banner follows the worst window and a dismissal holds until it changes. |
| `store-v2.test.ts` | Version 2: approvals arrive as summaries and the page subscribes to the open chat; a draft builds from deltas and a gap sends `draft_sync`; a reconnect resubscribes from the last `seq` and keeps the loaded transcript; an older page goes in front and keeps the newer copies. |
| `pure.test.ts` | `settingsPatch` sends only what changed and is empty when nothing did; `worstLimit` and `limitKey`. |
| `markdown.test.ts` | Raw HTML from an agent shows as text; a hand-made code block cannot get through; the page's own code blocks and highlight classes stay; `javascript:` links are dropped and links open in a new tab safely. |
| `draft.test.ts` | `splitDraft` splits at blank lines outside fences, not inside an open fence, and where a fence closes; `renderDraft` ends with the same text as a full render, shows an unclosed fence as escaped code, and costs far less per update than re-rendering a 30 KB answer; the Markdown cache returns the same HTML without parsing again. |
| `transcript.test.ts` | A long chat renders only the newest page and adds earlier pages on request. |
| `permission-card.test.ts` | The card names the agent and takes focus when nobody is typing; two questions with the same text keep both answers. |
| `text.test.ts` | No team jargon in any string of `T`; `friendlyError` rewrites known errors and passes others through ([The jargon test](Source-Web-Text.md#the-jargon-test)). |
| `words.test.ts` | Token counts, the home folder as `~`, known stop reasons, the words for each status, Windows homes without case, child paths with the parent's separator. |
| `tiers.test.ts` | Colours come from the profile, with 0.1.x names as a fallback; the team controls show one box per level of the chat's profile, named by its label. |
| `settings-logic.test.ts` | Usable teams, plain and specific problems, no banned words in problems, adding/removing/copying levels, fitting thinking time to a new model, reading a malformed backends report. |
| `settings-components.test.ts` | `BackendsSection` (one next step and the note per program); `ProfilesSection` (the Codex proposal; editing with the program's real models, refusing a bad team in plain words, saving; copy, remove, reset through the server; a team whose program is not ready); `ProfileChip` (menu, pick, Esc returns focus; only teams that can start). |
| `settings-fixtures.ts` | Not a test: shared data for the settings tests, a Claude and a Codex team and a backends report. |
| `remote-section.test.ts` | `DeviceRequestCard` (device, code, plain warning, decision with the role); `RemoteSection` (switch on, address, port locked; operator command with Copy, the warning as sent, Tailscale missing; devices with role change, removal, last use and expiry; loading the activity). |
| `remote-signin.test.ts` | Asking, the code, the poll secret kept across a reload, handing over the token; polling again after a reload instead of asking; plain words for not allowed, refused, too many and withdrawn; the reason for a refusal or rate limit; an approved stored token connects at once. |

Store tests build a `Store`, give it a fake socket object and call `receive()` with server messages; nothing connects.

- `no-inline-text.test.ts`: scans every `.svelte` file under `web/src` and fails if English is written between tags or in an `aria-label`, `title`, `placeholder` or `alt` attribute instead of coming from `text.ts` ("Masthead" and "Copy" are allowed). It keeps all user-facing text in one reviewable file.

## Browser test (`test/ui.e2e.mjs`)

`test/ui.e2e.mjs` drives the built page in headless Chromium (Playwright) against a running test server and saves screenshots. It must run against a test server with its own `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, never the installed app. With `MASTHEAD_E2E_BACKEND=fake` the server uses the fake backend, which answers scripted phrases; checks that need a model's own writing are then skipped. Setup and the settings file are on [Tests](Source-Tests.md#browser-test-testuie2emjs).

What it checks on the page, in order:

- **Sign-in:** no key and a wrong key show the sign-in page; Try again connects once another tab stored the right key; a key in the fragment works and leaves the address; a link with a wrong key, opened fresh or pasted into the open tab, does not sign the browser out.
- **Simple by default:** at most 10 visible controls on first load (the skip link not counted; the plan's target is 7), no jargon in the visible text (tier, Opus, Sonnet, Haiku, effort, sub-agent, lead), no team panel, and an example prompt fills the box without sending.
- **Settings view:** opens from ⚙ with Enter, Escape closes it and gives focus back; folded reports and team controls survive a reload; Remote access says Tailscale is missing on a test server; the team editor refuses an empty name in plain words.
- **Composer:** a message over 400,000 characters is refused and the text comes back.
- **Team:** approval cards appear, name the agent, take focus when nobody is typing and Allow works; the team panel opens by itself in Advanced on a wide window; the per-level stepper; the map, a card three levels deep, the hover preview with real content, Stop from the map, opening a helper and coming back, the message box naming its addressee; folded reports; the usage line.
- **Reload:** the chat comes back from disk.
- **Pictures** (fake backend only): a tool image shows as a thumbnail, opens full size, and Escape closes it with focus back on the thumbnail; a PNG attached in an existing chat is uploaded and shown in the sent message.
- **Phone** (390 × 844, touch, light theme): the chat list starts closed, choosing a chat closes the drawer, the team opens as a drawer and tapping outside closes it.
- **Accessibility:** axe-core's WCAG 2 A/AA rules on the first load, the settings view, a chat with the team panel, and the phone's new chat; serious or critical problems fail.
- **No page errors:** uncaught errors and console errors fail the run, except the refused sockets (403) of the sign-in checks.

## Related pages

[Tests](Source-Tests.md) · [Web front end](Source-Web-Front-End.md) · [Web store](Source-Web-Store.md) · [Build configuration](Source-Build-Config.md#webvitestconfigts)
