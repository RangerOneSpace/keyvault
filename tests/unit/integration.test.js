// Runs the real daemon and the real MCP server, the way an AI tool would.
// Several tests here reproduce findings from an independent security review,
// so they must keep passing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/keyvault.js', import.meta.url));
// Set KEYVAULT_TEST_EXE to run these tests against a built standalone executable.
const EXE = process.env.KEYVAULT_TEST_EXE;
const self = args => (EXE ? [EXE, args] : [process.execPath, [BIN, ...args]]);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-it-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-work-'));
const ENV = { ...process.env, KEYVAULT_HOME: HOME, KEYVAULT_NO_BROWSER: '1' };
const SECRET = 'keyvault-test-anthropic-secret-not-real-0123456789';
const OTHER = 'keyvault-test-stripe-secret-not-real-0123456789';
const PASSWORD = 'integration test password';

let daemon; let agent; let session = '';
const links = [];
let linkWaiter = null;

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: agent.port, method, path: p,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const ui = (method, p, body) => req(method, p, { body, headers: { 'x-keyvault-session': session, 'x-keyvault': '1' } });
const ag = (method, p, body) => req(method, p, { body, headers: { authorization: `Bearer ${agent.token}` } });

// Foreground `keyvault serve` prints a login link, and a fresh one on Enter.
function nextLink() {
  if (links.length) return Promise.resolve(links.shift());
  return new Promise(resolve => { linkWaiter = resolve; daemon.stdin.write('\n'); });
}
async function login() {
  const url = new URL(await nextLink());
  const r = await req('GET', url.pathname + url.search);
  assert.equal(r.status, 302);
  const m = /#session=([\w-]+)$/.exec(r.headers.location);
  assert.ok(m, `expected a session in ${r.headers.location}`);
  return m[1];
}

