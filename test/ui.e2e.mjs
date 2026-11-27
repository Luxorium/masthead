// Drives the real page in a headless browser against a running Masthead and saves screenshots.
// Usage: node test/ui.e2e.mjs <url> <screenshot folder>
// It sends real messages, so point it at a test server whose settings use cheap models, started with
// its own XDG_CONFIG_HOME and XDG_DATA_HOME, and with MASTHEAD_BACKEND=fake or MASTHEAD_TAILSCALE=off so
// it never runs the real tailscale (the run fails if it does). The server's secret is taken from the URL's ?key=, else
// MASTHEAD_KEY, else $MASTHEAD_DATA_DIR/secret, else $XDG_DATA_HOME/masthead/secret. It never runs
// against the installed app on 7717. The browser is $CHROMIUM, else /usr/bin/chromium if present, else
// Playwright's own Chromium (as in CI).
// For the approval-card check the server's permissionMode must make a Write ask ("default"), and the opus
// tier should allow 3 at once; see docs/wiki/Source-Tests.md for a settings file that does both.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [rawUrl = 'http://127.0.0.1:7799', shots = '.'] = process.argv.slice(2);
const target = new URL(rawUrl);
if (target.port === '7717') {
  console.error('Refusing to run against port 7717, the installed Masthead. Start a test server on another port with its own XDG_CONFIG_HOME and XDG_DATA_HOME.');
  process.exit(2);
}
if (!target.searchParams.get('key')) {
  let key = process.env.MASTHEAD_KEY;
  const dataDir = process.env.MASTHEAD_DATA_DIR || (process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'masthead') : '');
  if (!key && dataDir) {
    try {
      key = readFileSync(join(dataDir, 'secret'), 'utf8').trim();
    } catch {
      // reported below
    }
  }
  if (!key) {
    console.error("No key for the test server: add ?key=<secret> to the URL, or set MASTHEAD_KEY, or the server's MASTHEAD_DATA_DIR or XDG_DATA_HOME.");
    process.exit(2);
  }
  target.searchParams.set('key', key);
}
const url = target.href;
// MASTHEAD_E2E_BACKEND=fake: the server runs echo's fake backend (MASTHEAD_BACKEND=fake), which answers
// scripted phrases instead of a model. The team is then built one tool call per message, and the checks
// that need a model's own writing (a code block, a final table) are skipped.
const fake = process.env.MASTHEAD_E2E_BACKEND === 'fake';
const base = `${target.origin}/`;
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
let failed = false;
const check = (name, ok) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failed = true;
};

const executablePath = process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const scheme = process.env.SCHEME === 'light' ? 'light' : 'dark';
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
const errors = [];
let approver = null;
page.on('pageerror', (e) => errors.push(String(e)));
// The sign-in checks are refused on purpose; the browser logs each refused socket as an error.
page.on('console', (m) => m.type() === 'error' && !/WebSocket connection .* 403/.test(m.text()) && errors.push(m.text()));

const SIGN_IN = 'to sign this browser in';

// Accessibility: axe-core's WCAG 2 A/AA rules, run inside the page (evaluate is not subject to the CSP).
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** Neither the page nor the team panel scrolls sideways. */
async function noSideways(p) {
  return p.evaluate(() => {
    const over = (el) => !!el && el.scrollWidth > el.clientWidth + 1;
    return !over(document.scrollingElement) && !over(document.querySelector('aside.right')) && !over(document.querySelector('aside.right .outline'));
  });
}

/** Every open parent's guide in the team panel meets its ticks and corner exactly (layout px). */
async function guidesExact(p, label) {
  const bad = await p.evaluate(() => {
    const out = [];
    const same = (a, b) => Math.abs(a - b) < 0.02;
    const nodes = [...document.querySelectorAll('aside.right .node.open')];
    for (const n of nodes) {
      const name = n.querySelector('.name')?.textContent;
      const vline = n.querySelector(':scope > .row > .vline')?.getBoundingClientRect();
      const box = n.querySelector(':scope > .row .twisty .expander')?.getBoundingClientRect();
      if (!vline || !box) { out.push({ name, missing: true }); continue; }
      const ty = box.top + 6 - n.getBoundingClientRect().top;
      if (!same(vline.left, box.left + 6) || vline.width !== 1) out.push({ name, vlineX: vline.left, boxMiddle: box.left + 6 });
      if (!same(vline.top, box.bottom)) out.push({ name, vlineTop: vline.top, boxBottom: box.bottom });
      const kids = [...n.querySelectorAll(':scope > .group > .node')];
      kids.forEach((k, i) => {
        const tick = k.querySelector(':scope > .tick')?.getBoundingClientRect();
        const top = k.getBoundingClientRect().top;
        if (!tick) return out.push({ name, child: i, noTick: true });
        if (!same(tick.left, vline.left)) out.push({ name, child: i, tickX: tick.left, vlineX: vline.left });
        if (i < kids.length - 1) {
          if (!same(tick.top, top + ty) || !same(tick.height, 1)) out.push({ name, child: i, tickY: tick.top, want: top + ty });
        } else {
          if (!same(tick.top, vline.bottom)) out.push({ name, child: i, cornerTop: tick.top, vlineBottom: vline.bottom });
          if (!same(tick.bottom - 1, top + ty)) out.push({ name, child: i, cornerFoot: tick.bottom - 1, want: top + ty });
        }
        const kidBox = k.querySelector(':scope > .row .twisty .expander')?.getBoundingClientRect();
        if (kidBox && !same(kidBox.top + 6, top + ty)) out.push({ name, child: i, boxMiddle: kidBox.top + 6, want: top + ty });
      });
    }
    const o = document.querySelector('aside.right .outline')?.getBoundingClientRect();
    if (o && !same(o.top, Math.round(o.top))) out.push({ outlineTop: o.top });
    return nodes.length < 2 ? [{ tooFew: nodes.length }] : out;
  });
  if (bad.length) log(`guides ${label}: ${JSON.stringify(bad)}`);
  return bad.length === 0;
}

