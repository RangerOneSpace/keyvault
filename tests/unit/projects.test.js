// Projects: the "pick up where you left off" harness, from the browser API and
// from an AI tool through the real MCP server.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/keyvault.js', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-proj-'));
const CODE = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-code-'));
const ENV = { ...process.env, KEYVAULT_HOME: HOME, KEYVAULT_NO_BROWSER: '1', KEYVAULT_PORT: '0' };
const REPO = path.join(CODE, 'ranger-site');
const PLAIN = path.join(CODE, 'notes');
let daemon; let agent; let session = '';

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: agent.port, method, path: p,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const ui = (m, p, b) => req(m, p, { body: b, headers: { 'x-keyvault': '1', 'x-keyvault-session': session } });
const ag = (m, p, b) => req(m, p, { body: b, headers: { authorization: `Bearer ${agent.token}` } });

before(async () => {
  fs.mkdirSync(REPO); fs.mkdirSync(PLAIN);
  const g = (...a) => spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(REPO, 'README.md'), 'hi');
  g('add', '.'); g('commit', '-q', '-m', 'First page');
  fs.writeFileSync(path.join(REPO, 'wip.txt'), 'uncommitted');
  // A repo config that would run a program on `git status` must be ignored.
  g('config', 'core.fsmonitor', `node -e "require('fs').writeFileSync('${path.join(CODE, 'PWNED').replace(/\\/g, '/')}','x')"`);

  daemon = spawn(process.execPath, [BIN, 'serve', '--no-open'], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const link = await new Promise(resolve => {
    let buf = '';
    daemon.stdout.on('data', c => { buf += c; const m = /(http:\/\/127\.0\.0\.1:\d+\/open\?t=\S+)/.exec(buf); if (m) resolve(m[1]); });
  });
  agent = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'));
  const res = await fetch(link, { redirect: 'manual' });
  session = /#session=([\w-]+)$/.exec(res.headers.get('location'))[1];
  assert.equal((await ui('POST', '/api/create', { password: 'projects test password', orgs: ['Ranger One'] })).status, 200);
});

after(() => { daemon?.kill(); });