before(async () => {
  daemon = spawn(...self(['serve', '--no-open']), { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const agentFile = path.join(HOME, 'agent.json');
  for (let i = 0; i < 100 && !fs.existsSync(agentFile); i++) await new Promise(r => setTimeout(r, 100));
  agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
  session = await login();
});

after(async () => {
  try { await ag('POST', '/agent/shutdown', {}); } catch {}
  daemon?.kill();
});

test('rejects requests without a session, from other sites, or with the wrong host', async () => {
  assert.equal((await req('GET', '/api/status', { headers: { 'x-keyvault': '1' } })).status, 401);
  assert.equal((await req('GET', '/api/status', { headers: { 'x-keyvault-session': session } })).status, 403, 'missing custom header');
  assert.equal((await req('GET', '/api/status', { headers: { 'x-keyvault-session': session, 'x-keyvault': '1', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('GET', '/api/status', { headers: { 'x-keyvault-session': session, 'x-keyvault': '1', host: 'evil.example' } })).status, 421);
  assert.equal((await req('GET', '/agent/status', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await req('GET', '/agent/status', { headers: { authorization: `Bearer ${agent.token}`, origin: 'http://127.0.0.1' } })).status, 403);
});

test('login links are single use and never set cookies', async () => {
  const url = new URL(await nextLink());
  const first = await req('GET', url.pathname + url.search);
  assert.match(first.headers.location, /#session=/);
  assert.equal(first.headers['set-cookie'], undefined, 'no cookie that other localhost servers could receive');
  const again = await req('GET', url.pathname + url.search);
  assert.equal(again.headers.location, '/', 'second use gives no session');
});

test('the agent token cannot obtain a browser login (review H3)', async () => {
  const r = await ag('POST', '/agent/open', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.url, undefined);
  assert.ok(!r.text.includes('/open?t='));
});

test('serves the UI with a strict content security policy', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.match(r.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(r.headers['content-security-policy'], /font-src 'self'/);
});

test('serves the Ranger One brand fonts itself (no outside requests)', async () => {
  for (const f of ['inter-400', 'inter-900', 'jetbrains-mono-400']) {
    const r = await req('GET', `/fonts/${f}.woff2`);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers['content-type'], 'font/woff2');
  }
  assert.equal((await req('GET', '/fonts/../vault.json')).status, 404);
});

let ids = {};
test('create, add keys, and the vault file stays encrypted', async () => {
  assert.equal((await ui('GET', '/api/status')).json.state, 'none');
  assert.equal((await ui('POST', '/api/create', { password: 'short' })).status, 400);
  assert.equal((await ui('POST', '/api/create', { password: PASSWORD, orgs: ['Straun Group', 'Forest Grove'] })).status, 200);
  const v = (await ui('GET', '/api/vault')).json;
  assert.deepEqual(v.orgs.map(o => o.name), ['Straun Group', 'Forest Grove']);
  const add = await ui('POST', '/api/keys', { name: 'Anthropic Prod', orgId: v.orgs[0].id, provider: 'Anthropic', type: 'LLM', envVar: 'ANTHROPIC_API_KEY', value: SECRET });
  assert.equal(add.status, 200);
  assert.equal(add.json.key.value, undefined, 'list responses never carry the value');
  ids.a = add.json.key.id;
  const add2 = await ui('POST', '/api/keys', { name: 'Stripe Live', orgId: v.orgs[1].id, provider: 'Stripe', type: 'Payments', envVar: 'STRIPE_SECRET_KEY', value: OTHER });
  ids.b = add2.json.key.id;
  const dup = await ui('POST', '/api/keys', { name: 'Copy', orgId: v.orgs[0].id, provider: 'Anthropic', value: SECRET });
  assert.equal(dup.status, 409);
  assert.equal((await ui('GET', `/api/keys/${ids.a}/secret`)).json.value, SECRET);
  const onDisk = fs.readFileSync(path.join(HOME, 'vault.json'), 'utf8');
  assert.ok(!onDisk.includes(SECRET) && !onDisk.includes('Anthropic'), 'nothing readable on disk');
});

test('MCP server: tools work and never reveal any key', async () => {
  const mcp = spawn(...self(['mcp']), { env: ENV, cwd: WORK, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiting = new Map(); let nextId = 1;
  mcp.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise(resolve => {
    const id = nextId++; waiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const callTool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const noSecrets = (r, what) => {
    const t = JSON.stringify(r);
    assert.ok(!t.includes(SECRET) && !t.includes(OTHER), `${what} leaked a key: ${t.slice(0, 400)}`);
    for (const s of [SECRET, OTHER]) assert.ok(!t.includes(s.slice(0, 12)), `${what} leaked part of a key`);
  };

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'keyvault');
    assert.match(init.result.instructions, /call verify_package/);
    assert.match(init.result.instructions, /Never use a package marked BLOCKED_BY_DATASET/);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    for (const t of ['verify_package', 'list_keys', 'write_env_file', 'run_with_secrets', 'list_services', 'free_port']) assert.ok(tools.includes(t), t);

    const blockedPackage = await callTool('verify_package', { ecosystem: 'pypi', name: 'litestar-websocket' });
    assert.equal(blockedPackage.isError, undefined);
    assert.match(blockedPackage.content[0].text, /Decision: BLOCKED_BY_DATASET/);
    assert.match(blockedPackage.content[0].text, /DO NOT USE/);

    const list = await callTool('list_keys');
    assert.match(list.content[0].text, /Anthropic Prod/);
    noSecrets(list, 'list_keys');

    const envRes = await callTool('write_env_file', { keys: ['Anthropic Prod', 'Stripe Live'] });
    assert.ok(!envRes.isError, envRes.content[0].text);
    noSecrets(envRes, 'write_env_file');
    assert.match(fs.readFileSync(path.join(WORK, '.env'), 'utf8'), new RegExp(`ANTHROPIC_API_KEY=${SECRET}`));

    const run = await callTool('run_with_secrets', { command: `"${process.execPath}" -e "console.log(process.env.ANTHROPIC_API_KEY)"`, keys: ['ANTHROPIC_API_KEY'] });
    assert.match(run.content[0].text, /\[KEYVAULT:ANTHROPIC_API_KEY\]/);
    noSecrets(run, 'run_with_secrets');

    // Review H1: output is scrubbed of EVERY stored key, not only the bound ones.
    const cat = await callTool('run_with_secrets', {
      command: `"${process.execPath}" -e "process.stdout.write(require('fs').readFileSync('.env','utf8'))"`,
      keys: ['ANTHROPIC_API_KEY'],
    });
    noSecrets(cat, 'reading .env through run_with_secrets');
    assert.match(cat.content[0].text, /\[KEYVAULT:STRIPE_SECRET_KEY\]/);

    // Review M2: a key cut off at the output limit must not leak its first half.
    const pad = 64 * 1024 - 10;
    const cut = await callTool('run_with_secrets', {
      command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(${pad}) + process.env.K)"`,
      vars: { K: 'Stripe Live' },
    });
    noSecrets(cut, 'truncated output');

    // Review M3: env files only, and never inside KeyVault's own folder.
    const bad1 = await callTool('write_env_file', { path: path.join(HOME, 'agent.json'), keys: ['Anthropic Prod'], mode: 'replace' });
    assert.equal(bad1.isError, true);
    const bad2 = await callTool('write_env_file', { path: path.join(HOME, '.env'), keys: ['Anthropic Prod'] });
    assert.equal(bad2.isError, true);
    const bad3 = await callTool('write_env_file', { path: path.join(WORK, 'config.json'), keys: ['Anthropic Prod'] });
    assert.equal(bad3.isError, true);
    assert.ok(fs.existsSync(path.join(HOME, 'agent.json')) && JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8')).token);

    // Review M4: audit fields are capped, so the vault cannot be bloated.
    await callTool('run_with_secrets', { command: `echo ${'y'.repeat(20000)}`, keys: ['ANTHROPIC_API_KEY'] });
    await callTool('container_action', { container: 'z'.repeat(100000), action: 'restart' });

    const svcs = await callTool('list_services');
    assert.ok(!svcs.isError, svcs.content[0].text);

    const audit = (await ui('GET', '/api/vault')).json.audit;
    assert.equal(audit[0].source, 'test-client');
    assert.ok(audit.every(a => (a.target || '').length <= 300));
    assert.ok(fs.statSync(path.join(HOME, 'vault.json')).size < 50_000, 'vault did not balloon');

    await ui('POST', '/api/lock');
    const locked = await callTool('list_keys');
    assert.equal(locked.isError, true);
    assert.match(locked.content[0].text, /locked/i);
  } finally {
    mcp.stdin.end();
    mcp.kill();
  }
});

test('unlock: wrong password is refused, right one works', async () => {
  const bad = await ui('POST', '/api/unlock', { password: 'nope nope nope' });
  assert.equal(bad.status, 403);
  const good = await ui('POST', '/api/unlock', { password: PASSWORD });
  assert.equal(good.status, 200);
  assert.equal((await ui('GET', '/api/vault')).json.keys.length, 2);
});

test('backup download and restore round trip, keeping a copy of what it replaced', async () => {
  const b = await ui('GET', '/api/backup');
  assert.equal(b.status, 200);
  assert.match(b.headers['content-disposition'], /keyvault-backup-/);
  assert.ok(!b.text.includes(SECRET));
  assert.equal((await ui('POST', '/api/restore', { text: 'garbage' })).status, 400);
  assert.equal((await ui('POST', '/api/restore', { text: b.text })).status, 200);
  assert.ok(fs.readdirSync(HOME).some(f => f.startsWith('vault.before-restore-')), 'pre-restore copy kept');
  assert.equal((await ui('GET', '/api/status')).json.state, 'locked');
  assert.equal((await ui('POST', '/api/unlock', { password: PASSWORD })).status, 200);
});

test('services snapshot works through the UI API', async () => {
  const r = await ui('GET', '/api/services?probe=0');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.listeners));
  assert.ok(!r.json.listeners.some(l => l.port === agent.port), 'KeyVault hides its own port');
});
