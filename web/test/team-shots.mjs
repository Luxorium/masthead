// Screenshots of the team panel with a busy three-level team, on the fake backend, for review.
// Not part of the test suites. Usage (a FRESH test server on another port than 7717, started with
// MASTHEAD_BACKEND=fake MASTHEAD_ALLOW_FAKE=1, which also keeps it away from the real Tailscale, and its settings.json allowing 6 Opus, 1 Sonnet, 2 Haiku
// and permissionMode "default"):
//   MASTHEAD_DATA_DIR=<its data folder> node web/test/team-shots.mjs http://127.0.0.1:7798 <shots folder>
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [base = 'http://127.0.0.1:7798', out = '.'] = process.argv.slice(2);
if (new URL(base).port === '7717') throw new Error('Not against the installed Masthead (7717).');
mkdirSync(out, { recursive: true });
const key = readFileSync(join(process.env.MASTHEAD_DATA_DIR ?? '', 'secret'), 'utf8').trim();
const url = `${base}/#key=${encodeURIComponent(key)}`;
const executablePath = process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

// "[" written as [ inside the JSON so the lead does not act on a marker meant for a helper.
const spawn = (title, task) => `Call the tool spawn_agent with input ${JSON.stringify({ title, task }).replace(/\[/g, '\\u005b').replace(/`/g, '\\u0060')}`;
const messages = [
  // Three levels, all still working: Opus waits on Sonnet, which waits on Haiku's long background task.
  spawn('Codex backend', spawn('Codex docs research', spawn('List Codex flags', '[[background 900s]] Reply with exactly the word listing'))),
  // Its Sonnet helper waits its turn: one Sonnet at a time.
  spawn('The page', spawn('Wiki: web pages', 'Reply with exactly the word wiki')),
  // Running: waits for permission to run a command.
  spawn('Platforms and CI', 'Run the shell command `npm run check`'),
  spawn('Remote access', '[[error Usage limit reached]]'),
  spawn('State machine', '[[background 900s]] Reply with exactly the word busy'),
  spawn('Platform audit', 'Reply with exactly the word done'),
];

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await page.goto(url);
await page.waitForSelector('text=What are we working on?');
const box = page.locator('textarea');
for (const [i, m] of messages.entries()) {
  await box.fill(m);
  await box.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.user .bubble').length >= n, i + 1);
}
const panel = page.locator('aside.right');
if (!(await panel.count())) await page.locator('.team-btn').click();
await panel.locator('.row', { hasText: 'List Codex flags' }).waitFor({ timeout: 60_000 });
// Stop one by hand, so the team has a stopped helper too.
const machine = panel.locator('.row', { hasText: 'State machine' }).first();
if (await machine.getByRole('button', { name: /^Stop / }).waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
  await machine.getByRole('button', { name: /^Stop / }).click();
  await machine.locator('.doing', { hasText: 'Stopped' }).waitFor({ timeout: 20_000 }).catch(() => {});
} else console.log('State machine was not live; no stopped helper in the shots');
console.log(JSON.stringify(await panel.locator('.row').allInnerTexts()));
await page.waitForTimeout(800);
const convUrl = page.url();
await page.close();

const shots = [];
async function shoot(name, width, height, scheme, hideFinished = false) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const p = await ctx.newPage();
  await p.goto(url.replace(/#.*/, '') + '#key=' + encodeURIComponent(key));
  await p.waitForLoadState('networkidle');
  await p.goto(convUrl.replace(/#key=.*/, ''));
  await p.waitForSelector('.team-btn', { timeout: 20_000 });
  if (!(await p.locator('aside.right').count())) await p.locator('.team-btn').click();
  await p.locator('aside.right div.row').first().waitFor();
  if (hideFinished) await p.locator('aside.right').getByLabel('Hide finished').check();
  await p.mouse.move(2, 2);
  await p.waitForTimeout(400);
  const file = join(out, `${name}.png`);
  await p.screenshot({ path: file });
  shots.push(file);
  await ctx.close();
}
for (const scheme of ['dark', 'light']) {
  await shoot(`desktop-1440-${scheme}`, 1440, 900, scheme);
  await shoot(`drawer-1000-${scheme}`, 1000, 800, scheme);
  await shoot(`phone-390-${scheme}`, 390, 844, scheme);
}
await shoot('desktop-1440-dark-hide-finished', 1440, 900, 'dark', true);
await browser.close();
console.log(shots.join('\n'));
