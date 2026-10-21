import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderEnv, resolveKey, buildBindings, redactor, runWithSecrets, writeEnvFile } from '../../src/secrets.js';

const keys = [
  { id: 'a1', name: 'Anthropic Prod', envVar: 'ANTHROPIC_API_KEY', value: 'keyvault-test-secret-01', status: 'active' },
  { id: 'b2', name: 'OpenAI Dev', envVar: 'OPENAI_API_KEY', value: 'keyvault-test-secret-02', status: 'active' },
  { id: 'c3', name: 'Old Key', envVar: '', value: 'old-CCCCCCCC', status: 'revoked' },
  { id: 'd4', name: 'Dup', envVar: '', value: 'd1', status: 'active' },
  { id: 'e5', name: 'dup', envVar: '', value: 'd2', status: 'active' },
];

test('resolveKey finds by id, name and env var', () => {
  assert.equal(resolveKey(keys, 'a1').id, 'a1');
  assert.equal(resolveKey(keys, 'openai dev').id, 'b2');
  assert.equal(resolveKey(keys, 'ANTHROPIC_API_KEY').id, 'a1');
  assert.throws(() => resolveKey(keys, 'nope'), /No key matches/);
  assert.throws(() => resolveKey(keys, 'DUP'), /matches 2 keys/);
});

test('buildBindings refuses revoked keys and bad names', () => {
  assert.throws(() => buildBindings(keys, { vars: { X: 'Old Key' } }), /revoked/);
  assert.throws(() => buildBindings(keys, { vars: { '1BAD': 'a1' } }), /not a valid/);
  assert.throws(() => buildBindings(keys, {}), /No keys selected/);
  const b = buildBindings(keys, { keys: ['Anthropic Prod'], vars: { MY_OAI: 'b2' } });
  assert.deepEqual([...b.keys()], ['MY_OAI', 'ANTHROPIC_API_KEY']);
});

test('renderEnv merges without losing other lines', () => {
  const existing = '# config\nPORT=3000\nexport ANTHROPIC_API_KEY=old\n';
  const out = renderEnv(existing, new Map([['ANTHROPIC_API_KEY', 'new-value'], ['OPENAI_API_KEY', 'with space']]));
  assert.match(out, /^# config\nPORT=3000\nANTHROPIC_API_KEY=new-value\n/);
  assert.match(out, /OPENAI_API_KEY='with space'\n$/);
  const replaced = renderEnv(existing, new Map([['A', 'b']]), 'replace');
  assert.ok(!replaced.includes('PORT'));
});

test('redactor scrubs every value it is given', () => {
  const scrub = redactor(keys);
  const t = scrub('key=keyvault-test-secret-01 and keyvault-test-secret-02 and old-CCCCCCCC');
  assert.equal(t, 'key=[KEYVAULT:ANTHROPIC_API_KEY] and [KEYVAULT:OPENAI_API_KEY] and [KEYVAULT:Old Key]');
});

test('two keys with the same env var name are both scrubbed (review H2)', () => {
  const scrub = redactor([
    { name: 'OpenAI prod', envVar: 'OPENAI_API_KEY', value: 'sk-PROD-11111111' },
    { name: 'OpenAI dev', envVar: 'OPENAI_API_KEY', value: 'sk-DEV-22222222' },
  ]);
  assert.equal(scrub('sk-PROD-11111111 sk-DEV-22222222'), '[KEYVAULT:OPENAI_API_KEY] [KEYVAULT:OPENAI_API_KEY]');
});

test('a key cut off at the end of output is removed (review M2)', () => {
  const scrub = redactor([{ name: 'S', envVar: 'S', value: 'keyvault-test-secret-03' }]);
  assert.equal(scrub.tail('log line keyvault-test-secret-'), 'log line [KEYVAULT:S](cut)');
  assert.equal(scrub.tail('nothing here'), 'nothing here');
});

test('env values with $ are written literally', () => {
  const out = renderEnv('', new Map([['A', 'pa$$word'], ['B', "it's"]]));
  assert.match(out, /^A='pa\$\$word'$/m);
  assert.match(out, /^B="it's"$/m);
});

test('writeEnvFile refuses non-env files and KeyVault\'s own folder (review M3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-env2-'));
  const b = buildBindings(keys, { keys: ['a1'] });
  assert.throws(() => writeEnvFile({ file: path.join(dir, 'agent.json'), bindings: b }), /only writes dotenv/);
  assert.throws(() => writeEnvFile({ file: path.join(dir, '.ssh-config'), bindings: b }), /only writes dotenv/);
  assert.throws(() => writeEnvFile({ file: path.join(dir, '.env'), bindings: b, forbiddenDirs: [dir] }), /own folder/);
  for (const ok of ['.env', '.env.local', 'prod.env']) writeEnvFile({ file: path.join(dir, ok), bindings: b, ensureGitignore: false });
});

test('runWithSecrets injects keys and hides them from output', async () => {
  const bindings = buildBindings(keys, { keys: ['a1'] });
  const r = await runWithSecrets({
    command: `"${process.execPath}" -e "console.log('got', process.env.ANTHROPIC_API_KEY.length, process.env.ANTHROPIC_API_KEY)"`,
    cwd: os.tmpdir(), bindings, timeoutSec: 20,
  });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, new RegExp(`got ${keys[0].value.length} \\[KEYVAULT:ANTHROPIC_API_KEY\\]`));
  assert.ok(!r.stdout.includes('AAAAAAAA'));
});

test('runWithSecrets stops commands that run too long', async () => {
  const bindings = buildBindings(keys, { keys: ['a1'] });
  const r = await runWithSecrets({ command: `"${process.execPath}" -e "setTimeout(()=>{},60000)"`, cwd: os.tmpdir(), bindings, timeoutSec: 1 });
  assert.equal(r.timedOut, true);
});

test('writeEnvFile writes values and gitignores the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-env-'));
  fs.mkdirSync(path.join(dir, '.git'));
  const file = path.join(dir, '.env');
  const r = writeEnvFile({ file, bindings: buildBindings(keys, { keys: ['a1'] }) });
  assert.deepEqual(r.written, ['ANTHROPIC_API_KEY']);
  assert.match(fs.readFileSync(file, 'utf8'), /ANTHROPIC_API_KEY=keyvault-test-secret-01/);
  assert.ok(['added', 'unknown', 'already-ignored'].includes(r.git.status));
  if (r.git.status === 'added') assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\/\.env/);
});
