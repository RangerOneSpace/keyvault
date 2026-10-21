import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_SHA256, CORPUS_SOURCE, normalizePypiName, parseHallucinationCorpus, verifyPackage } from '../../src/package-safety.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('bundled Trend Micro data is the pinned, parseable source snapshot', () => {
  const corpus = fs.readFileSync(path.join(ROOT, 'data', 'slopsquatting.jsonl')).toString('utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(corpus).digest('hex'), CORPUS_SHA256);
  assert.equal(corpus.trim().split('\n').length, 1400);
  assert.equal(CORPUS_SOURCE.includes('92cc9f6ad9aa77daae858865c1df1edaa67df8ab'), true);
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'slopsquatting-LICENSE.MD')));
});

test('PyPI normalization follows separator and case equivalence', () => {
  assert.equal(normalizePypiName('Litestar_Websocket'), 'litestar-websocket');
  assert.equal(normalizePypiName('a..b___c'), 'a-b-c');
});

test('malformed or schema-changed corpus fails closed', () => {
  assert.throws(() => parseHallucinationCorpus('{broken'), /Invalid Trend Micro corpus JSON/);
  assert.throws(() => parseHallucinationCorpus('{"modules":[]}'), /no modulenotfound array/);
});

test('a dataset match is a hard stop before registry lookup', async () => {
  let called = false;
  const result = await verifyPackage({ ecosystem: 'pypi', name: 'Litestar_Websocket' }, {
    fetchImpl: async () => { called = true; throw new Error('must not query registry for a blocked name'); },
  });
  assert.equal(called, false);
  assert.equal(result.status, 'BLOCKED_BY_DATASET');
  assert.equal(result.normalized, 'litestar-websocket');
  assert.equal(result.corpusCoverage, 'covered');
  assert.equal(result.source, CORPUS_SOURCE);
  assert.match(result.message, /DO NOT USE/);
  assert.equal(result.evidence[0].questionIndex, 76);
});

test('PyPI existence is reported as review required, not safe', async () => {
  let request;
  const result = await verifyPackage({ ecosystem: 'pypi', name: 'Real_Package' }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ info: { name: 'real-package', version: '2.4.1' } }), { status: 200 });
    },
  });
  assert.equal(request.url, 'https://pypi.org/pypi/Real_Package/json');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.method, 'GET');
  assert.equal(result.status, 'REGISTRY_EXISTS_REVIEW_REQUIRED');
  assert.equal(result.version, '2.4.1');
  assert.match(result.message, /not a safety or trust verdict/i);
});

test('registry 404 and errors never become approval', async () => {
  const missing = await verifyPackage({ ecosystem: 'pypi', name: 'missing-candidate-xyz' }, {
    fetchImpl: async () => new Response('{}', { status: 404 }),
  });
  assert.equal(missing.status, 'NOT_FOUND');
  assert.match(missing.message, /Do not add or install/);

  const outage = await verifyPackage({ ecosystem: 'pypi', name: 'candidate-outage' }, {
    fetchImpl: async () => { throw new Error('network'); },
  });
  assert.equal(outage.status, 'UNKNOWN');
  assert.match(outage.message, /failed closed/);
});

test('invalid, mismatched, and oversized registry responses fail closed', async () => {
  await assert.rejects(verifyPackage({ ecosystem: 'pypi', name: '../wrong' }, { fetchImpl: async () => { throw new Error('not called'); } }), /valid PyPI/);
  await assert.rejects(verifyPackage({ ecosystem: 'npm', name: '../wrong' }, { fetchImpl: async () => { throw new Error('not called'); } }), /valid npm/);
  await assert.rejects(verifyPackage({ ecosystem: 'other', name: 'x' }), /ecosystem must/);

  const mismatch = await verifyPackage({ ecosystem: 'pypi', name: 'candidate-mismatch' }, {
    fetchImpl: async () => new Response(JSON.stringify({ info: { name: 'different-name', version: '1' } }), { status: 200 }),
  });
  assert.equal(mismatch.status, 'UNKNOWN');

  const oversized = await verifyPackage({ ecosystem: 'npm', name: 'candidate-large' }, {
    fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1), { status: 200 }),
  });
  assert.equal(oversized.status, 'UNKNOWN');
  assert.equal(oversized.corpusCoverage, 'not-covered');
});

test('oversized PyPI metadata falls back to a bounded exact-project HEAD check', async () => {
  const methods = [];
  const result = await verifyPackage({ ecosystem: 'pypi', name: 'large-project' }, {
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      if (options.method === 'GET') {
        return new Response('x'.repeat(512 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(methods, ['GET', 'HEAD']);
  assert.equal(result.status, 'REGISTRY_EXISTS_REVIEW_REQUIRED');
  assert.equal(result.version, undefined);
  assert.match(result.message, /metadata exceeded the checker size limit/i);
});

test('oversized PyPI metadata stays unknown unless HEAD verifies the official JSON endpoint', async () => {
  const result = await verifyPackage({ ecosystem: 'pypi', name: 'unverified-large-project' }, {
    fetchImpl: async (_url, options) => options.method === 'GET'
      ? new Response('x'.repeat(512 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.match(result.message, /failed closed/);
});

test('npm is explicitly outside corpus coverage even when the registry confirms existence', async () => {
  let request;
  const result = await verifyPackage({ ecosystem: 'npm', name: '@scope/pkg' }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ name: '@scope/pkg', version: '1.2.3' }), { status: 200 });
    },
  });
  assert.equal(request.url, 'https://registry.npmjs.org/%40scope%2Fpkg/latest');
  assert.equal(request.options.redirect, 'error');
  assert.equal(result.status, 'REGISTRY_EXISTS_REVIEW_REQUIRED');
  assert.equal(result.version, '1.2.3');
  assert.equal(result.corpusCoverage, 'not-covered');
  assert.match(result.message, /does not cover npm/);
});