let id;
test('create, rename, update and list projects from the browser', async () => {
  const orgs = (await ui('GET', '/api/vault')).json.orgs;
  let r = await ui('POST', '/api/projects', { name: 'Ranger site', summary: 'Agency website', orgId: orgs[0].id, folders: [{ path: REPO }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  id = r.json.project.id;
  assert.equal(r.json.project.folders[0].path, REPO);

  assert.equal((await ui('POST', '/api/projects', { name: 'ranger SITE' })).status, 409, 'names are unique, ignoring case');
  assert.equal((await ui('POST', '/api/projects', { name: 'Bad', folders: [{ path: 'relative/path' }] })).status, 400, 'folders must be full paths');
  assert.equal((await ui('POST', '/api/projects', { name: 'Bad2', links: [{ url: 'javascript:alert(1)' }] })).status, 400, 'links must be http(s)');

  r = await ui('PUT', `/api/projects/${id}`, { name: 'Ranger One website', resume: 'Hero animation half done', key: 'ro' });
  assert.equal(r.status, 200);
  assert.equal(r.json.project.name, 'Ranger One website');
  assert.equal(r.json.project.key, 'RO');
  assert.match(r.json.project.log[0].text, /Renamed from "Ranger site"/);

  r = await ui('POST', `/api/projects/${id}/checklist`, { op: 'add-items', phases: [{ name: 'Foundations', code: 'found' }], items: [{ phase: 'FOUND', title: 'Finish hero' }, { phase: 'Foundations', title: 'Deploy to Pages', owner: 'human' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.project.items.map(i => i.ref), ['FOUND-001', 'FOUND-002']);
  assert.equal(r.json.project.phases[0].code, 'FOUND');

  const v = (await ui('GET', '/api/vault')).json;
  assert.equal(v.projects.length, 1);
  assert.ok(!fs.readFileSync(path.join(HOME, 'vault.json'), 'utf8').includes('Hero animation'), 'projects are encrypted in the vault file');
});

test('folder status reads git safely, and the brief has everything to resume', async () => {
  const st = (await ui('GET', `/api/projects/${id}/status`)).json.folders[0];
  assert.equal(st.exists, true);
  assert.equal(st.git.branch, 'main');
  assert.equal(st.git.changes, 1);
  assert.equal(st.git.lastCommit.subject, 'First page');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!fs.existsSync(path.join(CODE, 'PWNED')), 'core.fsmonitor from the repo must never run');

  const brief = (await ui('GET', `/api/projects/${id}/brief`)).json.brief;
  assert.match(brief, /# Ranger One website/);
  assert.match(brief, /Hero animation half done/);
  assert.match(brief, /- \[ \] RO-FOUND-001 Finish hero/);
  assert.ok(brief.includes(REPO));
  assert.match(brief, /git main, 1 uncommitted change/);

  const missing = (await ui('POST', '/api/check-folder', { path: path.join(CODE, 'nope') })).json;
  assert.equal(missing.exists, false);
});

test('find my repos lists git repos under a folder and marks tracked ones', async () => {
  const r = (await ui('POST', '/api/projects-scan', { roots: [CODE] })).json;
  const repo = r.repos.find(x => x.path === REPO);
  assert.ok(repo, 'repo found');
  assert.equal(repo.tracked, true);
  assert.ok(!r.repos.some(x => x.path === PLAIN), 'plain folders are not repos');
});

test('duplicate, archive and delete', async () => {
  const d = (await ui('POST', `/api/projects/${id}/duplicate`, {})).json.project;
  assert.equal(d.name, 'Ranger One website (copy)');
  assert.equal((await ui('PUT', `/api/projects/${d.id}`, { status: 'archived' })).json.project.status, 'archived');
  assert.equal((await ui('DELETE', `/api/projects/${d.id}`)).status, 200);
  assert.equal((await ui('GET', '/api/vault')).json.projects.length, 1);
});

test('AI tools: list, resume, log progress, update, open; never delete', async () => {
  let r = await ag('GET', '/agent/projects');
  assert.equal(r.json.projects[0].name, 'Ranger One website');
  assert.equal(r.json.projects[0].nextItem, 'RO-FOUND-001 Finish hero');
  assert.equal(r.json.projects[0].checklist, '0 of 2 done');

  r = await ag('GET', '/agent/project?ref=ranger');
  assert.match(r.json.brief, /Where I left off\nHero animation half done/);

  r = await ag('POST', '/agent/project/log', { ref: 'Ranger One website', text: 'Finished the hero animation', resume: 'Ready to deploy', client: 'Claude Code' });
  assert.equal(r.status, 200);
  r = await ag('POST', '/agent/project/update', { ref: 'ranger', complete_next: ['finish hero'], add_next: ['Check mobile'], client: 'Claude Code' });
  assert.equal(r.json.project.checklist, '1 of 3 done');
  assert.equal(r.json.project.nextItem, 'RO-FOUND-002 Deploy to Pages');

  const p = (await ui('GET', '/api/vault')).json.projects[0];
  assert.equal(p.resume, 'Ready to deploy');
  assert.equal(p.items.find(n => n.title === 'Finish hero').status, 'done');
  assert.equal(p.items.find(n => n.title === 'Finish hero').by, 'Claude Code');
  assert.equal(p.phases.find(ph => ph.code === 'NEXT').name, 'Next steps');
  assert.ok(p.log.some(e => e.source === 'Claude Code' && /hero animation/.test(e.text)));

  assert.equal((await ag('POST', '/agent/project/update', { ref: 'ranger', status: 'archived', client: 'x' })).status, 400, 'archiving needs explicit confirmation');
  assert.equal((await ag('DELETE', `/agent/projects/${id}`)).status, 404, 'no delete route for AI tools');

  r = await ag('POST', '/agent/project/open', { ref: 'ranger', how: 'folder', client: 'Claude Code' });
  assert.equal(r.status, 200);
  assert.equal(r.json.opened, false, 'KEYVAULT_NO_BROWSER stops the test opening windows');
  assert.equal(r.json.dir, REPO);
});

test('AI tools: write and keep a checklist up to date', async () => {
  let r = await ag('POST', '/agent/project/checklist', { ref: 'ranger', client: 'Claude Code',
    phases: [{ name: 'Phase 0: website and logo', code: 'WEB' }, { name: 'Phase 1', code: 'P1' }, { name: 'Phase 10', code: 'P10' }],
    items: [{ phase: 'WEB', title: 'Pick brand font', status: 'done', owner: 'human' }, { phase: 'Phase 0', title: 'Logo files', owner: 'human+claude' }, { phase: 'Phase 1', title: 'Only in phase one' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.added.map(i => i.id), ['RO-WEB-001', 'RO-WEB-002', 'RO-P1-001'], 'exact phase names win over partial ones');

  r = await ag('POST', '/agent/project/checklist/update', { ref: 'ranger', client: 'Codex', updates: [
    { item: 'RO-WEB-002', status: 'blocked', notes: 'Waiting on the SVG' },
    { item: 'web-001', status: 'superseded' },
    { item: 'logo', owner: 'claude' },
    { item: 'RO-NOPE-999', status: 'done' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.missing, ['RO-NOPE-999']);
  assert.equal(r.json.stats.blocked, 1);
  assert.equal(r.json.stats.superseded, 1);

  assert.equal((await ag('POST', '/agent/project/checklist/update', { ref: 'ranger', updates: [{ item: 'RO-WEB-002', status: 'nonsense' }] })).status, 400);

  r = await ag('GET', '/agent/project/checklist?ref=ranger&status=blocked');
  assert.equal(r.json.phases.length, 1);
  assert.equal(r.json.phases[0].items[0].notes, 'Waiting on the SVG');
  assert.equal(r.json.phases[0].items[0].owner, 'claude');

  assert.equal((await ag('POST', '/agent/project/checklist', { ref: 'ranger', replace: true, items: [] })).status, 400, 'replacing needs confirm_replace');
  assert.ok((await ui('GET', '/api/vault')).json.projects[0].items.length >= 6, 'nothing was replaced');

  const brief = (await ag('GET', '/agent/project?ref=ranger')).json.brief;
  assert.match(brief, /### WEB · Phase 0: website and logo \(0\/1 done\)/);
  assert.match(brief, /RO-WEB-002 Logo files {2}\(blocked, claude\): Waiting on the SVG/);
});

test('browser: rename, move and delete phases and items', async () => {
  const x = (await ui('GET', '/api/vault')).json.projects[0];
  const cl = body => ui('POST', `/api/projects/${x.id}/checklist`, body);
  assert.equal((await cl({ op: 'delete-phase', phase: 'WEB' })).status, 400, 'a phase with items cannot be deleted');
  let r = await cl({ op: 'rename-phase', phase: 'P10', name: 'Phase 10: launch' });
  assert.equal(r.json.project.phases.find(p => p.code === 'P10').name, 'Phase 10: launch');
  r = await cl({ op: 'delete-phase', phase: 'P10' });
  assert.ok(!r.json.project.phases.some(p => p.code === 'P10'));
  r = await cl({ op: 'move-phase', phase: 'WEB', dir: -1 });
  const order = r.json.project.phases.map(p => p.code);
  assert.ok(order.indexOf('WEB') < order.indexOf('P1'));
  r = await cl({ op: 'move-item', item: 'WEB-002', dir: -1 });
  const web = r.json.project.items.filter(i => i.ref.startsWith('WEB-')).map(i => i.ref);
  assert.deepEqual(web, ['WEB-002', 'WEB-001']);
  r = await cl({ op: 'update-items', updates: [{ item: 'WEB-002', phase: 'P1' }] });
  assert.equal(r.json.project.items.find(i => i.title === 'Logo files').ref, 'P1-002', 'moving to another phase gives a new id there');
  r = await cl({ op: 'delete-item', item: 'P1-002' });
  assert.ok(!r.json.project.items.some(i => i.title === 'Logo files'));
  assert.equal((await cl({ op: 'explode' })).status, 400);
});

test('old next-steps lists turn into checklist items', async () => {
  const { ensureChecklist, phaseCodeFrom, projectKeyFrom } = await import('../../src/checklist.js');
  const x = ensureChecklist({ name: 'Old thing', next: [{ text: 'a', done: true }, { text: 'b', done: false }] });
  assert.equal(x.next, undefined);
  assert.deepEqual(x.items.map(i => [i.ref, i.status]), [['NEXT-001', 'done'], ['NEXT-002', 'todo']]);
  assert.equal(x.key, 'OT');
  assert.equal(phaseCodeFrom('Phase 0 — website & logo'), 'WEBSI');
  assert.equal(phaseCodeFrom('Foundations'), 'FOUND');
  assert.equal(projectKeyFrom('Ranger One'), 'RO');
});

test('MCP server exposes the project tools', async () => {
  const mcp = spawn(process.execPath, [BIN, 'mcp'], { env: ENV, cwd: PLAIN, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buf = ''; let n = 0;
  mcp.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch {} }
  });
  const rpc = (method, params) => new Promise(resolve => { const idn = ++n; pending.set(idn, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: idn, method, params })}\n`); });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    for (const t of ['list_projects', 'get_project', 'create_project', 'update_project', 'log_progress', 'open_project', 'get_checklist', 'add_checklist_items', 'update_checklist_items']) assert.ok(tools.includes(t), t);
    assert.ok(!tools.some(t => /delete/.test(t)), 'no delete tool');

    const brief = (await rpc('tools/call', { name: 'get_project', arguments: { project: 'ranger' } })).result.content[0].text;
    assert.match(brief, /Ready to deploy/);
    const made = (await rpc('tools/call', { name: 'create_project', arguments: { name: 'Notes', next_steps: ['Tidy up'] } })).result.content[0].text;
    assert.match(made, /Created project "Notes" with folder .*notes/, 'defaults to the AI tool\'s working folder');
    assert.match(made, /Checklist: 0 of 1 done/);

    const added = (await rpc('tools/call', { name: 'add_checklist_items', arguments: { project: 'Notes', phases: [{ name: 'Foundations' }], items: [{ phase: 'Foundations', title: 'Set up repo', owner: 'claude' }] } })).result.content[0].text;
    assert.match(added, /NOTE-FOUND-001 Set up repo \(todo\)/);
    const upd = (await rpc('tools/call', { name: 'update_checklist_items', arguments: { project: 'Notes', updates: [{ item: 'NOTE-FOUND-001', status: 'done' }] } })).result.content[0].text;
    assert.match(upd, /NOTE-FOUND-001 Set up repo: done \(claude\)/);
    const got = (await rpc('tools/call', { name: 'get_checklist', arguments: { project: 'Notes' } })).result.content[0].text;
    assert.match(got, /1 of 2 done/);
  } finally { mcp.kill(); }
});
