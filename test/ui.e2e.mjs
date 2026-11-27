// Drives the real page in a headless browser against a running Masthead and saves screenshots.
// Usage: node test/ui.e2e.mjs <url> <screenshot folder>
// It sends real messages, so point it at a test server whose settings use cheap models, started with
// its own XDG_CONFIG_HOME and XDG_DATA_HOME. The server's secret is taken from the URL's ?key=, else
// MASTHEAD_KEY, else $XDG_DATA_HOME/masthead/secret. It never runs against the installed app on 7717.
// For the approval-card check the server's permissionMode must make a Write ask ("default"), and the opus
// tier should allow 3 at once; see docs/wiki/Source-Tests.md for a settings file that does both.
import { readFileSync } from 'node:fs';
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
  if (!key && process.env.XDG_DATA_HOME) {
    try {
      key = readFileSync(join(process.env.XDG_DATA_HOME, 'masthead', 'secret'), 'utf8').trim();
    } catch {
      // reported below
    }
  }
  if (!key) {
    console.error("No key for the test server: add ?key=<secret> to the URL, or set MASTHEAD_KEY, or the server's XDG_DATA_HOME.");
    process.exit(2);
  }
  target.searchParams.set('key', key);
}
const url = target.href;
const base = `${target.origin}/`;
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
let failed = false;
const check = (name, ok) => {
  log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failed = true;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
const scheme = process.env.SCHEME === 'light' ? 'light' : 'dark';
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
const errors = [];
let approver = null;
page.on('pageerror', (e) => errors.push(String(e)));
// The sign-in checks are refused on purpose; the browser logs each refused socket as an error.
page.on('console', (m) => m.type() === 'error' && !/WebSocket connection .* 403/.test(m.text()) && errors.push(m.text()));

const SIGN_IN = 'to sign this browser in';

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
  check('new conversation screen renders', (await page.locator('aside.right h2').first().textContent())?.trim() === 'Team');

  // Limits: raise and lower the Opus count.
  const opus = page.locator('.tier.tier-opus');
  const before = await opus.locator('output').textContent();
  await opus.getByLabel('More Opus 5.5 agents').click();
  await page.waitForFunction((b) => document.querySelector('.tier.tier-opus output')?.textContent !== b, before);
  const raised = await opus.locator('output').textContent();
  await opus.getByLabel('Fewer Opus 5.5 agents').click();
  await page.waitForFunction((b) => document.querySelector('.tier.tier-opus output')?.textContent === b, before, { timeout: 5000 }).catch(() => {});
  const lowered = await opus.locator('output').textContent();
  check('the stepper changes the limit', raised !== before && lowered === before);

  // Usage section: either the plain "nothing yet" line or at least one bar.
  const usage = page.locator('aside.right section', { has: page.locator('h2', { hasText: 'Usage' }) });
  check('the usage section renders', (await usage.locator('text=No usage reported yet').count()) + (await usage.locator('.limit').count()) >= 1);

  // Settings popup: opens from the gear with Enter, Escape closes it and gives focus back.
  const gear = page.getByRole('button', { name: 'Settings', exact: true });
  await gear.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Settings' });
  await menu.waitFor();
  check('the settings popup opens from the gear', await menu.isVisible());
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  check('Escape closes it and focus returns to the gear', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Settings'));
  // Turn on "Fold agent reports" (used below) and check it survives a reload.
  await gear.click();
  const fold = menu.getByLabel(/Fold agent reports/);
  if (!(await fold.isChecked())) await fold.check();
  await menu.getByLabel(/Longest run for a sub-agent/).selectOption('30');
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('text=What are we working on?');
  await gear.click();
  check('"Fold agent reports" persists across a reload', await menu.getByLabel(/Fold agent reports/).isChecked());
  check('"Longest run for a sub-agent" persists across a reload', (await menu.getByLabel(/Longest run for a sub-agent/).inputValue()) === '30');
  await page.mouse.click(700, 300);
  await menu.waitFor({ state: 'detached' });

  // Composer restore: the server refuses a message over 400,000 characters; the text must come back.
  const box = page.locator('textarea');
  const tooLong = 'x'.repeat(400_001);
  await box.fill(tooLong);
  await box.press('Enter');
  await page.waitForSelector('.toast >> text=too long', { timeout: 10_000 });
  check('a refused message is given back to the composer', (await box.inputValue()).length === tooLong.length);
  await box.fill('');

  const busyTask =
    'Run the shell command `sleep 8` as a foreground Bash command, twelve separate times, one after another. Never run it in the background. Then reply DONE.';
  await box.fill(
    `Wiring test, follow literally. In one step use spawn_agent three times: an agent titled "shell job" with the task "Use spawn_agent to start an agent titled helper job with the task: Run the shell command \`sleep 6; echo ready\` and reply with its output. When its report arrives, reply SHELL-DONE plus what it said. Never call stop_agent.", an agent titled "list job" with the task "Use the Write tool to save a three-item markdown list of fruit to fruit.md. Then reply with the same list and a short python code block printing hi." and an agent titled "busy one" with the task "${busyTask}". Then end your turn. When every report has arrived, summarise them in a short markdown table.`,
  );
  await box.press('Enter');
  await page.waitForSelector('.user .bubble');
  log('sent');

  // Approval card: the first one appears, names the agent, takes focus (nobody is typing), Allow works.
  const firstCard = page.locator('.card[role="alertdialog"]').first();
  await firstCard.waitFor({ timeout: 120_000 });
  const asker = (await firstCard.locator('.who').textContent())?.trim() ?? '';
  check('an approval card names the agent', asker.length > 0 && ((await firstCard.getAttribute('aria-label')) ?? '').includes(asker));
  check('the card takes focus', await page.evaluate(() => document.activeElement?.getAttribute('role') === 'alertdialog'));
  const cardId = await firstCard.evaluate((el) => el.outerHTML);
  await firstCard.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.waitForFunction((html) => ![...document.querySelectorAll('.card[role="alertdialog"]')].some((el) => el.outerHTML === html), cardId, { timeout: 10_000 }).catch(() => {});
  check('Allow answers the card', !(await page.evaluate((html) => [...document.querySelectorAll('.card[role="alertdialog"]')].some((el) => el.outerHTML === html), cardId)));

  // Approve anything the agents ask for.
  approver = setInterval(async () => {
    const allow = page.locator('.card .btn.primary', { hasText: 'Allow' }).first();
    if (await allow.count()) await allow.click().catch(() => {});
  }, 500);

  await page.waitForSelector('aside.right .agent >> text=helper job', { timeout: 120_000 });
  await page.screenshot({ path: `${shots}/2-working-${scheme}.png` });
  await page.getByRole('tab', { name: /Team map/ }).click();
  await page.waitForSelector('.map .card >> text=helper job');
  // Lead > shell job > helper job: a card three levels deep in the tree.
  check('the map shows three levels', (await page.locator('.map .tree.root > li > ul > li > ul > li > .card', { hasText: 'helper job' }).count()) === 1);
  const names = await page.locator('.map .card .name').allTextContents();
  check('agents are named Alpha, Bravo, Charlie, Delta', ['Alpha', 'Bravo', 'Charlie', 'Delta'].every((n) => names.includes(n)));
  await page.locator('.map .card.tier-sonnet', { hasText: 'helper job' }).first().hover();
  await page.waitForSelector('.map .preview');
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
  await busyOne.locator('.dot.running').waitFor({ timeout: 90_000 });
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
  // Its reply has a python code block: the page's own code-block markup survives the sanitiser in a real browser.
  await page.waitForSelector('.md .code-block .code-copy', { timeout: 30_000 }).catch(() => {});
  check('code blocks render with a Copy button', (await page.locator('.md .code-block .code-copy').count()) >= 1);
  // The message box says who it is pointed at, and Back returns it to the lead.
  const targetLine = (await page.locator('.addressee .to').textContent().catch(() => '')) ?? '';
  const placeholderText = (await page.locator('textarea').getAttribute('placeholder')) ?? '';
  check('the composer names the sub-agent it is pointed at', /^To \S/.test(targetLine.trim()) && placeholderText.includes('not Alpha'));
  await page.locator('.addressee .back', { hasText: 'Back to Alpha' }).click();
  await page.waitForFunction(() => !document.querySelector('.crumbs'), null, { timeout: 5000 }).catch(() => {});
  check('Back returns the composer to the lead', (await page.locator('.addressee').count()) === 0 && (await page.locator('.crumbs').count()) === 0);

  // Wait for all three reports and a table written after the last of them (the lead may draw interim tables).
  await page.waitForFunction(
    () => {
      const reports = document.querySelectorAll('.inbound.report');
      if (reports.length < 3) return false;
      const last = reports[reports.length - 1];
      return [...document.querySelectorAll('.md.assistant table')].some((t) => last.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
    },
    null,
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
  check('the final answer has a table', (await page.locator('.md.assistant table').count()) >= 1);

  // Reload: the conversation comes back from disk.
  await page.reload();
  await page.waitForSelector('.md.assistant table');
  check('the conversation survives a reload', (await page.locator('.user .bubble').count()) === 1);
  check('the sidebar lists it', (await page.locator('aside.left .row').count()) >= 1);
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
