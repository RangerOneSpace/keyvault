// 1.0.3: KeyVault should not keep sending you back to KeyVault.exe.
//  - it runs in the background, so the window that started it can close
//  - a browser sign-in survives a restart (only a hash is stored on disk)
//  - every tab shares one sign-in (see the UI test), and you can sign others out
//  - longer auto-lock choices, and a way to stop KeyVault from the browser

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/keyvault.js', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-sess-'));
const ENV = { ...process.env, KEYVAULT_HOME: HOME, KEYVAULT_NO_BROWSER: '1', KEYVAULT_PORT: '0' };
const agentFile = path.join(HOME, 'agent.json');

function req(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Start a foreground daemon and sign in with the login link it prints.
async function startAndLogin() {
  try { fs.unlinkSync(agentFile); } catch {}
  const d = spawn(process.execPath, [BIN, 'serve', '--no-open'], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const link = await new Promise((resolve, reject) => {
    let buf = '';
    d.stdout.on('data', c => { buf += c; const m = /(http:\/\/127\.0\.0\.1:\d+\/open\?t=\S+)/.exec(buf); if (m) resolve(m[1]); });
    d.on('exit', () => reject(new Error('daemon exited')));
  });
  const agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
  const u = new URL(link);
  const r = await req(agent.port, 'GET', u.pathname + u.search);
  const session = /#session=([\w-]+)$/.exec(r.headers.location)[1];
  return { d, agent, session };
}
const ui = (agent, session) => (method, p, body) => req(agent.port, method, p, { body, headers: { 'x-keyvault': '1', 'x-keyvault-session': session } });
async function waitExit(proc) { if (proc.exitCode == null) await new Promise(r => proc.once('exit', r)); }

let bg = null;
after(async () => {
  try { const a = JSON.parse(fs.readFileSync(agentFile, 'utf8')); process.kill(a.pid); } catch {}
  if (bg) try { bg.kill(); } catch {}
});

test('a browser sign-in survives a restart, and only a hash of it is stored', async () => {
  const first = await startAndLogin();
  const call = ui(first.agent, first.session);
  assert.equal((await call('POST', '/api/create', { password: 'a long enough password', orgs: ['Straun'] })).status, 200);

  const stored = fs.readFileSync(path.join(HOME, 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(first.session), 'raw session token must never be written to disk');

  // Longer auto-lock choices are accepted, odd ones are not.
  assert.equal((await call('PUT', '/api/settings', { autoLockMin: 480 })).status, 200);
  assert.equal((await call('PUT', '/api/settings', { autoLockMin: 1440 })).status, 200);
  assert.equal((await call('PUT', '/api/settings', { autoLockMin: 7 })).status, 400);

  // Stop from the browser.
  assert.equal((await call('POST', '/api/shutdown')).status, 200);
  await waitExit(first.d);

  // Start again: the same browser session still works, and the vault is locked.
  const second = await startAndLogin();
  const again = ui(second.agent, first.session);
  const st = await again('GET', '/api/status');
  assert.equal(st.status, 200, 'old session accepted after restart');
  assert.equal(st.json.state, 'locked', 'a restart always locks the vault');
  assert.equal((await again('GET', '/api/vault')).status, 423, 'the session alone never opens the vault');
  assert.equal((await again('POST', '/api/unlock', { password: 'a long enough password' })).status, 200);

  // Sign out other browsers: the first session stays, the second one goes.
  assert.equal((await again('POST', '/api/sessions/revoke')).status, 200);
  assert.equal((await again('GET', '/api/status')).status, 200);
  assert.equal((await ui(second.agent, second.session)('GET', '/api/status')).status, 401);

  await again('POST', '/api/shutdown');
  await waitExit(second.d);
});

test('"keyvault" starts KeyVault in the background, so closing the launcher does not stop it', { timeout: 60_000 }, async () => {
  try { fs.unlinkSync(agentFile); } catch {}
  const launcher = spawn(process.execPath, [BIN], { env: ENV, stdio: 'ignore' });
  await waitExit(launcher);                                   // the launcher window is gone
  for (let i = 0; i < 50 && !fs.existsSync(agentFile); i++) await sleep(100);
  const a = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
  assert.notEqual(a.pid, launcher.pid);
  assert.doesNotThrow(() => process.kill(a.pid, 0), 'background KeyVault still running');
  const r = await req(a.port, 'GET', '/agent/status', { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(r.status, 200);
  await req(a.port, 'POST', '/agent/shutdown', { body: {}, headers: { authorization: `Bearer ${a.token}` } });
});
