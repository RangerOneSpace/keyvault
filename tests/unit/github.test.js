// GitHub search in Projects: a fake GitHub API and a local "github.com" made
// of bare repos, so the test never touches the network.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/keyvault.js', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-gh-'));
const WEB = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-ghweb-'));
const HOMEDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-ghuser-'));
const CODE = path.join(HOMEDIR, 'code');   // one of the usual code folders KeyVault looks in
fs.mkdirSync(CODE);
const TOKEN = 'fixture-github-token';
let api; let daemon; let agent; let session = ''; const seen = [];

const repo = (name, extra = {}) => ({
  full_name: `rangerone/${name}`, name, owner: { login: 'rangerone' }, description: `${name} repo`, private: name === 'secret-app',
  html_url: `https://github.com/rangerone/${name}`, clone_url: `https://github.com/rangerone/${name}.git`, stargazers_count: 3, language: 'TypeScript', pushed_at: '2026-10-01T10:00:00Z', ...extra,
});

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: agent.port, method, path: p,
      headers: { 'x-keyvault': '1', 'x-keyvault-session': session, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  // "github.com": bare repos at WEB/rangerone/<name>.git
  for (const name of ['secret-app', 'website']) {
    const work = path.join(CODE, `_src-${name}`);
    fs.mkdirSync(work);
    const g = (...a) => spawnSync('git', ['-C', work, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(work, 'README.md'), name); g('add', '.'); g('commit', '-q', '-m', 'init');
    fs.mkdirSync(path.join(WEB, 'rangerone'), { recursive: true });
    spawnSync('git', ['clone', '-q', '--bare', work, path.join(WEB, 'rangerone', `${name}.git`)]);
    fs.rmSync(work, { recursive: true, force: true });
  }
  // A local clone of "website" already under the code folder
  spawnSync('git', ['clone', '-q', path.join(WEB, 'rangerone', 'website.git'), path.join(CODE, 'website')]);
  spawnSync('git', ['-C', path.join(CODE, 'website'), 'remote', 'set-url', 'origin', 'git@github.com:RangerOne/website.git']);

  api = http.createServer((q, s) => {
    seen.push({ url: q.url, auth: q.headers.authorization || '' });
    const u = new URL(q.url, 'http://x');
    s.setHeader('content-type', 'application/json');
    if (u.pathname === '/user/repos') {
      if (q.headers.authorization !== `Bearer ${TOKEN}`) { s.statusCode = 401; return s.end('{}'); }
      return s.end(JSON.stringify(u.searchParams.get('page') === '1' ? [repo('secret-app'), repo('website')] : []));
    }
    if (u.pathname === '/search/repositories') return s.end(JSON.stringify({ items: [repo('website', { stargazers_count: 99 })] }));
    s.statusCode = 404; s.end('{}');
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));

  const env = { ...process.env, KEYVAULT_HOME: HOME, KEYVAULT_NO_BROWSER: '1', KEYVAULT_PORT: '0', HOME: HOMEDIR, USERPROFILE: HOMEDIR,
    KEYVAULT_GITHUB_API: `http://127.0.0.1:${api.address().port}`, KEYVAULT_GITHUB_WEB: pathToFileURL(WEB).href };
  daemon = spawn(process.execPath, [BIN, 'serve', '--no-open'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const link = await new Promise(resolve => { let buf = ''; daemon.stdout.on('data', c => { buf += c; const m = /(http:\/\/127\.0\.0\.1:\d+\/open\?t=\S+)/.exec(buf); if (m) resolve(m[1]); }); });
  agent = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'));
  session = /#session=([\w-]+)$/.exec((await fetch(link, { redirect: 'manual' })).headers.get('location'))[1];
  assert.equal((await req('POST', '/api/create', { password: 'github test password', orgs: ['Ranger One'] })).status, 200);
});
after(() => { daemon?.kill(); api?.close(); });

test('without a token: "my repos" explains, all of GitHub still works', async () => {
  assert.equal((await req('GET', '/api/github')).json.token, false);
  const mine = await req('POST', '/api/github/search', { scope: 'mine', q: '' });
  assert.equal(mine.status, 400);
  assert.match(mine.json.error, /GITHUB_TOKEN/);
  const all = await req('POST', '/api/github/search', { scope: 'all', q: 'website' });
  assert.equal(all.status, 200);
  assert.equal(all.json.repos[0].stars, 99);
  assert.equal(seen.at(-1).auth, '', 'no token sent when there is none');
});

test('with a token: my repos, private included, matched to local clones', async () => {
  const orgs = (await req('GET', '/api/vault')).json.orgs;
  assert.equal((await req('POST', '/api/keys', { name: 'GitHub CLI', provider: 'GitHub', type: 'Service', envVar: 'GITHUB_TOKEN', value: TOKEN, orgId: orgs[0].id })).status, 200);
  const st = (await req('GET', '/api/github')).json;
  assert.equal(st.token, true);
  assert.equal(st.tokenName, 'GitHub CLI');
  assert.ok(!JSON.stringify(st).includes(TOKEN), 'the token never goes to the browser');

  const r = await req('POST', '/api/github/search', { scope: 'mine', q: '' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!JSON.stringify(r.json).includes(TOKEN));
  const byName = Object.fromEntries(r.json.repos.map(x => [x.name, x]));
  assert.equal(byName['secret-app'].private, true);
  assert.equal(byName['secret-app'].localPath, null);
  assert.equal(byName.website.localPath, path.join(CODE, 'website'), 'found by its origin remote, any case or URL form');
  assert.equal((await req('POST', '/api/github/search', { scope: 'mine', q: 'secret' })).json.repos.length, 1);
});

test('clone a repo into a folder, then it shows as a project', async () => {
  let r = await req('POST', '/api/github/clone', { fullName: 'rangerone/secret-app', parent: CODE });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const dir = r.json.path;
  assert.equal(dir, path.join(CODE, 'secret-app'));
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  assert.ok(!fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8').includes('extraheader'), 'the token is not saved in the clone');

  assert.equal((await req('POST', '/api/github/clone', { fullName: 'rangerone/secret-app', parent: CODE })).status, 409, 'never clones over a folder');
  assert.equal((await req('POST', '/api/github/clone', { fullName: '../evil', parent: CODE })).status, 400);
  assert.equal((await req('POST', '/api/github/clone', { fullName: 'rangerone/secret-app', parent: 'relative' })).status, 400);
  assert.equal((await req('POST', '/api/github/clone', { fullName: 'rangerone/secret-app', parent: CODE, folderName: '..' })).status, 400);

  // Our stand-in "github.com" is a folder; a real clone's origin is github.com.
  spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/rangerone/secret-app.git']);
  r = await req('POST', '/api/projects', { name: 'secret-app', folders: [{ path: dir }], links: [{ label: 'GitHub', url: 'https://github.com/rangerone/secret-app' }] });
  assert.equal(r.status, 200);
  const found = (await req('POST', '/api/github/search', { scope: 'mine', q: 'secret' })).json.repos[0];
  assert.equal(found.localPath, dir);
  assert.equal(found.project.name, 'secret-app');
});
