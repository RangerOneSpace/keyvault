// End-to-end test in a real browser. Also refreshes docs/screenshots when
// KEYVAULT_SCREENSHOTS=1. All data here is made up.

import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHOTS = process.env.KEYVAULT_SCREENSHOTS ? path.join(ROOT, 'docs') : null;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-e2e-'));
// Made-up project folders for the Projects tab: two git repos and a nested one.
const CODE = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-e2e-code-'));
function makeRepo(name, commits, dirty) {
  const d = path.join(CODE, name); fs.mkdirSync(d, { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'demo@example.com'); g('config', 'user.name', 'Demo');
  commits.forEach((c, i) => { fs.writeFileSync(path.join(d, `f${i}.txt`), c); g('add', '.'); g('commit', '-q', '-m', c); });
  for (let i = 0; i < dirty; i++) fs.writeFileSync(path.join(d, `wip${i}.txt`), 'wip');
  return d;
}
const SHOP = makeRepo('northwind-shop', ['Initial storefront', 'Checkout with Stripe test keys'], 2);
makeRepo('northwind-api', ['API skeleton'], 0);
makeRepo(path.join('labs', 'support-agent'), ['Prompt drafts'], 1);
const PASSWORD = 'copper kettle morning';
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForFunction(() => !document.querySelector('.toast.show'), null, { timeout: 6000 }).catch(() => {});
  // Let the R1 boot sequence finish lighting before capturing.
  await page.waitForTimeout(await page.locator('#gate').isVisible() ? 1600 : 250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

let daemon; let agent; let dockerServer; const webServers = [];

// Screenshots for the README should show only the made-up demo apps, not other
// programs that happen to be listening on the machine taking them. Only used
// when KEYVAULT_SCREENSHOTS is set; the tests themselves see real data.
const DEMO_PORTS = [18080, 18000, 15173];
async function demoOnly(page) {
  if (!SHOTS) return;
  await page.addInitScript(ports => {
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      const res = await real(url, opts);
      if (!String(url).startsWith('/api/services') || !res.ok || String(url).includes('/containers/')) return res;
      const data = await res.clone().json();
      if (Array.isArray(data.listeners)) data.listeners = data.listeners.filter(l => ports.includes(l.port));
      return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
    };
  }, DEMO_PORTS);
}

// A stand-in Docker engine, so the Services tab has something to show.
function fakeDocker(sock) {
  const state = { 'northwind-web-1': 'running', 'northwind-api-1': 'running', 'northwind-db-1': 'running', 'redis-cache': 'exited' };
  const c = (name, image, project, service, ports) => ({
    Id: Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64), Names: [`/${name}`], Image: image,
    State: state[name], Status: state[name] === 'running' ? 'Up 3 hours (healthy)' : 'Exited (0) 2 days ago', Created: 1727000000,
    Labels: project ? { 'com.docker.compose.project': project, 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': '/home/you/code/northwind' } : {},
    Ports: ports,
  });
  const s = http.createServer((req, res) => {
    if (req.url === '/version') return res.end(JSON.stringify({ Version: '27.3.1' }));
    if (req.url.startsWith('/containers/json')) {
      return res.end(JSON.stringify([
        c('northwind-web-1', 'northwind/web:latest', 'northwind', 'web', [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 18080, Type: 'tcp' }]),
        c('northwind-api-1', 'northwind/api:latest', 'northwind', 'api', [{ IP: '127.0.0.1', PrivatePort: 8000, PublicPort: 18000, Type: 'tcp' }]),
        c('northwind-db-1', 'postgres:17', 'northwind', 'db', []),
        c('redis-cache', 'redis:7', null, null, []),
      ]));
    }
    const m = /^\/containers\/([^/]+)\/(start|stop|restart|logs)/.exec(req.url);
    if (m && m[2] === 'logs') {
      const b = Buffer.from('2026-09-29T10:00:00Z Server ready on port 3000\n2026-09-29T10:00:01Z Connected to database\n');
      const hdr = Buffer.alloc(8); hdr[0] = 1; hdr.writeUInt32BE(b.length, 4);
      return res.end(Buffer.concat([hdr, b]));
    }
    if (m) {
      const name = Buffer.from(decodeURIComponent(m[1]).replace(/0+$/, ''), 'hex').toString() in state
        ? Buffer.from(decodeURIComponent(m[1]).replace(/0+$/, ''), 'hex').toString() : decodeURIComponent(m[1]);
      if (fakeDocker.failStart === name && m[2] === 'start') { res.statusCode = 500; return res.end(JSON.stringify({ message: 'port is already allocated' })); }
      // Real Docker takes a while to stop a container: the UI must show progress meanwhile.
      const delay = m[2] === 'stop' ? 1200 : 0;
      return setTimeout(() => { state[name] = m[2] === 'stop' ? 'exited' : 'running'; res.statusCode = 204; res.end(); }, delay);
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise(r => s.listen(sock, () => r(s)));
}

function webServer(port, title, icon) {
  const s = http.createServer((req, res) => {
    if (icon && req.url === '/icon.svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end(icon); }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>${title}</title>${icon ? '<link rel="icon" type="image/svg+xml" href="/icon.svg">' : ''}<p>hi`);
  });
  return new Promise(r => s.listen(port, '127.0.0.1', () => { webServers.push(s); r(s); }));
}

test.beforeAll(async () => {
  const sock = path.join(HOME, 'docker.sock');
  dockerServer = await fakeDocker(sock);
  await webServer(18080, 'Northwind Shop');
  await webServer(18000, 'Northwind API docs');
  await webServer(15173, 'Vite + React', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 3 29 27H3z" fill="#9B7BFF"/><path d="M16 10l7 13H9z" fill="#FFB020"/></svg>');
  const exe = process.env.KEYVAULT_TEST_EXE;
  daemon = spawn(exe || process.execPath, exe ? ['serve', '--no-open'] : [path.join(ROOT, 'bin/keyvault.js'), 'serve', '--no-open'], {
    env: { ...process.env, KEYVAULT_HOME: HOME, KEYVAULT_NO_BROWSER: '1', DOCKER_HOST: `unix://${sock}`, XDG_CONFIG_HOME: path.join(HOME, 'xdg') },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  daemon.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = /(http:\/\/127\.0\.0\.1:\d+\/open\?t=\S+)/.exec(line);
      if (m) { if (linkWaiter) { const w = linkWaiter; linkWaiter = null; w(m[1]); } else links.push(m[1]); }
    }
  });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(HOME, 'agent.json')); i++) await new Promise(r => setTimeout(r, 100));
  agent = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'));
});

test.afterAll(async () => {
  daemon?.kill();
  dockerServer?.close();
  webServers.forEach(s => s.close());
});

// Foreground `keyvault serve` prints a one-time login link, and a fresh one on Enter.
const links = []; let linkWaiter = null;
function loginUrl() {
  if (links.length) return Promise.resolve(links.shift());
  return new Promise(resolve => { linkWaiter = resolve; daemon.stdin.write('\n'); });
}

test('full journey: create, add keys, reveal, lock, unlock, services, connect', async ({ page }) => {
  const problems = [];
  // Expected: this test deliberately triggers a duplicate (409) and a wrong password (403).
  page.on('console', m => { if (m.type() === 'error' && !/status of (409|403)/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', e => problems.push(e.message));
  await demoOnly(page);
  page.on('request', r => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') problems.push(`external request: ${r.url()}`); });

  // Create
  await page.goto(await loginUrl());
  await expect(page.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
  await page.fill('#pw', PASSWORD);
  await page.fill('#pw2', PASSWORD);
  await page.fill('#orgs-init', 'Northwind Holdings, Northwind Energy, Northwind Digital, Northwind Labs');
  await shot(page, 'create');
  await page.click('#gate-submit');
  await expect(page.getByText('No keys yet')).toBeVisible();

  // Offered once: start KeyVault at sign-in. Then it lives in Settings.
  const autostartFile = path.join(HOME, 'xdg', 'autostart', 'keyvault.desktop');
  await expect(page.locator('#as-banner')).toBeVisible();
  await page.click('#as-yes');
  await expect(page.locator('#as-banner')).toBeHidden();
  await expect.poll(() => fs.existsSync(autostartFile)).toBe(true);
  expect(fs.readFileSync(autostartFile, 'utf8')).toMatch(/^Exec=.*"background"$/m);
  await page.click('#btn-settings');
  await expect(page.locator('#s-autostart')).toBeChecked();
  await page.locator('#s-autostart').uncheck();
  await expect.poll(() => fs.existsSync(autostartFile)).toBe(false);
  await page.locator('#dlg-settings [data-close]').click();

  // Agent pass: start one, see it in the top bar, end it
  await page.click('#btn-pass');
  await expect(page.locator('#dlg-pass')).toBeVisible();
  await page.fill('#pass-time', '07:00');
  await expect(page.locator('#pass-when')).toContainText('at 07:00');
  if (SHOTS) await page.locator('#dlg-pass').screenshot({ path: path.join(SHOTS, 'agent-pass.png') });
  await page.click('#pass-go');
  await expect(page.locator('#btn-pass')).toHaveText('Agent pass · until 07:00');
  await page.click('#btn-pass');
  await expect(page.locator('#pass-active')).toBeVisible();
  await page.click('#pass-end');
  await expect(page.locator('#btn-pass')).toHaveText('Agent pass');

  // Add a key through the dialog; provider fills in type and env var
  await page.click('#btn-add');
  await page.fill('#f-name', 'Claude, production');
  await page.fill('#f-provider', 'Anthropic');
  await expect(page.locator('#f-envvar')).toHaveValue('ANTHROPIC_API_KEY');
  await page.fill('#f-value', 'keyvault-test-secret-01');
  await page.fill('#f-notes', 'Used by the customer support agent.');
  await page.click('#key-save');
  await expect(page.getByText('Claude, production')).toBeVisible();

  // 1.0.3: a second tab (or a bookmark) opens straight in, no fresh login link needed
  const tab2 = await page.context().newPage();
  await tab2.goto(new URL(page.url()).origin + '/');
  await expect(tab2.getByText('Claude, production')).toBeVisible();
  await tab2.close();

  // Seed a few more (made-up) keys through the same API the page uses
  await page.evaluate(async () => {
    const h = { 'content-type': 'application/json', 'x-keyvault': '1', 'x-keyvault-session': localStorage.getItem('kv-session') };
    const v = await (await fetch('/api/vault', { headers: h })).json();
    const org = n => v.orgs.find(o => o.name === n).id;
    const soon = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
    const add = k => fetch('/api/keys', { method: 'POST', headers: h, body: JSON.stringify(k) });
    await add({ name: 'OpenAI, research', orgId: org('Northwind Labs'), provider: 'OpenAI', type: 'LLM', env: 'Development', envVar: 'OPENAI_API_KEY', value: 'keyvault-test-secret-02', notes: 'Evaluation scripts only.' });
    await add({ name: 'Gemini, marketing copy', orgId: org('Northwind Digital'), provider: 'Google Gemini', type: 'LLM', envVar: 'GEMINI_API_KEY', value: 'AIzaDEMO-9s8d7f6g5h4j3k2l1', expires: soon });
    await add({ name: 'Stripe live', orgId: org('Northwind Energy'), provider: 'Stripe', type: 'Payments', envVar: 'STRIPE_SECRET_KEY', value: 'keyvault-test-secret-03' });
    await add({ name: 'Cloudflare DNS', orgId: org('Northwind Holdings'), provider: 'Cloudflare', type: 'Cloud', envVar: 'CLOUDFLARE_API_TOKEN', value: 'cf-DEMO-a1b2c3d4e5f6g7h8i9' });
    await add({ name: 'OpenAI, old', orgId: org('Northwind Labs'), provider: 'OpenAI', type: 'LLM', status: 'revoked', value: 'keyvault-test-secret-04' });
  });
  await page.click('#btn-lock');
  await page.fill('#pw', PASSWORD);
  await page.click('#gate-submit');
  await expect(page.locator('.key')).toHaveCount(6);

  // Reveal and hide
  const secret = page.getByRole('button', { name: 'Show Claude, production' });
  await secret.click();
  await expect(page.getByText('keyvault-test-secret-01')).toBeVisible();
  await shot(page, 'keys');
  await page.getByRole('button', { name: 'Hide Claude, production' }).click();
  await expect(page.getByText('keyvault-test-secret-01')).toHaveCount(0);

  // Filter by organisation and search
  await page.locator('#nav-orgs .nav', { hasText: 'Northwind Labs' }).click();
  await expect(page.locator('.key')).toHaveCount(2);
  await page.locator('#nav-orgs .nav', { hasText: 'All keys' }).click();
  await page.fill('#search', 'stripe');
  await expect(page.locator('.key')).toHaveCount(1);
  await page.fill('#search', '');

  // Duplicate detection
  await page.click('#btn-add');
  await page.fill('#f-name', 'Copy of Stripe');
  await page.fill('#f-provider', 'Stripe');
  await page.fill('#f-value', 'keyvault-test-secret-03');
  await page.click('#key-save');
  await expect(page.getByText(/already saved as "Stripe live"/)).toBeVisible();
  await page.click('#confirm-cancel');
  await page.locator('#dlg-key [data-close]').first().click();

  // Wrong password, then right one
  await page.click('#btn-lock');
  await page.fill('#pw', 'not the password');
  await page.click('#gate-submit');
  await expect(page.getByText('Incorrect password.')).toBeVisible();
  await page.fill('#pw', PASSWORD);
  await page.click('#gate-submit');
  await expect(page.locator('.key')).toHaveCount(6);

  // Services tab
  await page.click('#tab-services');
  await expect(page.locator('.proj-name').first()).toContainText('northwind');
  await expect(page.locator('.proj')).toHaveCount(2);
  await expect(page.locator('.proj-name').last()).toContainText('Standalone containers');
  await expect(page.locator('#view-services').getByText('Vite + React')).toBeVisible();
  await expect(page.locator('.port-row', { hasText: '18080' })).toContainText('Docker: northwind-web-1');
  await shot(page, 'services');

  // Apps: Netflix-style spotlight and rows of cards
  await page.click('#tab-apps');
  await expect(page.locator('.hero-title')).toBeVisible();
  expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('900 20px Inter') && document.fonts.check('400 12px "JetBrains Mono"'); }), 'brand fonts loaded').toBe(true);
  await expect(page.locator('.row-h', { hasText: 'Running now' })).toBeVisible();
  await expect(page.locator('.row-h', { hasText: 'Docker · northwind' })).toBeVisible();
  const vite = page.locator('.card', { hasText: 'Vite + React' }).first();
  await expect(vite.locator('img.poster-icon')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  await vite.hover();
  await expect(vite.getByRole('link', { name: 'Open Vite + React' })).toHaveAttribute('href', 'http://localhost:15173');
  await expect(page.locator('#apps-sub')).toContainText('running');
  await page.mouse.move(5, 5);
  await shot(page, 'apps');
  if (SHOTS) {   // hover state, for the README
    await page.locator('.app-row').nth(1).locator('.card').first().hover();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'apps-hover.png'), fullPage: true });
    await page.mouse.move(5, 5);
  }

  // Projects: create one, note where you left off, build its checklist, find other repos
  await page.click('#tab-projects');
  await expect(page.getByText('No projects yet.')).toBeVisible();
  await page.click('#proj-new');
  await page.fill('#pn-name', 'Northwind Shop');
  await page.fill('#pn-folder', SHOP);
  await page.selectOption('#pn-org', { label: 'Northwind Digital' });
  await page.fill('#pn-summary', 'Customer storefront for Northwind, Next.js and Stripe.');
  await page.locator('#pn-form button[type=submit]').click();
  await expect(page.locator('#dlg-project')).toBeVisible();
  await expect(page.locator('#pd-folders .pf-git')).toContainText('main');
  await expect(page.locator('#pd-folders .pf-git')).toContainText('2 uncommitted');
  // A new project opens on its (empty) checklist
  await expect(page.locator('#pd-pane-checklist')).toBeVisible();
  await expect(page.locator('#pd-cl-list')).toContainText('No checklist yet.');
  await page.click('#pd-tab-overview');
  await page.fill('#pd-resume', 'Checkout works with Stripe test keys. Webhook for refunds still returns 500.');
  await page.locator('#pd-resume').blur();
  await page.locator('#pd-keys label', { hasText: 'Stripe live' }).locator('input').check();
  await page.fill('#pd-log-new', 'Wired up Stripe checkout');
  await page.press('#pd-log-new', 'Enter');
  await expect(page.locator('#pd-log li').first()).toContainText('Wired up Stripe checkout');
  await page.fill('#pd-name', 'Northwind Storefront');
  await page.press('#pd-name', 'Enter');
  await expect(page.locator('#pd-log li', { hasText: 'Renamed from' })).toBeVisible();
  await expect(page.locator('#pd-ai-say')).toHaveText('Resume Northwind Storefront from KeyVault');

  // Checklist: paste a plan, add phases and items, change status and owner, filter
  await page.click('#pd-tab-checklist');
  await page.click('#pd-cl-paste-btn');
  await page.fill('#pd-cl-paste-text', [
    'Foundations:', '[x] Next.js app with Stripe checkout', '[x] Product catalogue from the CMS', '- Fix refund webhook 500', '[~] Self-hosted payments page',
    '# Phase 1: launch', 'Add order confirmation email', 'Deploy to staging', '  Staging database', 'Point the domain at Vercel',
  ].join('\n'));
  await page.locator('#pd-cl-paste button[type=submit]').click();
  await expect(page.locator('.cl-phase')).toHaveCount(2);
  await expect(page.locator('#pd-cl-done')).toHaveText('2');
  await expect(page.locator('#pd-cl-total')).toHaveText('7');
  await expect(page.locator('.cl-item', { has: page.locator('input[value="Self-hosted payments page"]') }).locator('.cl-ref')).toHaveText('NS-FOUND-004');
  await expect(page.locator('.cl-phase').nth(1).locator('.cl-code')).toHaveText('LAUNCH');
  const webhook = page.locator('.cl-item', { has: page.locator('input[value="Fix refund webhook 500"]') });
  await webhook.locator('select.cl-status').selectOption('in_progress');
  await expect(page.locator('.cl-stat.st-in_progress b')).toHaveText('1');
  await webhook.locator('.cl-owner').fill('human+claude');
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/checklist')), webhook.locator('.cl-owner').press('Enter')]);
  await expect(page.locator('.cl-item', { has: page.locator('input[value="human+claude"]') })).toHaveCount(1);
  const add = page.locator('.cl-phase').nth(1).locator('.cl-item-add input');
  await add.fill('Load test checkout'); await add.press('Enter');
  await expect(page.locator('#pd-cl-total')).toHaveText('8');
  await expect(page.locator('.cl-item', { has: page.locator('input[value="Load test checkout"]') }).locator('.cl-ref')).toHaveText('NS-LAUNCH-004');
  await page.fill('#pd-cl-phase-name', 'Phase 2: after launch');
  await page.fill('#pd-cl-phase-code', 'post');
  await page.locator('#pd-cl-phase-add button[type=submit]').click();
  await expect(page.locator('.cl-phase')).toHaveCount(3);
  await expect(page.locator('.cl-phase').nth(2).locator('.cl-code')).toHaveText('POST');
  await page.locator('.cl-phase').nth(2).locator('.cl-item-add input').fill('Abandoned basket emails');
  await page.locator('.cl-phase').nth(2).locator('.cl-item-add input').press('Enter');
  await expect(page.locator('.cl-item', { has: page.locator('input[value="Abandoned basket emails"]') })).toBeVisible();
  await page.locator('.cl-stat.st-done').click();
  await expect(page.locator('.cl-item')).toHaveCount(2);
  await page.locator('.cl-stat.st-done').click();
  await page.fill('#pd-cl-search', 'webhook');
  await expect(page.locator('.cl-item')).toHaveCount(1);
  await page.fill('#pd-cl-search', '');
  await expect(page.locator('.cl-item')).toHaveCount(10);
  await expect(page.locator('.cl-item.sub', { has: page.locator('input[value="Staging database"]') }).locator('.cl-ref')).toHaveText('└002.1');
  await expect(page.locator('#pd-cl-tabcount')).toHaveText('2/9');
  if (SHOTS) { await page.waitForTimeout(300); await page.locator('#dlg-project').screenshot({ path: path.join(SHOTS, 'project.png') }); }
  await page.locator('#dlg-project .dlg-foot [data-close]').click();

  await page.click('#proj-import');
  await page.fill('#pi-root', CODE);
  await page.locator('#pi-root-form button[type=submit]').click();
  await expect(page.locator('#pi-list li', { hasText: 'northwind-api' })).toBeVisible();
  await expect(page.locator('#pi-list li', { hasText: 'northwind-shop' })).toContainText('Already a project');
  await page.click('#pi-github');
  await expect(page.locator('#dlg-github')).toBeVisible();
  await expect(page.locator('#gh-scope-all')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#gh-mode')).toHaveText('Each repo you add becomes a project');
  await page.click('#gh-scope-mine');
  await expect(page.locator('#gh-list')).toContainText('GITHUB_TOKEN');
  if (SHOTS) await page.locator('#dlg-github').screenshot({ path: path.join(SHOTS, 'github.png') });
  await page.locator('#dlg-github .dlg-foot [data-close]').click();
  await page.locator('#pi-list li', { hasText: 'northwind-api' }).locator('input').check();
  await page.locator('#pi-list li', { hasText: 'support-agent' }).locator('input').check();
  await page.click('#pi-add');
  await expect(page.locator('.pcard')).toHaveCount(3);
  await expect(page.locator('.pcont').first()).toContainText('Northwind Storefront');
  await expect(page.locator('.pcont').first()).toContainText('Webhook for refunds');
  await expect(page.locator('.pcard', { hasText: 'Northwind Storefront' })).toContainText('Doing');
  await expect(page.locator('.pcard', { hasText: 'Northwind Storefront' })).toContainText('NS-FOUND-003 Fix refund webhook 500');
  await expect(page.locator('.pcard', { hasText: 'Northwind Storefront' }).locator('.cl-mini')).toContainText('2/9');
  await page.locator('.pcard', { hasText: 'support-agent' }).click();
  await page.click('#pd-tab-overview');
  await page.fill('#pd-resume', 'Testing the new triage prompt against last week\'s tickets.');
  await page.locator('#pd-resume').blur();
  await page.selectOption('#pd-status', 'paused');
  await page.locator('#dlg-project .dlg-foot [data-close]').click();
  await page.locator('#proj-filters .pf', { hasText: 'All' }).click();
  await expect(page.locator('.pcard')).toHaveCount(3);
  await page.locator('#proj-filters .pf', { hasText: 'Active' }).click();
  await expect(page.locator('.pcont')).toHaveCount(1);
  await page.mouse.move(5, 5);
  await shot(page, 'projects');

  await page.click('#tab-services');

  // Container logs
  await page.getByRole('button', { name: 'Logs for northwind-web-1' }).click();
  await expect(page.locator('#logs-out')).toContainText('Server ready on port 3000');
  await page.locator('#dlg-logs [data-close]').click();

  // Stop a container
  await page.getByRole('button', { name: 'Stop northwind-api-1' }).click();
  await expect(page.getByRole('button', { name: 'Start northwind-api-1' })).toBeVisible();

  // Stop all / Start all on the compose project: visible progress, then the real result
  const proj = page.locator('.proj').first();
  await proj.getByRole('button', { name: 'Stop all' }).click();
  await expect(proj.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  await expect(page.locator('.toast')).toContainText('Stopped northwind.');
  await expect(proj.getByRole('button', { name: 'Start all' })).toBeVisible();
  await expect(proj.locator('.count')).toContainText('0 of 3 running');
  fakeDocker.failStart = 'northwind-db-1';
  await proj.getByRole('button', { name: 'Start all' }).click();
  await expect(page.locator('.toast')).toContainText('1 of 3 failed. northwind-db-1: port is already allocated');
  await expect(proj.locator('.count')).toContainText('2 of 3 running');
  fakeDocker.failStart = null;

  // Link keys to the compose project
  await page.getByRole('button', { name: 'Link keys' }).click();
  await page.locator('#links-rows select').first().selectOption({ label: 'Claude, production (Northwind Holdings)' });
  await expect(page.locator('#links-rows input').first()).toHaveValue('ANTHROPIC_API_KEY');
  await page.locator('#links-form button[type=submit]').click();
  await expect(page.getByRole('button', { name: 'Up with 1 key' })).toBeVisible();

  // Connect AI
  await page.click('#btn-connect');
  await expect(page.getByText('Claude Code', { exact: true })).toBeVisible();
  await expect(page.locator('.snippet pre').first()).toContainText('claude mcp add keyvault');
  await shot(page, 'connect');
  await page.locator('#dlg-connect [data-close]').click();

  // Settings open and show the vault path
  await page.click('#btn-settings');
  await expect(page.locator('#s-path')).toContainText('vault.json');
  await page.locator('#dlg-settings [data-close]').click();

  expect(problems, problems.join('\n')).toEqual([]);
});

test('works at phone width without sideways scrolling', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await demoOnly(page);
  await page.goto(await loginUrl());
  await page.waitForSelector('#gate:not([hidden]), #app:not([hidden])');
  if (await page.locator('#gate').isVisible()) {
    await page.fill('#pw', PASSWORD);
    if (await page.locator('#pw2').isVisible()) await page.fill('#pw2', PASSWORD);
    await page.click('#gate-submit');
  }
  await expect(page.locator('.key, .empty').first()).toBeVisible();
  const wide = () => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = document.documentElement.scrollWidth - vw;
    const culprits = [...document.querySelectorAll('body *')]
      .filter(e => e.offsetParent !== null && e.getBoundingClientRect().right > vw + 1)
      .slice(0, 6).map(e => `${e.tagName.toLowerCase()}.${e.className} right=${Math.round(e.getBoundingClientRect().right)}`);
    return { over, culprits };
  });
  let w = await wide();
  expect(w.over, `keys view is ${w.over}px too wide: ${w.culprits.join(' | ')}`).toBeLessThanOrEqual(0);
  await shot(page, 'mobile');
  await page.click('#tab-services');
  await expect(page.locator('.proj').first()).toBeVisible();
  w = await wide();
  expect(w.over, `services view is ${w.over}px too wide: ${w.culprits.join(' | ')}`).toBeLessThanOrEqual(0);
  await page.close();
});
