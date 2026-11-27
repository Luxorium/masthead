// Drives the real page in a headless browser against a running Masthead and saves screenshots.
// Usage: node test/ui.e2e.mjs <url> <screenshot folder>
// It sends real messages, so point it at a test server whose settings use cheap models.
import { chromium } from 'playwright-core';

const [url = 'http://127.0.0.1:7799', shots = '.'] = process.argv.slice(2);
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
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

try {
  await page.goto(url);
  await page.waitForSelector('text=What are we working on?');
  await page.screenshot({ path: `${shots}/1-new-${scheme}.png` });
  check('new conversation screen renders', (await page.locator('aside.right h2').first().textContent())?.trim() === 'Team');

  // Limits: raise and lower the Opus count.
  const opus = page.locator('.tier.tier-opus');
  const before = await opus.locator('output').textContent();
  await opus.getByLabel('More Opus 5.5 agents').click();
  await page.waitForFunction((b) => document.querySelector('.tier.tier-opus output')?.textContent !== b, before);
  await opus.getByLabel('Fewer Opus 5.5 agents').click();
  check('the stepper changes the limit', true);

  const box = page.locator('textarea');
  await box.fill(
    'Wiring test, follow literally. In one step use spawn_agent twice: an agent titled "shell job" with the task "Use spawn_agent to start an agent titled helper job with the task: Run the shell command `sleep 6; echo ready` and reply with its output. When its report arrives, reply SHELL-DONE plus what it said. Never call stop_agent." and an agent titled "list job" with the task "Write a three-item markdown list of fruit, then a short python code block printing hi." Then end your turn. When both reports arrive, summarise them in a short markdown table.',
  );
  await box.press('Enter');
  await page.waitForSelector('.user .bubble');
  log('sent');

  // Approve anything the agents ask for.
  approver = setInterval(async () => {
    const allow = page.locator('.card .btn.primary', { hasText: 'Allow' }).first();
    if (await allow.count()) await allow.click().catch(() => {});
  }, 500);

  await page.waitForSelector('aside.right .agent >> text=helper job', { timeout: 120_000 });
  await page.screenshot({ path: `${shots}/2-working-${scheme}.png` });
  await page.getByRole('tab', { name: /Team map/ }).click();
  await page.waitForSelector('.map .card >> text=helper job');
  check('the map shows three levels', (await page.locator('.map .card').count()) >= 4);
  const names = await page.locator('.map .card .name').allTextContents();
  check('agents are named Alpha, Bravo, Charlie, Delta', ['Alpha', 'Bravo', 'Charlie', 'Delta'].every((n) => names.includes(n)));
  await page.locator('.map .card.tier-sonnet', { hasText: 'helper job' }).first().hover();
  await page.waitForSelector('.map .preview');
  await page.screenshot({ path: `${shots}/3-map-${scheme}.png` });
  check('hovering an agent previews its chat', (await page.locator('.map .preview .p-task').count()) === 1);
  await page.mouse.move(5, 5);

  // Open a sub-agent from the map and come back.
  await page.locator('.map .card.tier-opus .open', { hasText: 'list job' }).first().click();
  await page.waitForSelector('.crumbs');
  await page.waitForSelector('.inbound.task');
  await page.screenshot({ path: `${shots}/4-agent-${scheme}.png` });
  check('a sub-agent transcript opens with its task', (await page.locator('.inbound.task').count()) === 1);
  await page.locator('.crumbs .back').click();

  await page.waitForFunction(() => document.querySelector('.md.assistant table') !== null, null, { timeout: 180_000 });
  await page.waitForFunction(() => !document.querySelector('.working'), null, { timeout: 60_000 });
  clearInterval(approver);
  await page.screenshot({ path: `${shots}/5-done-${scheme}.png` });
  check('reports reached the lead', (await page.locator('.inbound.report').count()) >= 2);
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