async function axeCheck(p, name) {
  await p.evaluate(AXE);
  const result = await p.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of result.violations) log(`axe ${name}: ${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  check(`no serious accessibility problems: ${name}`, bad.length === 0);
}

try {
  // Sign-in: a browser with no key, and one with a wrong key, each in its own storage.
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(base);
    await p.waitForSelector(`text=${SIGN_IN}`, { timeout: 10_000 });
    check('no key shows the sign-in message', (await p.getByRole('button', { name: 'Try again' }).count()) === 0);
    await p.goto(`${base}?key=not-the-key`);
    await p.waitForSelector('button:has-text("Try again")', { timeout: 15_000 });
    check('a wrong key shows the sign-in message with Try again', (await p.locator(`text=${SIGN_IN}`).count()) === 1);
    // Another tab signs this browser in with the right key; Try again picks it up and connects.
    await p.evaluate((k) => localStorage.setItem('masthead.key', k), target.searchParams.get('key'));
    await p.getByRole('button', { name: 'Try again' }).click();
    await p.waitForSelector('text=What are we working on?', { timeout: 15_000 }).catch(() => {});
    check('Try again connects once the right key is stored', (await p.locator('text=What are we working on?').count()) === 1);
    await ctx.close();
  }
  // Sign-in with the key in the fragment, as `masthead` opens it: it works and leaves the address.
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${base}#key=${encodeURIComponent(target.searchParams.get('key'))}`);
    await p.waitForSelector('text=What are we working on?', { timeout: 15_000 }).catch(() => {});
    const loaded = (await p.locator('text=What are we working on?').count()) === 1;
    check('a key in the fragment works and leaves the address bar', loaded && !p.url().includes('key='));
    await ctx.close();
  }

  await page.goto(url);
  await page.waitForSelector('text=What are we working on?');
  check('the right key works and leaves the address bar', !new URL(page.url()).searchParams.has('key'));
  // A link with a wrong key must not sign a signed-in browser out: opened fresh, and pasted into the open tab.
  const signedIn = async () =>
    (await page.locator('text=What are we working on?').count()) === 1 && (await page.locator(`text=${SIGN_IN}`).count()) === 0 && !page.url().includes('key=');
  await page.goto('about:blank');
  await page.goto(`${base}#key=not-the-key`);
  await page.waitForTimeout(1500);
  await page.waitForSelector('text=What are we working on?', { timeout: 15_000 }).catch(() => {});
  check('a wrong key in a link does not sign the browser out', await signedIn());
  await page.evaluate(() => (location.hash = '#key=still-not-the-key'));
  await page.waitForTimeout(1500);
  await page.waitForSelector('text=What are we working on?', { timeout: 15_000 }).catch(() => {});
  check('a wrong key pasted into the open tab is taken and refused, and it stays signed in', await signedIn());
  await page.screenshot({ path: `${shots}/1-new-${scheme}.png` });
  check('new conversation screen renders', (await page.locator('h1', { hasText: 'What are we working on?' }).count()) === 1);

  // Simple by default: few controls on first load, no team jargon, example prompts that fill the box.
  const firstLoad = await page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    // The skip link sits off screen until focused, so it is not counted.
    const controls = [...document.querySelectorAll('button:not([disabled]), textarea, select, input:not([type=hidden]), a[href]:not(.skip)')].filter(visible);
    return { count: controls.length, names: controls.map((c) => c.getAttribute('aria-label') || c.textContent?.trim() || c.tagName), text: document.body.innerText };
  });
  log(`first load: ${firstLoad.count} controls: ${firstLoad.names.join(' | ')}`);
  check('first load shows at most 10 controls', firstLoad.count <= 10);
  const jargon = firstLoad.text.match(/\b(tiers?|opus|sonnet|haiku|effort|sub-?agents?|lead)\b/gi);
  check('first load has no team jargon', !jargon);
  if (jargon) log(`jargon: ${jargon.join(', ')}`);
  check('the team panel is hidden until a helper starts', (await page.locator('aside.right').count()) === 0);
  await axeCheck(page, 'first load');
  await page.locator('.example').first().click();
  check('an example prompt fills the box without sending', (await page.locator('textarea').inputValue()).startsWith('Look through this folder') && (await page.locator('.user .bubble').count()) === 0);
  await page.locator('textarea').fill('');

  // Settings popup: opens from the gear with Enter, Escape closes it and gives focus back.
  const gear = page.getByRole('button', { name: 'Settings', exact: true });
  await gear.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Settings' });
  await menu.waitFor();
  check('the settings view opens from the gear', await menu.isVisible());
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  check('Escape closes it and focus returns to the gear', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Settings'));
  // Turn on folded reports and the team controls (both used below) and check they survive a reload.
  await gear.click();
  const fold = menu.getByLabel(/Show helper reports as one line/);
  if (!(await fold.isChecked())) await fold.check();
  await menu.getByLabel(/Longest a helper may work/).selectOption('30');
  const advanced = menu.getByLabel(/Show team controls/);
  if (!(await advanced.isChecked())) await advanced.check();
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('text=What are we working on?');
  await gear.click();
  check('"Show helper reports as one line" persists across a reload', await menu.getByLabel(/Show helper reports as one line/).isChecked());
  check('"Longest a helper may work" persists across a reload', (await menu.getByLabel(/Longest a helper may work/).inputValue()) === '30');
  check('"Show team controls" persists across a reload (per device)', await menu.getByLabel(/Show team controls/).isChecked());
  // Remote access (golf): a test server has no Tailscale, so the section says so in its status line.
  if (await page.getByRole('heading', { name: 'Remote access' }).count()) {
    check('the remote access section renders', (await page.getByRole('status').filter({ hasText: /Tailscale|Off/ }).count()) >= 1);
    // A test server must not see the real Tailscale (MASTHEAD_BACKEND=fake or MASTHEAD_TAILSCALE=off): with
    // it, its start-up could touch the real Masthead's serve entry. Then the switch is greyed out.
    check('the test server does not use the real Tailscale', await page.getByLabel('Allow my other devices to connect').isDisabled());
  } else log('no remote access section (the server sent no state.remote)');
  await axeCheck(page, 'settings view');
  // Teams (bravo): editing the built-in team refuses an empty name in plain words, then Cancel.
  const editClaude = menu.getByRole('button', { name: /^Edit Claude/ });
  if (await editClaude.count()) {
    await editClaude.first().click();
    const nameField = menu.getByLabel(/Team name/).first();
    await nameField.fill('');
    await menu.getByRole('button', { name: 'Save team' }).click();
    check('the team editor refuses an empty name in plain words', (await menu.getByRole('alert').filter({ hasText: 'Give the team a name.' }).count()) === 1);
    await menu.getByRole('button', { name: /^Cancel/ }).first().click();
  } else log('no "Edit Claude" button in Teams');
  await menu.getByRole('button', { name: 'Close settings' }).click();
  await menu.waitFor({ state: 'detached' });

  // Composer restore: the server refuses a message over 400,000 characters; the text must come back.
  const box = page.locator('textarea');
  const tooLong = 'x'.repeat(400_001);
  await box.fill(tooLong);
  await box.press('Enter');
  await page.waitForSelector('.toast >> text=too long', { timeout: 10_000 });
  check('a refused message is given back to the composer', (await box.inputValue()).length === tooLong.length);
  await box.fill('');

  if (fake) {
    // One spawn_agent call per message: shell job (which starts helper job, whose `ls` needs approval),
    // list job, and busy one (a background task keeps it working until it is stopped).
    // The fake reads markers anywhere in a message, JSON included; writing "[" as \u005b inside the JSON
    // keeps the lead from acting on a marker meant for the helper (JSON.parse turns it back into "[").
    const spawn = (title, task) => `Call the tool spawn_agent with input ${JSON.stringify({ title, task }).replace(/\[/g, '\\u005b')}`;
    const messages = [
      spawn('shell job', spawn('helper job', 'Run the shell command `ls`')),
      spawn('list job', 'Reply with exactly the word fruit'),
      spawn('busy one', '[[background 120s]] Reply with exactly the word busy'),
    ];
    for (const m of messages) {
      await box.fill(m);
      await box.press('Enter');
      await page.waitForFunction((n) => document.querySelectorAll('.user .bubble').length >= n, messages.indexOf(m) + 1);
    }
  } else {
    const busyTask =
      'Run the shell command `sleep 8` as a foreground Bash command, twelve separate times, one after another. Never run it in the background. Then reply DONE.';
    await box.fill(
      `Wiring test, follow literally. In one step use spawn_agent three times: an agent titled "shell job" with the task "Use spawn_agent to start an agent titled helper job with the task: Run the shell command \`sleep 6; echo ready\` and reply with its output. When its report arrives, reply SHELL-DONE plus what it said. Never call stop_agent.", an agent titled "list job" with the task "Use the Write tool to save a three-item markdown list of fruit to fruit.md. Then reply with the same list and a short python code block printing hi." and an agent titled "busy one" with the task "${busyTask}". Then end your turn. When every report has arrived, summarise them in a short markdown table.`,
    );
    await box.press('Enter');
  }
  await page.waitForSelector('.user .bubble');
  const lastKeyAt = Date.now();
  log('sent');

  // Approval card: the first one appears, names the agent, takes focus (nobody is typing), Allow works.
  const firstCard = page.locator('.card[role="alertdialog"]').first();
  await firstCard.waitFor({ timeout: 120_000 });
  const cardAfter = Date.now() - lastKeyAt;
  const asker = (await firstCard.locator('.who').textContent())?.trim() ?? '';
  check('an approval card names the agent', asker.length > 0 && ((await firstCard.getAttribute('aria-label')) ?? '').includes(asker));
  // The card takes focus unless a key was pressed in the last 1.5 s (PermissionCard's rule). A real model
  // asks seconds later; the fake asks at once, while the person is still "typing".
  const focus = await page.evaluate(() => document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName);
  if (cardAfter > 2000) check('the card takes focus', focus === 'alertdialog');
  else if (cardAfter < 1200) check('the card does not take focus while the person is typing', focus !== 'alertdialog');
  else log(`card appeared ${cardAfter} ms after typing: too close to the 1.5 s rule to judge focus`);
  const cardId = await firstCard.evaluate((el) => el.outerHTML);
  await firstCard.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.waitForFunction((html) => ![...document.querySelectorAll('.card[role="alertdialog"]')].some((el) => el.outerHTML === html), cardId, { timeout: 10_000 }).catch(() => {});
  check('Allow answers the card', !(await page.evaluate((html) => [...document.querySelectorAll('.card[role="alertdialog"]')].some((el) => el.outerHTML === html), cardId)));

  // Approve anything the agents ask for.
  approver = setInterval(async () => {
    const allow = page.locator('.card .btn.primary', { hasText: 'Allow' }).first();
    if (await allow.count()) await allow.click().catch(() => {});
  }, 500);

  // With team controls on and a wide window, the team panel opens by itself once helpers start.
  await page.waitForSelector('aside.right div.row >> text=shell job', { timeout: 120_000 });
  await page.screenshot({ path: `${shots}/2-working-${scheme}.png` });
  check('the Team button appears once helpers work', (await page.locator('.team-btn').count()) === 1);

  // Limits (Advanced): raise and lower the Opus count in the team panel.
  const opus = page.locator('.tier.tier-opus');
  const before = await opus.locator('output').textContent();
  await opus.getByLabel(/^More .* helpers$/).click();
  await page.waitForFunction((b) => document.querySelector('.tier.tier-opus output')?.textContent !== b, before);
  const raised = await opus.locator('output').textContent();
  await opus.getByLabel(/^Fewer .* helpers$/).click();
  await page.waitForFunction((b) => document.querySelector('.tier.tier-opus output')?.textContent === b, before, { timeout: 5000 }).catch(() => {});
  const lowered = await opus.locator('output').textContent();
  check('the stepper changes the limit', raised !== before && lowered === before);
  await axeCheck(page, 'chat with the team panel');

  // The team panel: one outline that scrolls only up and down (0.2.0 replaced the map).
  const panel = page.locator('aside.right');
  // A tree item contains its children, so find agents by their own row, then step up to the item.
  const rowOf = (text) => panel.locator('div.row', { hasText: text }).first();
  const itemOf = (text) => rowOf(text).locator('xpath=..');
  const helperShown = await rowOf('helper job').waitFor({ timeout: fake ? 90_000 : 30_000 }).then(() => true, () => false);
  if (!helperShown) {
    log(`team rows when "helper job" was missing: ${JSON.stringify(await panel.locator('div.row').allInnerTexts())}`);
    throw new Error('"helper job" never appeared in the team panel');
  }
  check('the team panel shows three levels', (await itemOf('helper job').getAttribute('aria-level')) === '3');
  const names = await panel.locator('div.row .name').allTextContents();
  check('agents are named Alpha, Bravo, Charlie, Delta', ['Alpha', 'Bravo', 'Charlie', 'Delta'].every((n) => names.includes(n)));
  check('nothing scrolls sideways at 1440 px', await noSideways(page));
  // The tree guides, to the pixel: each open parent's line leaves its box's middle pixel, every tick
  // starts on that line, the line ends where the last child's corner begins, and the corner's foot is on
  // the same y as every tick (through each box's middle). At pixel ratio 1 here, and 1.5 below.
  check('the tree guides meet to the pixel at pixel ratio 1', await guidesExact(page, 'dpr 1'));
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1.5 });
    const p15 = await ctx.newPage();
    await p15.goto(url);
    await p15.waitForLoadState('networkidle');
    await p15.goto(page.url());
    await p15.waitForSelector('.team-btn', { timeout: 20_000 });
    if (!(await p15.locator('aside.right').count())) await p15.locator('.team-btn').click();
    await p15.locator('aside.right .node.open .vline').first().waitFor({ timeout: 20_000 });
    check('the tree guides meet to the pixel at pixel ratio 1.5', await guidesExact(p15, 'dpr 1.5'));
    await ctx.close();
  }
  // Hovering a row shows its latest lines below it, inside the panel.
  const helperRow = rowOf('helper job');
  for (let tries = 0; tries < 5; tries++) {
    await page.mouse.move(700, 400);
    await helperRow.hover();
    if (await helperRow.locator('.preview').waitFor({ timeout: 3000 }).then(() => true, () => false)) break;
  }
  const content = '.preview .p-line, .preview .p-empty:has-text("Nothing yet")';
  await helperRow.locator(content).first().waitFor({ timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: `${shots}/3-team-${scheme}.png` });
  check('hovering an agent previews its chat', (await helperRow.locator('.preview .p-task').count()) === 1 && (await helperRow.locator(content).count()) >= 1);
  check('the preview causes no sideways scrolling', await noSideways(page));
  await page.mouse.move(700, 400);

  // Collapse a branch with the keyboard, then open it again.
  const shellItem = itemOf('shell job');
  await shellItem.focus();
  await page.keyboard.press('ArrowLeft');
  check('← closes a branch', (await shellItem.getAttribute('aria-expanded')) === 'false' && (await panel.locator('div.row', { hasText: 'helper job' }).count()) === 0);
  await page.keyboard.press('ArrowRight');
  check('→ opens it again', (await panel.locator('div.row', { hasText: 'helper job' }).count()) === 1);

  // Stop: the ■ on a busy helper's row stops it.
  const busyOne = rowOf('busy one');
  await busyOne.locator('.dot.running, .dot.waiting').first().waitFor({ timeout: 90_000 });
  const stopBtn = busyOne.getByRole('button', { name: /^Stop / });
  await stopBtn.hover();
  check('the stop button says "Stop" on hover', await stopBtn.locator('.label').isVisible());
  await page.screenshot({ path: `${shots}/3b-stop-hover-${scheme}.png` });
  await stopBtn.click();
  await busyOne.locator('.doing', { hasText: 'Stopped' }).waitFor({ timeout: 20_000 }).catch(() => {});
  check('the row\'s ■ stops the agent', (await busyOne.locator('.doing', { hasText: 'Stopped' }).count()) === 1);
  check('a stopped agent stays in the outline, dimmed', (await busyOne.evaluate((el) => el.classList.contains('ended'))) === true);

  // "Hide finished" folds finished helpers into one row; failed ones never fold.
  await panel.getByLabel('Hide finished').check();
  check('"Hide finished" folds finished helpers into one row', (await panel.locator('div.row', { hasText: /\d+ finished:/ }).count()) >= 1);
  await panel.getByLabel('Hide finished').uncheck();

  // Narrower window (900 px): the panel is a drawer; still nothing sideways.
  await page.setViewportSize({ width: 900, height: 900 });
  if (!(await panel.count())) await page.locator('.team-btn').click();
  await panel.waitFor();
  check('nothing scrolls sideways at 900 px', await noSideways(page));
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  if (!(await panel.count())) await page.locator('.team-btn').click();
  await panel.waitFor();

  // Open a helper's chat from its row and come back.
  await rowOf('list job').click();
  await page.waitForSelector('.crumbs');
  await page.waitForSelector('.inbound.task');
  await page.screenshot({ path: `${shots}/4-agent-${scheme}.png` });
  check('a sub-agent transcript opens with its task', (await page.locator('.inbound.task').count()) === 1);
  if (!fake) {
    // Its reply has a python code block: the page's own code-block markup survives the sanitiser in a real browser.
    await page.waitForSelector('.md .code-block .code-copy', { timeout: 30_000 }).catch(() => {});
    check('code blocks render with a Copy button', (await page.locator('.md .code-block .code-copy').count()) >= 1);
  }
  // The message box says who it is pointed at, and Back returns it to the lead.
  const targetLine = (await page.locator('.addressee .to').textContent().catch(() => '')) ?? '';
  const placeholderText = (await page.locator('textarea').getAttribute('placeholder')) ?? '';
  check('the composer names the sub-agent it is pointed at', /^To \S/.test(targetLine.trim()) && placeholderText.includes('not Alpha'));
  await page.locator('.addressee .back', { hasText: 'Back to Alpha' }).click();
  await page.waitForFunction(() => !document.querySelector('.crumbs'), null, { timeout: 5000 }).catch(() => {});
  check('Back returns the composer to the lead', (await page.locator('.addressee').count()) === 0 && (await page.locator('.crumbs').count()) === 0);

  // Wait for all three reports and (with a model) a table written after the last of them (the lead may
  // draw interim tables).
  await page.waitForFunction(
    (needTable) => {
      const reports = document.querySelectorAll('.inbound.report');
      if (reports.length < 3) return false;
      if (!needTable) return true;
      const last = reports[reports.length - 1];
      return [...document.querySelectorAll('.md.assistant table')].some((t) => last.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
    },
    !fake,
    { timeout: 180_000 },
  );
  await page.waitForFunction(() => !document.querySelector('.working'), null, { timeout: 60_000 });
  clearInterval(approver);
  await page.screenshot({ path: `${shots}/5-done-${scheme}.png` });
  check('reports reached the lead', (await page.locator('.inbound.report').count()) >= 3);
  // Folded reports: one line each until opened.
  const report = page.locator('.inbound.report').first();
  check('a report is folded to one line', (await report.locator('.gist').count()) === 1 && (await report.locator('.inbound-body').count()) === 0);
  await report.locator('.gist').click();
  check('a folded report opens on click', (await report.locator('.inbound-body').count()) === 1);
  if (!fake) check('the final answer has a table', (await page.locator('.md.assistant table').count()) >= 1);
  // Usage: a quiet line in the sidebar once Claude Code has reported usage; it opens into each window.
  const usageLine = page.locator('.usage .summary');
  if (await usageLine.count()) {
    await usageLine.click();
    check('the usage line opens into its windows', (await page.locator('.usage .limit, .usage .muted').count()) >= 1);
  } else {
    log('no usage reported by Claude Code in this run; usage line not shown (as designed)');
  }

  // Reload: the conversation comes back from disk.
  await page.reload();
  await page.waitForSelector(fake ? '.inbound.report' : '.md.assistant table');
  check('the conversation survives a reload', (await page.locator('.user .bubble').count()) === (fake ? 3 : 1));
  check('the sidebar lists it', (await page.locator('aside.left .row').count()) >= 1);

  if (fake) {
    // Pictures (fake only: it can return a tool result with an image on cue, and replies to an upload).
    const loaded = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].some((i) => i.complete && i.naturalWidth > 0), sel);
    await page.locator('textarea').fill('[[image]] Reply with exactly the word pic');
    await page.locator('textarea').press('Enter');
    await page.locator('.tool-images img').first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.tool-images img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10_000 }).catch(() => {});
    check('a picture from a tool shows as a thumbnail', await loaded('.tool-images img'));
    const thumb = page.locator('.tool-images .thumb').first();
    await thumb.click();
    await page.locator('.viewer').waitFor();
    check('a thumbnail opens the picture full size', (await page.locator('.viewer img').count()) === 1);
    await page.keyboard.press('Escape');
    await page.locator('.viewer').waitFor({ state: 'detached' });
    check('Escape closes the picture and focus returns to the thumbnail', await thumb.evaluate((el) => el === document.activeElement));
    // Upload: a small PNG attached in an existing chat is uploaded at once and shown in the sent message.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
    await page.locator('.composer input[type=file]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => {
      const t = document.querySelector('.composer .thumb');
      return t && !t.classList.contains('busy');
    }, null, { timeout: 10_000 });
    check('an attached picture uploads before sending', (await page.locator('.composer .thumb.bad').count()) === 0);
    await page.locator('textarea').fill('Reply with exactly the word seen');
    await page.locator('textarea').press('Enter');
    await page.locator('.user .bubble', { hasText: 'Reply with exactly the word seen' }).waitFor({ timeout: 10_000 });
    await page.locator('.user .thumbs img').first().waitFor({ timeout: 10_000 }).catch(() => {});
    await page.waitForFunction(() => [...document.querySelectorAll('.user .thumbs img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10_000 }).catch(() => {});
    check('the sent picture shows in the message', await loaded('.user .thumbs img'));
    await page.screenshot({ path: `${shots}/5b-pictures-${scheme}.png` });
    // Paste: a clipboard paste of a PNG into the message box adds it like the picker does.
    const before = await page.locator('.user .thumbs img').count();
    const putFile = (kind) =>
      page.evaluate(([b64, kind]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], `${kind}.png`, { type: 'image/png' }));
        if (kind === 'pasted') {
          document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          return null;
        }
        const box = document.querySelector('.composer');
        const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
        box.dispatchEvent(over);
        // The page redraws after the event; look once it has.
        return new Promise((done) => requestAnimationFrame(() => {
          const lit = over.defaultPrevented && box.classList.contains('dragging');
          box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          done(lit);
        }));
      }, [png.toString('base64'), kind]);
    const uploaded = (n) =>
      page.waitForFunction((k) => {
        const t = [...document.querySelectorAll('.composer .thumb')];
        return t.length === k && t.every((x) => !x.classList.contains('busy'));
      }, n, { timeout: 10_000 }).then(() => true, () => false);
    await putFile('pasted');
    check('a pasted picture is added to the message and uploads', (await uploaded(1)) && (await page.locator('.composer .thumb.bad').count()) === 0 && (await page.locator('.composer .thumb img[alt="pasted.png"]').count()) === 1);
    // Drag and drop: the box lights up while a file is over it, and the dropped picture is added too.
    const lit = await putFile('dropped');
    check('dragging a picture over the message box lights it up', lit === true);
    check('a dropped picture is added beside the pasted one and uploads', (await uploaded(2)) && (await page.locator('.composer .thumb.bad').count()) === 0 && (await page.locator('.composer .thumb img[alt="dropped.png"]').count()) === 1);
    check('the box is no longer lit after the drop', (await page.locator('.composer.dragging').count()) === 0);
    // Dropping a file beside the box must not make the browser leave the app to show the file.
    const navigated = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'stray.png', { type: 'image/png' }));
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector('main, body').dispatchEvent(ev);
      return !ev.defaultPrevented;
    });
    check('a picture dropped outside the box is not opened by the browser', !navigated);
    // Dragged text is not a picture: the box is not lit and the browser drops the text as usual.
    const textDrag = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'some words');
      const ev = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector('.composer textarea').dispatchEvent(ev);
      return new Promise((done) => requestAnimationFrame(() => done(!ev.defaultPrevented && !document.querySelector('.composer.dragging'))));
    });
    check('dragging text over the box leaves it to the browser', textDrag);
    await page.locator('textarea').fill('Reply with exactly the word both');
    await page.locator('textarea').press('Enter');
    await page.locator('.user .bubble', { hasText: 'Reply with exactly the word both' }).waitFor({ timeout: 10_000 });
    await page.waitForFunction((k) => [...document.querySelectorAll('.user .thumbs img')].filter((i) => i.complete && i.naturalWidth > 0).length >= k + 2, before, { timeout: 10_000 }).catch(() => {});
    check('the pasted and dropped pictures show in the sent message', (await page.locator('.user .thumbs img').count()) >= before + 2 && (await loaded('.user .thumbs img')));
    check('the composer is empty again after sending', (await page.locator('.composer .thumb').count()) === 0);
    await page.waitForFunction(() => !document.querySelector('.working'), null, { timeout: 30_000 }).catch(() => {});
    // Reload: the sent pictures and the tool's picture come back from disk and still load.
    const toolBefore = await page.locator('.tool-images img').count();
    const sentBefore = await page.locator('.user .thumbs img').count();
    await page.reload();
    await page.locator('.user .thumbs img').first().waitFor({ timeout: 15_000 }).catch(() => {});
    const allLoaded = (sel) => page.waitForFunction((q) => {
      const imgs = [...document.querySelectorAll(q)];
      return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, sel, { timeout: 15_000 }).then(() => true, () => false);
    // Tool output may sit folded inside a tool group after a reload; open it if so.
    if (!(await page.locator('.tool-images img').count())) {
      const groups = page.locator('.tool-group summary, .tools summary, .tool summary');
      for (let i = 0; i < (await groups.count()); i++) await groups.nth(i).click().catch(() => {});
    }
    check('after a reload every sent picture is still there and loads', (await page.locator('.user .thumbs img').count()) === sentBefore && (await allLoaded('.user .thumbs img')));
    check("after a reload the tool's picture is still there and loads", (await page.locator('.tool-images img').count()) === toolBefore && (await allLoaded('.tool-images img')));
    // A message bubble keeps its spaces; a thumbnail must still be exactly as tall as its picture.
    const snug = await page.evaluate(() => [...document.querySelectorAll('.thumbs .thumb')].every((b) => b.getBoundingClientRect().height - b.querySelector('img').getBoundingClientRect().height <= 2));
    check('thumbnails in sent messages have no blank band under the picture', snug);
    const sentThumb = page.locator('.user .thumbs .thumb').last();
    await sentThumb.click();
    await page.locator('.viewer img').waitFor({ timeout: 5000 }).catch(() => {});
    check('after a reload a sent picture still opens full size', await page.evaluate(() => {
      const i = document.querySelector('.viewer img');
      return !!i && i.complete && i.naturalWidth > 0;
    }));
    await page.keyboard.press('Escape');
    await page.locator('.viewer').waitFor({ state: 'detached' });
    await page.screenshot({ path: `${shots}/5c-pictures-reloaded-${scheme}.png` });


  }

  if (fake) {
    // Tidying the team (fake only: helpers finish on cue). Automatic path: 15 finished helpers and a
    // lead turn end cross the threshold; Masthead archives them and posts a summary.
    const ask = async (text) => {
      const n = await page.locator('.user .bubble').count();
      await page.locator('textarea').fill(text);
      await page.locator('textarea').press('Enter');
      await page.waitForFunction((k) => document.querySelectorAll('.user .bubble').length > k, n);
    };
    const spawnMsg = (title, task) => `Call the tool spawn_agent with input ${JSON.stringify({ title, task }).replace(/\[/g, '\\u005b').replace(/`/g, '\\u0060')}`;
    // Automatic tidying is on (the default): /compact runs it without a card, as the threshold would.
    for (let i = 1; i <= 3; i++) await ask(spawnMsg(`small job ${i}`, `Reply with exactly the word ok${i}`));
    await ask('/compact');
    const summary = page.locator('.notice', { hasText: /^Archived \d+ finished helper/ });
    const tidied = await summary.first().waitFor({ timeout: 60_000 }).then(() => true, () => false);
    check('the team is tidied without a card and Masthead says what it did', tidied && (await page.locator('[role="alertdialog"]', { hasText: 'Tidy the team?' }).count()) === 0);
    await page.screenshot({ path: `${shots}/compact-auto-${scheme}.png` });
    if (tidied) {
      if (!(await page.locator('aside.right').count())) await page.locator('.team-btn').click();
      const archivedRow = page.locator('aside.right .archived-toggle');
      await archivedRow.click();
      // The fake lead keeps one finished helper with a reason; any archived one will do from here on.
      const first = page.locator('aside.right .archived-open').first();
      const archivedName = (await first.locator('.title').textContent())?.trim() ?? '';
      check('archived helpers sit under one row and leave the team list', /Archived helpers \(\d+\)/.test((await archivedRow.textContent())?.trim() ?? '') && archivedName !== '' && (await page.locator('aside.right div.row', { hasText: archivedName }).count()) === 0);
      await first.click();
      await page.locator('.archived-note').waitFor({ timeout: 10_000 });
      check('an archived chat opens read-only, labelled Archived, with Restore', (await page.locator('.archived-note .archived-tag').textContent())?.trim() === 'Archived' && (await page.locator('.composer textarea').count()) === 0);
      await axeCheck(page, 'archived chat');
      await page.screenshot({ path: `${shots}/compact-archived-${scheme}.png` });
      await page.locator('.archived-note button', { hasText: 'Restore' }).click();
      await page.locator('aside.right div.row', { hasText: archivedName }).first().waitFor({ timeout: 10_000 }).catch(() => {});
      check('Restore brings the helper back into the team', (await page.locator('aside.right div.row', { hasText: archivedName }).count()) === 1);
      await page.locator('.crumbs .back, .addressee .back').first().click().catch(() => {});
    }

    // The "/" hint, and the card path with automatic tidying off.
    await page.locator('textarea').fill('/');
    check('typing "/" shows the /compact command', (await page.locator('.slash-item', { hasText: '/compact' }).count()) === 1);
    await page.locator('textarea').fill('');
    await page.locator('#settings-gear').click();
    const autoBox = page.getByRole('dialog', { name: 'Settings' }).getByLabel(/Tidy the team automatically/);
    if (await autoBox.count()) {
      await autoBox.uncheck();
      await page.getByRole('button', { name: 'Close settings' }).click();
      await ask('/compact');
      const card = page.locator('[role="alertdialog"]', { hasText: 'Tidy the team?' });
      const shown = await card.waitFor({ timeout: 30_000 }).then(() => true, () => false);
      check('with automatic tidying off, /compact asks first with a card', shown);
      if (shown) {
        await axeCheck(page, 'tidy card');
        await page.screenshot({ path: `${shots}/compact-card-${scheme}.png` });
        await card.getByRole('button', { name: 'Tidy up' }).click();
        await card.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
        check('the card goes once answered', (await card.count()) === 0);
      }
      // Put automatic tidying back on, so the settings this server keeps are as they were.
      await page.locator('#settings-gear').click();
      await page.getByRole('dialog', { name: 'Settings' }).getByLabel(/Tidy the team automatically/).check();
      await page.getByRole('button', { name: 'Close settings' }).click();
    } else log('no "Tidy the team automatically" setting from this server');
  }

  // Phone: a 390 × 844 touch screen in the light theme, on the same server and conversation.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`phone: ${e}`));
    await p.goto(url);
    await p.waitForSelector('text=What are we working on?');
    const layout = await p.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const small = [...document.querySelectorAll('button:not([disabled]), select, input:not([type=hidden]), textarea, a[href]')]
        .filter((el) => visible(el) && !el.classList.contains('skip'))
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName);
      const ta = document.querySelector('textarea');
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        small,
        fieldFont: ta ? parseFloat(getComputedStyle(ta).fontSize) : 0,
        boxBottom: ta ? ta.getBoundingClientRect().bottom : 0,
      };
    });
    if (layout.small.length) log(`phone: targets under 44 px: ${layout.small.join(' | ')}`);
    check('phone: nothing scrolls sideways', !layout.overflow);
    check('phone: every tap target is at least 44 px', layout.small.length === 0);
    check('phone: the message box uses 16 px text (no zoom on focus) and is on screen', layout.fieldFont >= 16 && layout.boxBottom <= 844);
    check('phone: the chat list starts closed', (await p.locator('aside.left').count()) === 0);
    await p.screenshot({ path: `${shots}/6-phone-new-light.png` });
    await axeCheck(p, 'phone, new chat');
    await p.getByRole('button', { name: 'Show chats' }).tap();
    await p.locator('aside.left .open').first().waitFor();
    await p.screenshot({ path: `${shots}/7-phone-drawer-light.png` });
    await p.locator('aside.left .open').first().tap();
    await p.waitForSelector('.user .bubble');
    check('phone: choosing a chat closes the drawer', (await p.locator('aside.left').count()) === 0);
    await p.locator('.team-btn').tap();
    await p.locator('aside.right').waitFor();
    check('phone: the team opens as a drawer over the chat', (await p.locator('.backdrop').count()) === 1);
    check('phone: nothing scrolls sideways at 390 px with the team open', await noSideways(p));
    await p.screenshot({ path: `${shots}/8-phone-team-light.png` });
    await p.locator('.backdrop').tap({ position: { x: 10, y: 400 } });
    await p.waitForFunction(() => !document.querySelector('aside.right'), null, { timeout: 5000 }).catch(() => {});
    check('phone: tapping outside closes the drawer', (await p.locator('aside.right').count()) === 0);
    if (fake) {
      // A helper that keeps working (a long background task) so its row has the Stop square.
      const task = '[[background 900s]] Reply with exactly the word phone';
      const n = await p.locator('.user .bubble').count();
      await p.locator('textarea').fill(`Call the tool spawn_agent with input ${JSON.stringify({ title: 'phone busy', task }).replace(/\[/g, '\\u005b')}`);
      await p.locator('textarea').press('Enter');
      await p.waitForFunction((k) => document.querySelectorAll('.user .bubble').length > k, n);
      if (!(await p.locator('aside.right').count())) await p.locator('.team-btn').tap();
      const row = p.locator('aside.right div.row', { hasText: 'phone busy' });
      await row.waitFor({ timeout: 20_000 });
      const stop = row.locator('button.stop');
      await stop.waitFor({ timeout: 20_000 });
      const box = await stop.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const aside = document.querySelector('aside.right').getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { w: r.width, h: r.height, inside: r.left >= aside.left && r.right <= aside.right + 0.5 && r.right <= window.innerWidth, onTop: el.contains(hit) };
      });
      log(`phone: stop square ${JSON.stringify(box)}`);
      check("phone: a working helper's row has the Stop square, at least 44 px and fully on screen", box.w >= 44 && box.h >= 44 && box.inside && box.onTop);
      check('phone: the Stop square says Stop on touch screens (no hover there)', (await stop.locator('.label').isVisible()) && /Stop/.test((await stop.getAttribute('aria-label')) ?? ''));
      check('phone: the team drawer does not scroll sideways with a working helper', await noSideways(p));
      await p.screenshot({ path: `${shots}/8b-phone-stop-light.png` });
      await stop.tap();
      await stop.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
      await p.waitForFunction(() => [...document.querySelectorAll('aside.right div.row')].some((r) => r.textContent.includes('phone busy') && r.querySelector('.dot.stopped')), null, { timeout: 15_000 }).catch(() => {});
      const stopped = await row.first().evaluate((el) => el.classList.contains('ended') && !!el.querySelector('.dot.stopped')).catch(() => false);
      check('phone: tapping Stop stops the helper (its Stop square goes, the row ends)', (await stop.count()) === 0 && stopped);
      check('phone: team rows do not flash the blue tap colour', await row.first().evaluate((el) => getComputedStyle(el).webkitTapHighlightColor === 'rgba(0, 0, 0, 0)'));
      check('phone: the drawer is still open after stopping a helper', (await p.locator('aside.right').count()) === 1);
      check('phone: nothing scrolls sideways after stopping', await noSideways(p));
      await p.screenshot({ path: `${shots}/8c-phone-stopped-light.png` });
    }

    await ctx.close();
  }

  // ---- Team profiles and the Simple/Advanced switch (hotel-iii) ----
  // Paste into test/ui.e2e.mjs just before `check('no page errors', ...)` at the end of the try block:
  // it adds teams of its own and removes them again, so put it after every check that expects the
  // built-in Claude team. Uses page, base, fake, check and log from the file.
  {
    const answers = [];
    const onDialog = (d) => {
      const no = answers.shift() === false;
      log(`dialog: ${d.message()} -> ${no ? 'no' : 'yes'}`);
      void (no ? d.dismiss() : d.accept());
    };
    page.on('dialog', onDialog);
    await page.goto(base);
    await page.waitForSelector('text=What are we working on?');
    const gear = page.getByRole('button', { name: 'Settings', exact: true });
    const menu = page.getByRole('dialog', { name: 'Settings' });
    const teams = menu.locator('section.teams');
    const teamItem = (name) => teams.locator('li.team', { has: page.getByRole('button', { name: `Edit ${name}`, exact: true }) });
    await gear.click();
    await menu.waitFor();

    // Simple/Advanced: "Let them decide how long to think" shows only in Advanced; the switch is per device.
    const advanced = menu.getByLabel(/Show team controls/);
    const autoEffort = () => menu.getByText('Let them decide how long to think').count();
    await advanced.uncheck();
    check('Simple hides the thinking-time setting', (await autoEffort()) === 0);
    await advanced.check();
    check('Advanced shows the thinking-time setting', (await autoEffort()) === 1);

    // Create: a copy of Claude, renamed, with 2 levels (on the fake backend, moved to its program).
    await teamItem('Claude').getByRole('button', { name: 'Make a copy' }).click();
    let editor = teams.locator('form.editor');
    await editor.getByLabel('Team name').fill('E2E pair');
    if (fake) await editor.getByLabel('Agent program').selectOption({ label: 'Fake backend' });
    while ((await editor.locator('li.level').count()) > 2) await editor.getByRole('button', { name: 'Remove this level' }).last().click();
    await editor.getByRole('button', { name: 'Save team' }).click();
    await teamItem('E2E pair').waitFor();
    check('a new team saves with 2 levels', (await teamItem('E2E pair').locator('ol.mini li').count()) === 2);

    // Edit: out-of-range helpers are refused in plain words (not the browser's own bubble), then fixed.
    await teams.getByRole('button', { name: 'Edit E2E pair', exact: true }).click();
    editor = teams.locator('form.editor');
    await editor.getByLabel('Helpers at a time').fill('99');
    await editor.getByRole('button', { name: 'Save team' }).click();
    check('too many helpers is refused in plain words', (await menu.getByRole('alert').filter({ hasText: 'may have from 0 to 12 helpers at a time' }).count()) === 1);
    await editor.getByLabel('Helpers at a time').fill('3');
    await editor.getByLabel('Name shown').nth(1).fill('Quick one');
    await editor.getByRole('button', { name: 'Save team' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('section.teams ol.mini li')].some((li) => li.textContent.includes('Level 2 helper: Quick one')));
    check('editing a team saves its new level name', (await teamItem('E2E pair').getByText('Level 2 helper: Quick one').count()) === 1);

    // A second team with 3 levels (Add a helper level), so the new-chat screen offers a choice.
    await teamItem('E2E pair').getByRole('button', { name: 'Make a copy' }).click();
    editor = teams.locator('form.editor');
    await editor.getByLabel('Team name').fill('E2E trio');
    await editor.getByRole('button', { name: 'Add a helper level' }).click();
    await editor.getByRole('button', { name: 'Save team' }).click();
    await teamItem('E2E trio').waitFor();
    check('a team with an added level saves with 3 levels', (await teamItem('E2E trio').locator('ol.mini li').count()) === 3);
    await menu.getByRole('button', { name: 'Close settings' }).click();
    await menu.waitFor({ state: 'detached' });

    // Start a chat with E2E trio from the chip; the team panel's levels (Advanced) are that team's.
    // Only on the fake backend: with a real Claude, the copies run Claude's models and cost money.
    if (fake) {
      const chip = page.locator('.chip-wrap .chip');
      check('the new-chat screen offers the team choice', (await chip.count()) === 1);
      await chip.click();
      await page.getByRole('menuitemradio', { name: /E2E trio/ }).click();
      check('the chip names the picked team', (await chip.textContent())?.trim() === 'Uses E2E trio');
      const n = await page.locator('.user .bubble').count();
      // One helper, so the team panel (and its levels, Advanced) shows; as the fake backend's spawn above.
      const task = JSON.stringify({ title: 'trio helper', task: 'Reply with exactly the word fruit' }).replace(/\[/g, '\\u005b');
      await page.locator('textarea').fill(`Call the tool spawn_agent with input ${task}`);
      await page.locator('textarea').press('Enter');
      await page.waitForFunction(() => location.hash.startsWith('#/c/'), null, { timeout: 15_000 });
      await page.waitForFunction((k) => document.querySelectorAll('.user .bubble').length > k, n, { timeout: 15_000 }).catch(() => {});
      // The lead of a team other than Claude's has tier '<team>:0', not 'lead': the chat must still show.
      check("a chat on a team other than Claude's shows its messages", (await page.locator('.user .bubble').count()) > n);
      await page.locator('.team-btn').waitFor({ timeout: 30_000 }).catch(() => {});
      if (!(await page.locator('section.levels').count())) await page.locator('.team-btn').click().catch(() => {});
      await page.locator('section.levels').waitFor({ timeout: 10_000 }).catch(() => {});
      check('the chat runs on the picked team (3 levels in the team panel)', (await page.locator('section.levels .tier').count()) === 3);
      const chatUrl = page.url();

      // Removing a team a chat uses: refused, asked again in plain words; "no" keeps it and says so.
      await gear.click();
      await menu.waitFor();
      answers.push(true, false);
      await teamItem('E2E trio').getByRole('button', { name: 'Remove team' }).click();
      const kept = page.locator('.toast', { hasText: /^Kept “E2E trio”: (1 chat uses|\d+ chats use) it\.$/ });
      await kept.waitFor({ timeout: 5000 }).catch(() => {});
      check('declining keeps the team and says why in plain words', (await kept.count()) === 1 && (await teamItem('E2E trio').count()) === 1);
      // "Yes" removes it; the chat keeps its levels, shown as they are and no longer changeable.
      answers.push(true, true);
      await teamItem('E2E trio').getByRole('button', { name: 'Remove team' }).click();
      await teamItem('E2E trio').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      check('confirming twice removes a team chats use', (await teamItem('E2E trio').count()) === 0);
      check('no server wording is left showing after the removal', (await page.locator('.toast', { hasText: 'use this team' }).count()) === 0);
      await menu.getByRole('button', { name: 'Close settings' }).click();
      await page.goto(chatUrl);
      await page.waitForTimeout(1500);
      if (!(await page.locator('section.levels').count())) await page.locator('.team-btn').click().catch(() => {});
      await page.locator('section.levels').waitFor({ timeout: 10_000 }).catch(() => {});
      check("a chat whose team was removed still shows its own 3 levels", (await page.locator('section.levels .tier').count()) === 3);
      check('and says they can no longer be changed', (await page.locator('section.levels', { hasText: 'can no longer be changed' }).count()) === 1 && (await page.locator('section.levels select:not([disabled])').count()) === 0);

      // A new copy must not take the removed team's id (its chat would join the new team).
      await gear.click();
      await menu.waitFor();
      await teamItem('E2E pair').getByRole('button', { name: 'Make a copy' }).click();
      editor = teams.locator('form.editor');
      await editor.getByLabel('Team name').fill('E2E again');
      await editor.getByRole('button', { name: 'Save team' }).click();
      await teamItem('E2E again').waitFor();
      answers.push(true, true);
      await teamItem('E2E again').getByRole('button', { name: 'Remove team' }).click();
      await teamItem('E2E again').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      check('a new copy is not counted as used by the removed team’s chat', (await teamItem('E2E again').count()) === 0 && (await page.locator('.toast', { hasText: /chats? uses? it/ }).count()) === 0);
    } else {
      await gear.click();
      await menu.waitFor();
      answers.push(true);
      await teamItem('E2E trio').getByRole('button', { name: 'Remove team' }).click();
      await teamItem('E2E trio').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
    // Clean up: E2E pair is used by no chat, so one "yes" removes it.
    answers.push(true);
    await teamItem('E2E pair').getByRole('button', { name: 'Remove team' }).click();
    await teamItem('E2E pair').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    check('a team no chat uses is removed after one yes', (await teamItem('E2E pair').count()) === 0);

    // Simple: the composer's model line and the team panel's levels go; the choice survives a reload.
    await advanced.uncheck();
    await menu.getByRole('button', { name: 'Close settings' }).click();
    check('Simple hides the model line under the box', (await page.locator('.meta').count()) === 0);
    await page.reload();
    await page.waitForSelector('textarea');
    check('Simple survives a reload', (await page.evaluate(() => localStorage.getItem('masthead.advanced'))) === '0' && (await page.locator('.meta').count()) === 0);
    if (await page.locator('.team-btn').count()) {
      if (!(await page.locator('aside.right').count())) await page.locator('.team-btn').click();
      check('Simple hides the levels in the team panel', (await page.locator('section.levels').count()) === 0);
    }
    page.off('dialog', onDialog);
  }
  check('no page errors', errors.length === 0);
  if (errors.length) log(errors.join('\n'));
} catch (e) {
  failed = true;
  log('FAILED:', e.message);
  if (errors.length) log(errors.join('\n'));
  await page.screenshot({ path: `${shots}/failure-${scheme}.png` }).catch(() => {});
} finally {
  if (approver) clearInterval(approver);
  await browser.close();
  log(failed ? 'finished WITH FAILURES' : 'all passed');
  process.exit(failed ? 1 : 0);
}
