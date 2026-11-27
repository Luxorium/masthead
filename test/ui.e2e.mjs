// Drives the real page in a headless browser against a running Masthead and saves screenshots.
// Usage: node test/ui.e2e.mjs <url> <screenshot folder>
// It sends real messages, so point it at a test server whose settings use cheap models, started with
// its own XDG_CONFIG_HOME and XDG_DATA_HOME. The server's secret is taken from the URL's ?key=, else
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
    const controls = [...document.querySelectorAll('button:not([disabled]), textarea, select, input:not([type=hidden]), a[href]')].filter(visible);
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
  } else log('no remote access section (the server sent no state.remote)');
  await axeCheck(page, 'settings view');
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
  await page.waitForSelector('aside.right .agent >> text=helper job', { timeout: 120_000 });
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

  await page.getByRole('button', { name: 'Show as a map' }).click();
  await page.waitForSelector('.map .card >> text=helper job');
  // Lead > shell job > helper job: a card three levels deep in the tree.
  check('the map shows three levels', (await page.locator('.map .tree.root > li > ul > li > ul > li > .card', { hasText: 'helper job' }).count()) === 1);
  const names = await page.locator('.map .card .name').allTextContents();
  check('agents are named Alpha, Bravo, Charlie, Delta', ['Alpha', 'Bravo', 'Charlie', 'Delta'].every((n) => names.includes(n)));
  // Hover until the preview shows: the card may still be moving as others appear, and a hover that
  // lands mid-layout (or before the 220 ms delay passes) can miss. Move away between tries.
  const helperCard = page.locator('.map .card.tier-sonnet', { hasText: 'helper job' }).first();
  for (let tries = 0; tries < 5; tries++) {
    await page.mouse.move(5, 5);
    await helperCard.scrollIntoViewIfNeeded();
    await helperCard.hover();
    if (await page.locator('.map .preview').waitFor({ timeout: 3000 }).then(() => true, () => false)) break;
  }
  await page.waitForSelector('.map .preview', { timeout: 5000 });
  // Real content, not "Loading…": at least one chat line, or "Nothing yet.".
  await page.waitForSelector('.map .preview .p-line, .map .preview .p-empty:has-text("Nothing yet")', { timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: `${shots}/3-map-${scheme}.png` });
  check(
    'hovering an agent previews its chat',
    (await page.locator('.map .preview .p-task').count()) === 1 &&
      (await page.locator('.map .preview .p-line, .map .preview .p-empty:has-text("Nothing yet")').count()) >= 1,
  );
  await page.mouse.move(5, 5);

  // Stop: the ■ on a busy agent's map card stops it.
  const busyOne = page.locator('.map .card', { hasText: 'busy one' }).first();
  await busyOne.locator('.dot.running, .dot.waiting').first().waitFor({ timeout: 90_000 });
  const stopBtn = busyOne.getByRole('button', { name: /^Stop / });
  await stopBtn.hover();
  check('the stop button says "Stop" on hover', await stopBtn.locator('.label').isVisible());
  await page.screenshot({ path: `${shots}/3b-stop-hover-${scheme}.png` });
  await stopBtn.click();
  await busyOne.locator('.doing', { hasText: 'Stopped' }).waitFor({ timeout: 20_000 }).catch(() => {});
  check('the map ■ stops the agent', (await busyOne.locator('.doing', { hasText: 'Stopped' }).count()) === 1);

  // Open a sub-agent from the map and come back.
  await page.locator('.map .card.tier-opus .open', { hasText: 'list job' }).first().click();
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
    await p.screenshot({ path: `${shots}/8-phone-team-light.png` });
    await p.locator('.backdrop').tap({ position: { x: 10, y: 400 } });
    await p.waitForFunction(() => !document.querySelector('aside.right'), null, { timeout: 5000 }).catch(() => {});
    check('phone: tapping outside closes the drawer', (await p.locator('aside.right').count()) === 0);
    await ctx.close();
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
