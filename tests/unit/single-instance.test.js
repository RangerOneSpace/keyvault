// Only one KeyVault process may own a vault. Reproduces a review finding where
// a daemon older than 30 seconds could be joined by a second one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/keyvault.js', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a second daemon will not start while the first is alive, even after 30 seconds', { timeout: 90_000 }, async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-single-'));
  const env = { ...process.env, KEYVAULT_HOME: HOME, KEYVAULT_NO_BROWSER: '1' };
  const a = spawn(process.execPath, [BIN, 'serve', '--no-open', '--background'], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(HOME, 'agent.json')); i++) await sleep(100);
    const agentA = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'));
    await sleep(33_000);                                // past the stale limit
    fs.unlinkSync(path.join(HOME, 'agent.json'));       // make the liveness check fail
    const b = spawn(process.execPath, [BIN, 'serve', '--no-open', '--background'], { env, stdio: 'ignore' });
    const code = await new Promise(r => b.on('exit', r));
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(path.join(HOME, 'agent.json')), 'second daemon must not have started');
    assert.doesNotThrow(() => process.kill(agentA.pid, 0), 'first daemon still running');
  } finally {
    a.kill();
  }
});
