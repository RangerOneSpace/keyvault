// Agent pass: the page locks after inactivity while AI tools keep working until
// the pass ends, optionally only with one project and its keys. A "minute" is
// shortened to 200 ms here so the timing runs in seconds.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/keyvault.js', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-pass-'));
const MIN = 200;
const PW = 'agent pass test password';
let daemon; let agent; let session = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: agent.port, method, path: p,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const ui = (m, p, b) => req(m, p, { body: b, headers: { 'x-keyvault': '1', 'x-keyvault-session': session } });
const ag = (m, p, b) => req(m, p, { body: b, headers: { authorization: `Bearer ${agent.token}` } });
const uiState = async () => (await ui('GET', '/api/status')).json;
const agState = async () => (await ag('GET', '/agent/status')).json;
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(40); }
  return false;
}

let site; let other; let keyA; let keyB;
before(async () => {
  daemon = spawn(process.execPath, [BIN, 'serve', '--no-open'], {
    env: { ...process.env, KEYVAULT_HOME: HOME, KEYVAULT_NO_BROWSER: '1', KEYVAULT_PORT: '0', KEYVAULT_TEST_MINUTE_MS: String(MIN) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const link = await new Promise(resolve => { let buf = ''; daemon.stdout.on('data', c => { buf += c; const m = /(http:\/\/127\.0\.0\.1:\d+\/open\?t=\S+)/.exec(buf); if (m) resolve(m[1]); }); });
  agent = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'));
  session = /#session=([\w-]+)$/.exec((await fetch(link, { redirect: 'manual' })).headers.get('location'))[1];
  assert.equal((await ui('POST', '/api/create', { password: PW, orgs: ['Ranger One'] })).status, 200);
  const org = (await ui('GET', '/api/vault')).json.orgs[0].id;
  keyA = (await ui('POST', '/api/keys', { name: 'Site Supabase', provider: 'Supabase', type: 'Database', envVar: 'SUPABASE_KEY', value: 'sb-site-0001', orgId: org })).json.key?.id;
  keyB = (await ui('POST', '/api/keys', { name: 'Bank API', provider: 'Bank', type: 'Payments', envVar: 'BANK_KEY', value: 'bank-secret-0002', orgId: org })).json.key?.id;
  const v = (await ui('GET', '/api/vault')).json;
  keyA ||= v.keys.find(k => k.name === 'Site Supabase').id;
  keyB ||= v.keys.find(k => k.name === 'Bank API').id;
  site = (await ui('POST', '/api/projects', { name: 'Website', keyIds: [keyA] })).json.project;
  other = (await ui('POST', '/api/projects', { name: 'Bank sync' })).json.project;
  assert.equal((await ui('PUT', '/api/settings', { autoLockMin: 1 })).status, 200);   // 1 "minute" = 200 ms
});
after(() => { daemon?.kill(); });

test('without a pass, inactivity locks everything', async () => {
  assert.ok(await until(async () => (await agState()).state === 'locked'), 'agents locked out');
  assert.equal((await uiState()).state, 'locked');
});

test('a pass limited to one project: the page locks, agents keep working with only that project', async () => {
  assert.equal((await ui('POST', '/api/unlock', { password: PW })).status, 200);
  assert.equal((await ui('POST', '/api/agent-pass', { until: Date.now() + 2 * MIN })).status, 400, 'at least 5 minutes away');
  assert.equal((await ui('POST', '/api/agent-pass', { until: Date.now() + 25 * 60 * MIN })).status, 400, 'at most 24 hours');
  const r = await ui('POST', '/api/agent-pass', { until: Date.now() + 30 * MIN, projectId: site.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.pass.project.name, 'Website');

  const keys = (await ag('GET', '/agent/keys')).json.keys.map(k => k.name);
  assert.deepEqual(keys, ['Site Supabase'], 'only the project\'s keys');
  assert.deepEqual((await ag('GET', '/agent/projects')).json.projects.map(x => x.name), ['Website']);
  assert.equal((await ag('GET', '/agent/project?ref=bank')).status, 403);
  assert.equal((await ag('POST', '/agent/projects', { name: 'New thing', folders: [] })).status, 403);
  const run = await ag('POST', '/agent/run', { command: `"${process.execPath}" -e "console.log(process.env.BANK_KEY||'none')"`, keys: ['BANK_KEY'] });
  assert.notEqual(run.status, 200, 'keys outside the pass cannot be used');

  // The page locks after inactivity; the vault stays open for agents.
  assert.ok(await until(async () => (await uiState()).state === 'locked'), 'page locked');
  const st = await uiState();
  assert.ok(st.pass && st.pass.until > Date.now(), 'lock screen knows a pass is running');
  assert.equal(st.pass.project, undefined, 'the lock screen does not show which project');
  assert.equal((await ui('GET', '/api/vault')).status, 423, 'nothing readable from the page');
  assert.equal((await agState()).state, 'unlocked');
  assert.match((await agState()).pass.limitedTo, /Website/);

  const add = await ag('POST', '/agent/project/checklist', { ref: 'website', items: [{ phase: 'Overnight', title: 'Ran the migration', status: 'done' }], client: 'Claude Code' });
  assert.equal(add.status, 200, 'agents can still update their project');

  // Unlocking the page again keeps the agents' changes.
  assert.equal((await ui('POST', '/api/unlock', { password: 'wrong password!' })).status, 403);
  assert.equal((await ui('POST', '/api/unlock', { password: PW })).status, 200);
  const v = (await ui('GET', '/api/vault')).json;
  assert.ok(v.projects.find(x => x.name === 'Website').items.some(i => i.title === 'Ran the migration'));
  assert.ok(v.audit.some(a => a.action === 'agent-pass'));
});

test('ending the pass from the lock screen locks everything', async () => {
  assert.ok(await until(async () => (await uiState()).state === 'locked'), 'page locked again');
  assert.equal((await ui('DELETE', '/api/agent-pass')).status, 200);
  assert.equal((await agState()).state, 'locked');
  assert.equal((await uiState()).pass, null);
});

test('when the pass runs out, KeyVault locks completely', async () => {
  assert.equal((await ui('POST', '/api/unlock', { password: PW })).status, 200);
  assert.equal((await ui('POST', '/api/agent-pass', { until: Date.now() + 6 * MIN })).status, 200);
  assert.equal((await ag('GET', '/agent/keys')).json.keys.length, 2, 'everything when not limited');
  assert.ok(await until(async () => (await uiState()).state === 'locked' && (await agState()).state === 'unlocked'), 'page locks first');
  assert.ok(await until(async () => (await agState()).state === 'locked', 4000), 'then everything at the end of the pass');
});

test('Lock ends a pass at once', async () => {
  assert.equal((await ui('POST', '/api/unlock', { password: PW })).status, 200);
  assert.equal((await ui('POST', '/api/agent-pass', { until: Date.now() + 60 * MIN })).status, 200);
  assert.equal((await ui('POST', '/api/lock')).status, 200);
  assert.equal((await agState()).state, 'locked');
  assert.equal((await ui('POST', '/api/unlock', { password: PW })).status, 200);
  assert.equal((await ui('GET', '/api/agent-pass')).json.pass, null, 'no pass after a lock');
});
