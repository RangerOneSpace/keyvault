import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kc from '../../src/crypto.js';

test('seal and open round trip', async () => {
  const salt = kc.newSalt();
  const key = await kc.deriveKey('correct horse battery', salt, 100_000);
  const text = kc.seal(key, salt, 100_000, { hello: 'world', n: 1 });
  const env = kc.parseEnvelope(text);
  assert.ok(env);
  const r = await kc.openEnvelope(env, 'correct horse battery');
  assert.deepEqual(r.data, { hello: 'world', n: 1 });
});

test('wrong password is rejected', async () => {
  const salt = kc.newSalt();
  const key = await kc.deriveKey('right password', salt, 100_000);
  const env = kc.parseEnvelope(kc.seal(key, salt, 100_000, { a: 1 }));
  await assert.rejects(kc.openEnvelope(env, 'wrong password'), kc.WrongPasswordError);
});

test('a modified file is rejected', async () => {
  const salt = kc.newSalt();
  const key = await kc.deriveKey('pw-pw-pw-pw', salt, 100_000);
  const env = kc.parseEnvelope(kc.seal(key, salt, 100_000, { secret: 'x'.repeat(50) }));
  const ct = Buffer.from(env.ct, 'base64');
  ct[5] ^= 1;
  env.ct = ct.toString('base64');
  await assert.rejects(kc.openEnvelope(env, 'pw-pw-pw-pw'), kc.WrongPasswordError);
});

test('ciphertext does not contain the plaintext', async () => {
  const salt = kc.newSalt();
  const key = await kc.deriveKey('pw-pw-pw-pw', salt, 100_000);
  const text = kc.seal(key, salt, 100_000, { value: 'sk-ant-SUPERSECRET' });
  assert.ok(!text.includes('SUPERSECRET'));
});

test('parseEnvelope rejects junk and hostile settings', () => {
  assert.equal(kc.parseEnvelope('not json'), null);
  assert.equal(kc.parseEnvelope('{"app":"other"}'), null);
  const good = { app: 'keyvault', v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 600000, salt: Buffer.alloc(16).toString('base64') }, iv: Buffer.alloc(12).toString('base64'), ct: 'AAAA' };
  assert.ok(kc.parseEnvelope(JSON.stringify(good)));
  assert.equal(kc.parseEnvelope(JSON.stringify({ ...good, kdf: { ...good.kdf, iter: 1e9 } })), null, 'absurd iteration count');
  assert.equal(kc.parseEnvelope(JSON.stringify({ ...good, kdf: { ...good.kdf, iter: 10 } })), null, 'weak iteration count');
});
