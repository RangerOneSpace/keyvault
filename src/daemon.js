// The KeyVault daemon.
//
// One small process per user. It listens on 127.0.0.1 only and holds the
// unlocked vault in memory. Two kinds of client talk to it:
//
//   Browser UI  -> /api/*    authenticated by a one-time login link, which
//                            hands the browser a session token. The page keeps
//                            it in localStorage (scoped to this exact origin,
//                            so every KeyVault tab shares it) and sends it in a
//                            custom header (never a cookie, so other servers on
//                            localhost cannot receive it). The daemon stores
//                            only SHA-256 hashes of session tokens, on disk, so
//                            a restart does not sign the browser out. A session
//                            never unlocks the vault: that still needs the
//                            master password.
//   MCP server  -> /agent/*  authenticated by a random token in agent.json
//                            (readable only by your user account). Agent
//                            routes can never return a secret value.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kc from './crypto.js';
import { paths, ensureHome, readVaultText, writeVaultText, writeAtomic, vaultExists } from './store.js';
import { randomToken, uid, safeEqual, openBrowser, VERSION, TYPES, ENVS, STATUSES, PALETTE } from './util.js';
import { buildBindings, writeEnvFile, runWithSecrets, isEnvName, redactor } from './secrets.js';
import { connectSnippets } from './connect.js';
import * as svc from './services.js';
import * as proj from './projects.js';
import * as cl from './checklist.js';
import * as ghub from './github.js';

import EMBEDDED_UI from './ui-embedded.js';

const uiDir = () => fileURLToPath(new URL('../ui/', import.meta.url));
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
// The Ranger One brand fonts, served from here so the page makes no outside requests.
for (const f of ['inter-400', 'inter-700', 'inter-800', 'inter-900', 'jetbrains-mono-400', 'jetbrains-mono-700']) {
  ASSETS[`/fonts/${f}.woff2`] = [`fonts/${f}.woff2`, 'font/woff2'];
}
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const MIN_PASSWORD = 10;
// A fixed port, so a bookmark or an open tab keeps working after KeyVault restarts.
// If something else already uses it, KeyVault picks a free one instead.
export const DEFAULT_PORT = 47821;
// Tests shrink a "minute" so lock timing can be checked in seconds.
const MINUTE = Number(process.env.KEYVAULT_TEST_MINUTE_MS) || 60_000;
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60, 120, 240, 480, 720, 1440];
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;   // browser sign-in, not vault unlock
const MAX_SESSIONS = 50;
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('base64url');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  if (res.headersSent) return;
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, ...extraHeaders });
  res.end(payload);
}

function isoDate() { return new Date().toISOString().slice(0, 10); }

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
}

export async function startDaemon({ open = true, logFile } = {}) {
  ensureHome();
  const p = paths();
  const log = (...a) => {
    const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
    if (logFile) { try { fs.appendFileSync(logFile, line); } catch {} } else process.stderr.write(line);
  };

  const agentToken = randomToken();
  // sha256(token) -> last used (ms). Persisted so restarts keep browsers signed in.
  const sessions = new Map();
  let sessionsSavedAt = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(p.sessions, 'utf8'));
    const now = Date.now();
    for (const [h, used] of Object.entries(saved?.sessions || {})) {
      if (typeof h === 'string' && typeof used === 'number' && now - used < SESSION_IDLE_MS) sessions.set(h, used);
    }
  } catch {}
  function saveSessions(force = false) {
    if (!force && Date.now() - sessionsSavedAt < 10 * 60_000) return;
    sessionsSavedAt = Date.now();
    try { writeAtomic(p.sessions, JSON.stringify({ sessions: Object.fromEntries(sessions) })); } catch (e) { log('could not save sessions:', e.message); }
  }
  const loginTokens = new Map();
  // pass: an agent pass keeps the vault open for AI tools until a set time, while
  // the page itself still locks after the usual inactivity (uiLocked).
  const S = { key: null, salt: null, iter: 0, vault: null, lastActive: 0, failures: 0, blockedUntil: 0, uiLocked: false, pass: null };
  let port = 0;

  // ---------- vault state ----------
  function normalise(v) {
    const out = v && typeof v === 'object' ? v : {};
    out.orgs = Array.isArray(out.orgs) ? out.orgs.filter(o => o && o.id && o.name) : [];
    out.keys = Array.isArray(out.keys) ? out.keys.filter(k => k && k.id && typeof k.value === 'string') : [];
    out.settings = { autoLockMin: 30, lastBackup: 0, ...(out.settings || {}) };
    out.projects = Array.isArray(out.projects) ? out.projects.filter(x => x && x.id && x.name) : [];
    for (const x of out.projects) cl.ensureChecklist(x);   // also turns old next-steps lists into checklist items
    out.audit = Array.isArray(out.audit) ? out.audit : [];
    if (!out.orgs.length) out.orgs.push({ id: uid(), name: 'General', color: PALETTE[0] });
    return out;
  }
  const state = () => (S.vault ? 'unlocked' : vaultExists() ? 'locked' : 'none');
  // What the browser sees: locked while an agent pass keeps the vault open behind it.
  const uiState = () => (S.vault && !S.uiLocked ? 'unlocked' : vaultExists() ? 'locked' : 'none');
  function save() { writeVaultText(kc.seal(S.key, S.salt, S.iter, S.vault)); }
  function lock(reason = 'manual') {
    if (S.pass && S.vault) endPass(`vault locked (${reason})`);
    if (S.key) S.key.fill(0);
    const was = !!S.vault;
    S.key = null; S.salt = null; S.iter = 0; S.vault = null; S.uiLocked = false; S.pass = null;
    if (was) log('locked', reason);
  }
  function requireUnlocked() { if (!S.vault) throw new HttpError(423, 'KeyVault is locked', { state: state() }); }
  function requireUiUnlocked() { if (!S.vault || S.uiLocked) throw new HttpError(423, 'KeyVault is locked', { state: uiState() }); }

  // ---------- agent pass ----------
  const PASS_MAX_MS = 24 * 60 * MINUTE;
  function passInfo() {
    if (!S.pass) return null;
    const x = S.pass.projectId ? S.vault?.projects.find(q => q.id === S.pass.projectId) : null;
    return { until: S.pass.until, started: S.pass.started, project: x ? { id: x.id, name: x.name, keys: (x.keyIds || []).length } : null };
  }
  function endPass(why) {
    if (!S.pass) return;
    const info = passInfo();
    S.pass = null;
    if (S.vault) {
      audit({ source: 'you', action: 'agent-pass-ended', target: why });
      try { save(); } catch {}
    }
    log('agent pass ended:', why, info?.project ? `(${info.project.name})` : '');
  }
  // While a pass is limited to one project, AI tools only see that project and its linked keys.
  function passProject() { return S.pass?.projectId ? S.vault.projects.find(q => q.id === S.pass.projectId) || null : null; }
  function agentKeys() {
    const x = passProject();
    if (!S.pass?.projectId) return S.vault.keys;
    return x ? S.vault.keys.filter(k => (x.keyIds || []).includes(k.id)) : [];
  }
  function agentProjects() {
    if (!S.pass?.projectId) return S.vault.projects;
    const x = passProject();
    return x ? [x] : [];
  }
  function audit(entry) {
    const cap = (v, n) => (v == null ? undefined : String(v).slice(0, n));
    S.vault.audit.unshift({
      at: Date.now(),
      source: cap(entry.source, 60), action: cap(entry.action, 40),
      keys: Array.isArray(entry.keys) ? entry.keys.slice(0, 20).map(k => cap(k, 120)) : undefined,
      target: cap(entry.target, 300), cwd: cap(entry.cwd, 300),
    });
    if (S.vault.audit.length > 500) S.vault.audit.length = 500;
  }
  const orgName = id => S.vault.orgs.find(o => o.id === id)?.name || 'Unassigned';
  function uiKey(k) { const { value, ...rest } = k; return { ...rest, length: value.length }; }
  function agentKey(k) {
    return {
      id: k.id, name: k.name, organisation: orgName(k.orgId), provider: k.provider, type: k.type,
      environment: k.env, status: k.status, envVar: k.envVar || null, expires: k.expires || null,
      notes: k.notes || '', updated: new Date(k.updated || k.created || 0).toISOString().slice(0, 10),
    };
  }

  function str(v, max, field, required) {
    if (v == null) v = '';
    if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
    v = v.trim();
    if (required && !v) throw new HttpError(400, `${field} is required`);
    if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
    return v;
  }
  function cleanKey(body, existing) {
    const out = {
      name: str(body.name, 120, 'Name', true),
      orgId: str(body.orgId, 64, 'Organisation', true),
      provider: str(body.provider, 80, 'Provider', true),
      type: TYPES.includes(body.type) ? body.type : 'Other',
      env: ENVS.includes(body.env) ? body.env : 'Production',
      status: STATUSES.includes(body.status) ? body.status : 'active',
      envVar: str(body.envVar, 80, 'Env var name', false),
      expires: str(body.expires, 10, 'Expiry date', false),
      notes: str(body.notes, 4000, 'Notes', false),
    };
    if (!S.vault.orgs.some(o => o.id === out.orgId)) throw new HttpError(400, 'Unknown organisation');
    if (out.envVar && !isEnvName(out.envVar)) throw new HttpError(400, 'Env var name can only use letters, numbers and underscores, and cannot start with a number');
    if (out.expires && !/^\d{4}-\d{2}-\d{2}$/.test(out.expires)) throw new HttpError(400, 'Expiry date must be YYYY-MM-DD');
    let value = body.value;
    if (value == null || value === '') {
      if (!existing) throw new HttpError(400, 'Key value is required');
      value = existing.value;
    }
    if (typeof value !== 'string') throw new HttpError(400, 'Key value must be text');
    value = value.trim();
    if (!value) throw new HttpError(400, 'Key value is required');
    if (value.length > 16384) throw new HttpError(400, 'Key value is too long');
    out.value = value;
    return out;
  }

  // ---------- auth helpers ----------
  const hostOk = req => {
    const h = req.headers.host;
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };
  const originOk = req => {
    const o = req.headers.origin;
    return !o || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  };
  function headerSession(req) {
    const got = req.headers['x-keyvault-session'];
    if (typeof got !== 'string' || !got) return false;
    const now = Date.now();
    const want = hashToken(got);
    let ok = false;
    for (const [h, used] of sessions) {
      if (now - used > SESSION_IDLE_MS) { sessions.delete(h); continue; }
      if (!ok && safeEqual(h, want)) { sessions.set(h, now); ok = true; }
    }
    if (ok) saveSessions();
    return ok;
  }
  function makeLoginUrl() {
    const now = Date.now();
    for (const [t, exp] of loginTokens) if (exp < now) loginTokens.delete(t);
    const t = randomToken();
    loginTokens.set(t, now + 2 * 60 * 1000);
    return `http://127.0.0.1:${port}/open?t=${t}`;
  }

  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }

  // ---------- routes ----------
  async function handleOpen(req, res, url) {
    const t = url.searchParams.get('t') || '';
    let ok = false;
    for (const [tok, exp] of loginTokens) {
      if (safeEqual(tok, t) && exp > Date.now()) { loginTokens.delete(tok); ok = true; break; }
    }
    let location = '/';
    if (ok) {
      const s = randomToken();
      sessions.set(hashToken(s), Date.now());
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      saveSessions(true);
      // The fragment never reaches a server or a log; the page moves it into
      // localStorage and removes it from the address bar straight away.
      location = `/#session=${s}`;
    }
    res.writeHead(302, { Location: location }); res.end();
  }

  async function handleApi(req, res, pathname, url) {
    if (!originOk(req) || req.headers['x-keyvault'] !== '1') throw new HttpError(403, 'Forbidden');
    if (!headerSession(req)) throw new HttpError(401, 'Session expired');
    const m = req.method;
    // Background polling (status, services refresh) must not keep the vault unlocked.
    const passive = m === 'GET' && (pathname === '/api/status' || pathname === '/api/services');
    if (!passive) S.lastActive = Date.now();
    const body = ['POST', 'PUT', 'DELETE'].includes(m)
      ? await readBody(req, pathname === '/api/restore' ? 25 * 1024 * 1024 : 1024 * 1024) : {};
    let mt;

    if (m === 'GET' && pathname === '/api/status') {
      return send(res, 200, {
        state: uiState(), version: VERSION, vaultPath: p.vault, pass: uiState() === 'unlocked' ? passInfo() : (S.pass ? { until: S.pass.until } : null),
        autoLockMin: S.vault?.settings.autoLockMin ?? null,
        blockedFor: Math.max(0, Math.ceil((S.blockedUntil - Date.now()) / 1000)),
      });
    }
    if (m === 'POST' && pathname === '/api/touch') return send(res, 200, { ok: true });

    if (m === 'POST' && pathname === '/api/create') {
      if (vaultExists()) throw new HttpError(409, 'A vault already exists. Unlock it instead.');
      const pw = typeof body.password === 'string' ? body.password : '';
      if (pw.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters. A short phrase works well.`);
      const names = Array.isArray(body.orgs) ? body.orgs : [];
      const seen = new Set();
      const orgs = [];
      for (const n of names) {
        const name = typeof n === 'string' ? n.trim().slice(0, 60) : '';
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        orgs.push({ id: uid(), name, color: PALETTE[orgs.length % PALETTE.length] });
      }
      S.salt = kc.newSalt(); S.iter = kc.KDF_ITER;
      S.key = await kc.deriveKey(pw, S.salt, S.iter);
      S.vault = normalise({ orgs, keys: [], created: Date.now() });
      save();
      log('vault created');
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && pathname === '/api/unlock') {
      if (S.vault && !S.uiLocked) return send(res, 200, { ok: true });
      const wait = Math.ceil((S.blockedUntil - Date.now()) / 1000);
      if (wait > 0) throw new HttpError(429, `Too many attempts. Try again in ${wait} seconds.`, { retryAfter: wait });
      const text = readVaultText();
      if (!text) throw new HttpError(404, 'No vault found');
      const env = kc.parseEnvelope(text);
      if (!env) throw new HttpError(500, 'The vault file is not readable. Restore a backup.');
      const pw = typeof body.password === 'string' ? body.password : '';
      let r;
      try { r = await kc.openEnvelope(env, pw); }
      catch (e) {
        if (e instanceof kc.WrongPasswordError || e.message === 'Password required') {
          S.failures++;
          if (S.failures >= 5) S.blockedUntil = Date.now() + Math.min(30_000 * 2 ** (S.failures - 5), 15 * 60_000);
          throw new HttpError(403, 'Incorrect password', { code: 'wrong-password' });
        }
        throw e;
      }
      S.failures = 0; S.blockedUntil = 0;
      if (S.vault && S.uiLocked) {
        // An agent pass kept the vault open: the password only reopens the page.
        // The vault in memory stays the one in use (it may have newer changes).
        r.key.fill(0);
        S.uiLocked = false; S.lastActive = Date.now();
        log('page unlocked (agent pass running)');
        return send(res, 200, { ok: true });
      }
      S.key = r.key; S.salt = r.salt; S.iter = r.iter; S.vault = normalise(r.data);
      if (S.iter < kc.KDF_ITER) {   // silently upgrade older vaults
        S.key.fill(0);
        S.salt = kc.newSalt(); S.iter = kc.KDF_ITER;
        S.key = await kc.deriveKey(pw, S.salt, S.iter);
        save();
      }
      S.lastActive = Date.now();
      log('unlocked');
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && pathname === '/api/restore') {
      const env = kc.parseEnvelope(typeof body.text === 'string' ? body.text : '');
      if (!env) throw new HttpError(400, 'That file is not a KeyVault backup.');
      lock('restore');
      if (vaultExists()) {
        fs.copyFileSync(p.vault, path.join(p.home, `vault.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
      }
      writeVaultText(body.text);
      log('backup restored');
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && pathname === '/api/lock') { lock('manual'); return send(res, 200, { ok: true }); }
    // Ending a pass only ever closes things, so it works from the lock screen too.
    if (m === 'DELETE' && pathname === '/api/agent-pass') {
      if (S.pass) endPass('ended by you');
      if (S.uiLocked) lock('agent pass ended');
      return send(res, 200, { ok: true, state: uiState() });
    }

    if (m === 'POST' && pathname === '/api/shutdown') {
      send(res, 200, { ok: true });
      setTimeout(() => shutdown('stopped from the browser'), 50);
      return;
    }

    // Everything below needs an unlocked vault, and the page itself unlocked.
    requireUiUnlocked();
    const V = S.vault;

    if (m === 'POST' && pathname === '/api/agent-pass') {
      const until = Number(body.until);
      const now = Date.now();
      if (!Number.isFinite(until) || until < now + 5 * MINUTE) throw new HttpError(400, 'Choose a time at least 5 minutes from now.');
      if (until > now + PASS_MAX_MS) throw new HttpError(400, 'An agent pass can last up to 24 hours.');
      let projectId = null;
      if (body.projectId) projectId = findProject(String(body.projectId)).id;
      const replacing = !!S.pass;
      S.pass = { until, started: now, projectId };
      const info = passInfo();
      audit({ source: 'you', action: 'agent-pass', target: `until ${new Date(until).toISOString()}${info.project ? `, only ${info.project.name}` : ', everything'}` });
      save();
      log(`agent pass ${replacing ? 'changed' : 'started'} until`, new Date(until).toISOString(), info.project ? `(${info.project.name})` : '(everything)');
      return send(res, 200, { pass: info });
    }
    if (m === 'GET' && pathname === '/api/agent-pass') return send(res, 200, { pass: passInfo() });

    // Start at sign-in. Browser only, never for AI tools.
    if (pathname === '/api/autostart' && (m === 'GET' || m === 'PUT')) {
      const as = await import('./autostart.js');
      if (m === 'GET') return send(res, 200, await as.status());
      let st;
      try { st = body.enabled ? await as.enable() : await as.disable(); }
      catch (e) { throw new HttpError(400, e.message); }
      audit({ source: 'you', action: body.enabled ? 'autostart-on' : 'autostart-off', target: 'sign-in' });
      log(`start at sign-in ${body.enabled ? 'on' : 'off'}`);
      save();
      return send(res, 200, st);
    }

    if (m === 'GET' && pathname === '/api/vault') {
      return send(res, 200, {
        orgs: V.orgs, keys: V.keys.map(uiKey), settings: V.settings, projects: V.projects,
        audit: V.audit.slice(0, 200), vaultPath: p.vault,
      });
    }
    if (m === 'GET' && (mt = pathname.match(/^\/api\/keys\/([a-f0-9]+)\/secret$/))) {
      const k = V.keys.find(x => x.id === mt[1]);
      if (!k) throw new HttpError(404, 'Key not found');
      return send(res, 200, { value: k.value });
    }
    if (m === 'POST' && pathname === '/api/keys') {
      const data = cleanKey(body);
      const dup = V.keys.find(k => k.value === data.value);
      if (dup && !body.force) throw new HttpError(409, `This exact key is already saved as "${dup.name}".`, { code: 'duplicate', name: dup.name });
      const now = Date.now();
      const key = { id: uid(), ...data, created: now, updated: now };
      V.keys.push(key); save();
      return send(res, 200, { key: uiKey(key) });
    }
    if ((m === 'PUT' || m === 'DELETE') && (mt = pathname.match(/^\/api\/keys\/([a-f0-9]+)$/))) {
      const i = V.keys.findIndex(x => x.id === mt[1]);
      if (i < 0) throw new HttpError(404, 'Key not found');
      if (m === 'DELETE') { V.keys.splice(i, 1); save(); return send(res, 200, { ok: true }); }
      const prev = V.keys[i];
      const data = cleanKey(body, prev);
      const dup = V.keys.find(k => k.value === data.value && k.id !== prev.id);
      if (dup && !body.force) throw new HttpError(409, `This exact key is already saved as "${dup.name}".`, { code: 'duplicate', name: dup.name });
      V.keys[i] = { ...prev, ...data, updated: Date.now(), ...(data.value !== prev.value ? { valueChanged: Date.now() } : {}) };
      save();
      return send(res, 200, { key: uiKey(V.keys[i]) });
    }

    if (m === 'POST' && pathname === '/api/orgs') {
      const name = str(body.name, 60, 'Name', true);
      if (V.orgs.some(o => o.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'That organisation already exists.');
      const org = { id: uid(), name, color: PALETTE[V.orgs.length % PALETTE.length] };
      V.orgs.push(org); save();
      return send(res, 200, { org });
    }
    if ((m === 'PUT' || m === 'DELETE') && (mt = pathname.match(/^\/api\/orgs\/([a-f0-9]+)$/))) {
      const org = V.orgs.find(o => o.id === mt[1]);
      if (!org) throw new HttpError(404, 'Organisation not found');
      if (m === 'DELETE') {
        if (V.keys.some(k => k.orgId === org.id)) throw new HttpError(409, 'Move or delete this organisation\'s keys first.');
        if (V.orgs.length === 1) throw new HttpError(409, 'You need at least one organisation.');
        V.orgs = V.orgs.filter(o => o !== org); save();
        return send(res, 200, { ok: true });
      }
      if (body.name != null) {
        const name = str(body.name, 60, 'Name', true);
        if (V.orgs.some(o => o !== org && o.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'That organisation already exists.');
        org.name = name;
      }
      if (body.color != null) {
        if (!/^#[0-9a-fA-F]{6}$/.test(body.color)) throw new HttpError(400, 'Colour must be a hex value like #3a7fd4');
        org.color = body.color;
      }
      save();
      return send(res, 200, { org });
    }

    if (m === 'PUT' && pathname === '/api/settings') {
      const n = Number(body.autoLockMin);
      if (!AUTO_LOCK_CHOICES.includes(n)) throw new HttpError(400, 'Unsupported auto-lock time');
      V.settings.autoLockMin = n; save();
      return send(res, 200, { settings: V.settings });
    }

    if (m === 'POST' && pathname === '/api/sessions/revoke') {
      // Sign out every browser except this one.
      const mine = hashToken(req.headers['x-keyvault-session']);
      for (const h of [...sessions.keys()]) if (h !== mine) sessions.delete(h);
      saveSessions(true);
      audit({ source: 'you', action: 'signed-out-other-browsers' });
      save();
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && pathname === '/api/password') {
      const cur = typeof body.current === 'string' ? body.current : '';
      const next = typeof body.next === 'string' ? body.next : '';
      if (!cur) throw new HttpError(400, 'Enter your current password');
      const check = await kc.deriveKey(cur, S.salt, S.iter);
      const same = check.length === S.key.length && safeEqual(check.toString('base64'), S.key.toString('base64'));
      check.fill(0);
      if (!same) throw new HttpError(403, 'Current password is incorrect', { code: 'wrong-password' });
      if (next.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters.`);
      const salt = kc.newSalt();
      const key = await kc.deriveKey(next, salt, kc.KDF_ITER);
      S.key.fill(0);
      S.key = key; S.salt = salt; S.iter = kc.KDF_ITER;
      audit({ source: 'you', action: 'password-changed' });
      save();
      log('master password changed');
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && pathname === '/api/backup') {
      V.settings.lastBackup = Date.now();
      save();
      return send(res, 200, readVaultText(), 'application/json; charset=utf-8', {
        'Content-Disposition': `attachment; filename="keyvault-backup-${isoDate()}.json"`,
      });
    }

    if (m === 'GET' && pathname === '/api/export.csv') {
      const rows = [['Name', 'Organisation', 'Provider', 'Type', 'Environment', 'Status', 'Env var', 'Expires', 'Notes', 'Added', 'Updated']];
      for (const k of V.keys) {
        rows.push([k.name, orgName(k.orgId), k.provider, k.type, k.env, k.status, k.envVar || '', k.expires || '', k.notes || '',
          new Date(k.created).toISOString().slice(0, 10), new Date(k.updated || k.created).toISOString().slice(0, 10)]);
      }
      const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      return send(res, 200, csv, 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="keyvault-inventory-${isoDate()}.csv"`,
      });
    }

    if (m === 'GET' && pathname === '/api/connect') {
      return send(res, 200, { clients: connectSnippets(), vaultPath: p.vault });
    }

    // ----- Projects -----
    if (m === 'POST' && pathname === '/api/projects') {
      const x = newProject(body, 'you');
      save();
      return send(res, 200, { project: x });
    }
    if ((m === 'PUT' || m === 'DELETE') && (mt = pathname.match(/^\/api\/projects\/([a-f0-9]+)$/))) {
      const x = findProject(mt[1]);
      if (m === 'DELETE') {
        V.projects = V.projects.filter(q => q !== x);
        audit({ source: 'you', action: 'project-deleted', target: x.name });
        save();
        return send(res, 200, { ok: true });
      }
      const oldName = x.name; const oldStatus = x.status;
      applyProject(x, body, 'you');
      if (x.name !== oldName) x.log.unshift({ at: Date.now(), source: 'you', text: `Renamed from "${oldName}"` });
      if (x.status !== oldStatus) x.log.unshift({ at: Date.now(), source: 'you', text: `Status changed to ${x.status}` });
      save();
      return send(res, 200, { project: x });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/checklist$/))) {
      const x = findProject(mt[1]);
      cl.ensureChecklist(x);
      const op = String(body.op || '');
      checklistDo(() => {
        if (op === 'add-phase') cl.ensurePhase(x, { name: body.name, code: body.code });
        else if (op === 'rename-phase') cl.renamePhase(x, body.phase, body.name);
        else if (op === 'delete-phase') cl.deletePhase(x, body.phase);
        else if (op === 'move-phase') cl.movePhase(x, body.phase, Number(body.dir));
        else if (op === 'add-items') cl.addItems(x, { phases: body.phases || [], items: body.items || [] }, 'you');
        else if (op === 'update-items') { const r = cl.updateItems(x, body.updates || [], 'you'); if (r.missing.length) throw new cl.ChecklistError(`Not found: ${r.missing.join(', ')}`); }
        else if (op === 'delete-item') cl.deleteItem(x, body.item);
        else if (op === 'move-item') cl.moveItem(x, body.item, Number(body.dir));
        else throw new cl.ChecklistError('Unknown checklist action');
      });
      x.updated = Date.now();
      save();
      return send(res, 200, { project: x });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/duplicate$/))) {
      const src = findProject(mt[1]);
      let name = `${src.name} (copy)`; let i = 2;
      while (V.projects.some(q => q.name.toLowerCase() === name.toLowerCase())) name = `${src.name} (copy ${i++})`;
      const x = newProject({ name, summary: src.summary, status: 'active', orgId: src.orgId, folders: src.folders, links: src.links, keyIds: src.keyIds }, 'you');
      // Same phases and items as a fresh template: everything back to "to do", superseded items left out.
      for (const ph of src.phases || []) cl.ensurePhase(x, { name: ph.name, code: ph.code });
      const keep = (src.items || []).filter(i => i.status !== 'superseded');
      checklistDo(() => cl.addItems(x, { items: keep.filter(i => !i.parentId).map(i => ({ phase: (src.phases.find(p => p.id === i.phaseId) || {}).code, title: i.title, owner: i.owner, notes: i.notes, subtasks: keep.filter(c => c.parentId === i.id).map(c => ({ title: c.title, owner: c.owner, notes: c.notes })) })) }, 'you'));
      save();
      return send(res, 200, { project: x });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/log$/))) {
      const x = findProject(mt[1]);
      logProject(x, body.text, 'you', body.resume);
      save();
      return send(res, 200, { project: x });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/open$/))) {
      const x = findProject(mt[1]);
      const f = x.folders?.[Number(body.folder) || 0];
      if (!f) throw new HttpError(400, 'This project has no folder linked yet. Add one first.');
      let r;
      try { r = await proj.openFolder(f.path, body.how || 'folder'); }
      catch (e) { throw new HttpError(400, e.message); }
      requireUnlocked();   // it may have locked while the folder was opening
      x.lastOpened = Date.now();
      save();
      return send(res, 200, r);
    }
    if (m === 'GET' && (mt = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/status$/))) {
      const x = findProject(mt[1]);
      return send(res, 200, { folders: await Promise.all((x.folders || []).map(async f => ({ ...(await proj.folderStatus(f.path)), label: f.label }))) });
    }
    if (m === 'GET' && (mt = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/brief$/))) {
      return send(res, 200, { brief: await briefOf(findProject(mt[1])) });
    }
    if (m === 'GET' && pathname === '/api/projects-status') {
      const out = {};
      await Promise.all(V.projects.filter(x => x.status !== 'archived' && x.folders?.length).map(async x => { out[x.id] = await proj.folderStatus(x.folders[0].path); }));
      return send(res, 200, { status: out });
    }
    if (m === 'GET' && pathname === '/api/projects-tools') {
      return send(res, 200, { openers: proj.availableOpeners(), picker: process.platform === 'win32', roots: proj.defaultScanRoots() });
    }
    if (m === 'POST' && pathname === '/api/projects-scan') {
      const roots = Array.isArray(body.roots) && body.roots.length ? body.roots.map(r => proj.checkFolder(r)).filter(c => c.ok).map(c => c.path) : proj.defaultScanRoots();
      const tracked = new Set(V.projects.flatMap(q => (q.folders || []).map(f => f.path.toLowerCase())));
      return send(res, 200, { roots, repos: proj.scanForRepos(roots).map(r => ({ ...r, tracked: tracked.has(r.path.toLowerCase()) })) });
    }
    // ----- GitHub search (only when you search; the token never leaves for anywhere but GitHub)
    if (m === 'GET' && pathname === '/api/github') {
      const t = ghub.findToken(V.keys);
      return send(res, 200, { token: !!t, tokenName: t?.name || null, roots: proj.defaultScanRoots() });
    }
    if (m === 'POST' && pathname === '/api/github/search') {
      const t = ghub.findToken(V.keys);
      const scope = body.scope === 'all' ? 'all' : 'mine';
      let repos;
      try { repos = await ghub.search({ q: body.q, scope, token: t?.value }); }
      catch (e) { if (e instanceof ghub.GitHubError) throw new HttpError(e.status, e.message); throw e; }
      requireUnlocked();
      const local = ghub.localClones();
      const byRepo = new Map();
      for (const x of S.vault.projects) {
        for (const l of x.links || []) { const r = ghub.repoFromRemote(l.url); if (r && !byRepo.has(r)) byRepo.set(r, x); }
      }
      const byFolder = new Map(S.vault.projects.flatMap(x => (x.folders || []).map(f => [f.path.toLowerCase(), x])));
      return send(res, 200, {
        authed: !!t, scope,
        repos: repos.slice(0, 200).map(r => {
          const key = r.fullName.toLowerCase();
          const localPath = local.get(key) || null;
          const pr = byRepo.get(key) || (localPath && byFolder.get(localPath.toLowerCase())) || null;
          return { ...r, localPath, project: pr ? { id: pr.id, name: pr.name } : null };
        }),
      });
    }
    if (m === 'POST' && pathname === '/api/github/clone') {
      const t = ghub.findToken(V.keys);
      let dir;
      try { dir = await ghub.clone({ fullName: body.fullName, parent: body.parent, folderName: body.folderName, token: t?.value }); }
      catch (e) { if (e instanceof ghub.GitHubError) throw new HttpError(e.status, e.message); throw e; }
      requireUnlocked();
      audit({ source: 'you', action: 'github-clone', target: `${body.fullName} -> ${dir}` });
      save();
      return send(res, 200, { path: dir });
    }
    if (m === 'POST' && pathname === '/api/pick-folder') {
      try { return send(res, 200, { path: await proj.pickFolder(typeof body.start === 'string' ? body.start : '') }); }
      catch (e) { throw new HttpError(400, e.message); }
    }
    if (m === 'POST' && pathname === '/api/check-folder') {
      const c = proj.checkFolder(body.path);
      return send(res, 200, c.ok ? await proj.folderStatus(c.path) : { exists: false, path: c.path || body.path, error: c.error });
    }

    // ----- Services (Docker + localhost ports) -----
    if (pathname.startsWith('/api/services')) return handleServicesUi(req, res, pathname, url, body);

    if (m === 'POST' && pathname === '/api/delete-vault') {
      if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
      const moved = path.join(p.home, `vault.deleted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      lock('vault deleted');
      fs.renameSync(p.vault, moved);
      log('vault moved aside to', moved);
      return send(res, 200, { ok: true, movedTo: moved });
    }

    throw new HttpError(404, 'Not found');
  }

  // ---------- projects ----------
  // Shared by the browser UI and AI tools. AI tools can create and update
  // projects and log progress, but never delete one.
  function findProject(id) {
    const x = S.vault.projects.find(q => q.id === id);
    if (!x) throw new HttpError(404, 'Project not found');
    return x;
  }
  function projectByRef(ref) {
    const r = String(ref || '').trim();
    const V = S.vault;
    const x = V.projects.find(q => q.id === r)
      || V.projects.find(q => q.name.toLowerCase() === r.toLowerCase())
      || (r ? V.projects.filter(q => q.name.toLowerCase().includes(r.toLowerCase())) : []).sort((a, b) => (b.lastWorked || 0) - (a.lastWorked || 0))[0];
    if (!x) throw new HttpError(404, `No project matches "${r}". Call list_projects to see them.`);
    return x;
  }
  // For AI tools: the same, but within what an agent pass allows.
  function agentProjectByRef(ref) {
    const x = projectByRef(ref);
    if (S.pass?.projectId && x.id !== S.pass.projectId) throw new HttpError(403, `The agent pass only covers ${passProject()?.name || 'one project'}.`);
    return x;
  }
  const cleanText = (v, max, field) => str(v, max, field, false);
  function cleanFolders(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'folders must be a list');
    if (list.length > 20) throw new HttpError(400, 'At most 20 folders per project');
    return list.map(f => {
      const raw = typeof f === 'string' ? f : f?.path;
      const chk = proj.checkFolder(raw);
      // A folder that is missing right now (unplugged drive) is kept, but it has to be a full path.
      if (!chk.ok && !chk.missing) throw new HttpError(400, `${chk.error}: ${String(raw || '').slice(0, 200)}`);
      return { path: chk.path, label: cleanText(f?.label, 60, 'Folder label') };
    });
  }
  function cleanLinks(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'links must be a list');
    return list.slice(0, 30).map(l => {
      const url = str(l?.url ?? l, 500, 'Link', true);
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, `Links must start with http:// or https:// (${url.slice(0, 80)})`);
      return { url, label: cleanText(l?.label, 60, 'Link label') };
    });
  }
  // Apply a partial update. Only fields that are present change.
  function applyProject(x, b, who) {
    if (b.name != null) {
      const name = str(b.name, 120, 'Name', true);
      if (S.vault.projects.some(q => q !== x && q.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `There is already a project called "${name}".`);
      x.name = name;
    }
    if (b.summary != null) x.summary = cleanText(b.summary, 4000, 'Summary');
    if (b.resume != null) x.resume = cleanText(b.resume, 8000, 'Where I left off');
    if (b.status != null) {
      if (!proj.PROJECT_STATUSES.includes(b.status)) throw new HttpError(400, `Status must be one of: ${proj.PROJECT_STATUSES.join(', ')}`);
      x.status = b.status;
    }
    if (b.orgId !== undefined) {
      if (b.orgId && !S.vault.orgs.some(o => o.id === b.orgId)) throw new HttpError(400, 'Unknown organisation');
      x.orgId = b.orgId || null;
    }
    if (b.folders != null) x.folders = cleanFolders(b.folders);
    if (b.links != null) x.links = cleanLinks(b.links);
    if (b.key != null) {
      const k = String(b.key).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (!k) throw new HttpError(400, 'Project code needs at least one letter or number');
      x.key = k;
    }
    if (b.keyIds != null) {
      if (!Array.isArray(b.keyIds)) throw new HttpError(400, 'keyIds must be a list');
      x.keyIds = [...new Set(b.keyIds)].filter(id => S.vault.keys.some(k => k.id === id));
    }
    if (b.composeProject !== undefined) {
      const cp = cleanText(b.composeProject, 128, 'Compose project');
      if (cp && !svc.PROJECT_NAME.test(cp)) throw new HttpError(400, 'Invalid compose project name');
      x.composeProject = cp || null;
    }
    if (b.pinned != null) x.pinned = !!b.pinned;
    x.updated = Date.now();
    if (who !== 'you' || b.resume != null) x.lastWorked = Date.now();
  }
  function newProject(b, who) {
    const now = Date.now();
    const x = { id: uid(), name: '', summary: '', resume: '', status: 'active', orgId: null, folders: [], links: [], phases: [], items: [], keyIds: [], composeProject: null, log: [], pinned: false, created: now, updated: now, lastWorked: null };
    applyProject(x, { status: 'active', ...b, name: b.name ?? '' }, who);
    x.key = b.key ? x.key : cl.projectKeyFrom(x.name);
    if (b.phases || b.items) checklistDo(() => cl.addItems(x, { phases: b.phases || [], items: b.items || [] }, who));
    x.log.unshift({ at: now, source: who, text: 'Project created' });
    S.vault.projects.push(x);
    return x;
  }
  // Run a checklist change, turning its errors into HTTP 400s.
  function checklistDo(fn) {
    try { return fn(); }
    catch (e) { if (e instanceof cl.ChecklistError) throw new HttpError(400, e.message); throw e; }
  }
  function logProject(x, text, who, resume) {
    const t = str(text, 2000, 'Log entry', true);
    x.log.unshift({ at: Date.now(), source: who, text: t });
    if (x.log.length > 300) x.log.length = 300;
    if (resume != null) x.resume = cleanText(resume, 8000, 'Where I left off');
    x.lastWorked = x.updated = Date.now();
  }
  const projectKeys = x => S.vault.keys.filter(k => (x.keyIds || []).includes(k.id)).map(k => ({ name: k.name, envVar: k.envVar || null }));
  const briefOf = (x, withStatus = true) => proj.projectBrief(x, { orgName, keys: projectKeys(x), withStatus });
  function projectSummary(x) {
    const st = cl.stats(x);
    const nx = cl.nextOpen(x, 1)[0];
    return {
      id: x.id, name: x.name, status: x.status, organisation: x.orgId ? orgName(x.orgId) : null,
      summary: x.summary || '', resume: (x.resume || '').slice(0, 300),
      folders: (x.folders || []).map(f => f.path),
      checklist: st.total ? `${st.done} of ${st.counted} done${st.in_progress ? `, ${st.in_progress} in progress` : ''}${st.blocked ? `, ${st.blocked} blocked` : ''}` : 'no checklist yet',
      nextItem: nx ? `${cl.fullRef(x, nx)} ${nx.title}` : null,
      lastWorked: x.lastWorked ? new Date(x.lastWorked).toISOString() : null,
    };
  }

  // ---------- services helpers ----------
  function composeLinks() {
    requireUnlocked();   // the vault may have locked while a slow request was waiting
    S.vault.settings.composeLinks ||= {};
    return S.vault.settings.composeLinks;
  }
  function vaultRedactor() {
    requireUnlocked();
    return redactor(S.vault.keys);
  }
  async function projectContainers(project) {
    if (!svc.PROJECT_NAME.test(project)) throw new HttpError(400, 'Invalid compose project name');
    return (await svc.listContainers()).filter(c => c.project === project);
  }
  async function composeUp(project, who, fromAgent = false) {
    const link = composeLinks()[project] || {};
    const containers = await projectContainers(project).catch(() => []);
    const workingDir = containers.find(c => c.workingDir)?.workingDir || link.workingDir;
    const configFiles = containers.find(c => c.configFiles)?.configFiles || link.configFiles;
    if (!workingDir) throw new HttpError(400, `KeyVault does not know where the "${project}" compose files are. Start it once with docker compose so Docker records the folder.`);
    const vars = link.vars && Object.keys(link.vars).length ? link.vars : null;
    const bindings = vars ? buildBindings(fromAgent ? agentKeys() : S.vault.keys, { vars }) : new Map();
    audit({ source: who, action: 'compose-up', keys: [...bindings.values()].map(k => k.name), target: project, cwd: workingDir });
    save();
    return runWithSecrets({ argv: svc.composeArgv(project, configFiles), cwd: workingDir, bindings, scrubKeys: S.vault.keys, timeoutSec: 300 });
  }

  async function handleServicesUi(req, res, pathname, url, body) {
    const m = req.method;
    let mt;
    if (m === 'GET' && pathname === '/api/services') {
      const snap = await svc.snapshot({ ownPort: port, probe: url.searchParams.get('probe') !== '0' });
      return send(res, 200, { ...snap, composeLinks: composeLinks() });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/services\/containers\/([^/]+)\/(start|stop|restart)$/))) {
      const r = await svc.containerAction(decodeURIComponent(mt[1]), mt[2]);
      return send(res, 200, r);
    }
    if (m === 'GET' && (mt = pathname.match(/^\/api\/services\/containers\/([^/]+)\/logs$/))) {
      const logs = await svc.containerLogs(decodeURIComponent(mt[1]), url.searchParams.get('tail'));
      return send(res, 200, { logs });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/services\/projects\/([^/]+)\/(start|stop|restart)$/))) {
      const list = await projectContainers(decodeURIComponent(mt[1]));
      if (!list.length) throw new HttpError(404, 'No containers found for this project. Press Refresh.');
      const one = c => svc.containerAction(c.id, mt[2])
        .then(() => ({ name: c.name, ok: true }), e => ({ name: c.name, ok: false, error: e.message }));
      // Stopping waits up to 10 seconds per container, so do them all at once.
      // Starting and restarting go one by one, which respects compose start order.
      let results;
      if (mt[2] === 'stop') results = await Promise.all(list.map(one));
      else { results = []; for (const c of list) results.push(await one(c)); }
      return send(res, 200, { results });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/services\/projects\/([^/]+)\/up$/))) {
      const r = await composeUp(decodeURIComponent(mt[1]), 'you');
      return send(res, 200, r);
    }
    if (m === 'PUT' && (mt = pathname.match(/^\/api\/services\/projects\/([^/]+)\/links$/))) {
      const project = decodeURIComponent(mt[1]);
      if (!svc.PROJECT_NAME.test(project)) throw new HttpError(400, 'Invalid compose project name');
      const vars = body.vars && typeof body.vars === 'object' ? body.vars : {};
      for (const [name, id] of Object.entries(vars)) {
        if (!isEnvName(name)) throw new HttpError(400, `"${name}" is not a valid environment variable name`);
        if (!S.vault.keys.some(k => k.id === id)) throw new HttpError(400, 'Unknown key');
      }
      const containers = await projectContainers(project).catch(() => []);
      const prev = composeLinks()[project] || {};
      composeLinks()[project] = {
        vars,
        workingDir: containers.find(c => c.workingDir)?.workingDir || prev.workingDir || null,
        configFiles: containers.find(c => c.configFiles)?.configFiles || prev.configFiles || null,
      };
      save();
      return send(res, 200, { link: composeLinks()[project] });
    }
    if (m === 'POST' && (mt = pathname.match(/^\/api\/services\/processes\/(\d+)\/stop$/))) {
      const r = await svc.stopProcess(Number(mt[1]));
      return send(res, 200, r);
    }
    throw new HttpError(404, 'Not found');
  }

  async function handleAgentServices(req, res, pathname, url, body, client) {
    const m = req.method;
    if (m === 'GET' && pathname === '/agent/services') {
      const snap = await svc.snapshot({ ownPort: port });
      const includeSystem = url.searchParams.get('system') === '1';
      return send(res, 200, {
        docker: snap.docker,
        containers: snap.containers.map(c => ({
          name: c.name, id: c.shortId, image: c.image, state: c.state, status: c.status,
          project: c.project, service: c.service, workingDir: c.workingDir,
          ports: c.ports.map(p => `${p.hostPort}->${p.containerPort}/${p.proto}`),
        })),
        ports: snap.listeners.filter(l => includeSystem || !l.system).map(l => ({
          port: l.port, pid: l.pid, process: l.process, exposure: l.exposure,
          addresses: l.addresses, container: l.container?.name || null,
          http: l.probe?.http ? { status: l.probe.status, title: l.probe.title } : null,
        })),
        portsError: snap.portsError,
      });
    }
    // Everything else changes things or reads logs, so it needs an unlocked vault
    // (for the audit log, and to scrub any stored key out of log output).
    requireUnlocked();
    if (m === 'POST' && pathname === '/agent/services/container') {
      const ref = String(body.ref || ''); const action = String(body.action || '');
      const r = await svc.containerAction(ref, action);   // validates ref and action
      audit({ source: client, action: `container-${action}`, target: ref });
      save();
      return send(res, 200, r);
    }
    if (m === 'GET' && pathname === '/agent/services/logs') {
      const logs = await svc.containerLogs(url.searchParams.get('ref') || '', url.searchParams.get('tail'));
      return send(res, 200, { logs: vaultRedactor()(logs) });
    }
    if (m === 'POST' && pathname === '/agent/services/free-port') {
      const portNo = Number(body.port);
      if (!Number.isInteger(portNo) || portNo < 1 || portNo > 65535) throw new HttpError(400, 'Port must be 1 to 65535');
      if (portNo === port) throw new HttpError(400, 'That port is KeyVault itself');
      const snap = await svc.snapshot({ ownPort: port, probe: false });
      const hits = snap.listeners.filter(l => l.port === portNo);
      if (!hits.length) return send(res, 200, { ok: true, message: `Nothing is listening on port ${portNo}.` });
      const inContainer = hits.find(h => h.container);
      if (inContainer) throw new HttpError(409, `Port ${portNo} belongs to the Docker container "${inContainer.container.name}". Stop that container instead.`);
      const dockerOwned = hits.find(h => h.dockerProcess);
      if (dockerOwned) throw new HttpError(409, `Port ${portNo} is published by Docker (${dockerOwned.process}). Stop the container that uses it instead.`);
      const sys = hits.find(h => h.system || h.pid == null);
      if (sys) throw new HttpError(409, `Port ${portNo} is held by a system process (${sys.process || 'unknown'}), which KeyVault will not stop.`);
      const stopped = [];
      for (const h of hits) {
        audit({ source: client, action: 'stop-process', target: `${h.process || 'process'} (pid ${h.pid}) on port ${portNo}` });
        await svc.stopProcess(h.pid);
        stopped.push({ pid: h.pid, process: h.process });
      }
      save();
      return send(res, 200, { ok: true, stopped });
    }
    if (m === 'POST' && pathname === '/agent/services/compose-up') {
      return send(res, 200, await composeUp(String(body.project || ''), client, true));
    }
    throw new HttpError(404, 'Not found');
  }

  async function handleAgent(req, res, pathname, url) {
    if (req.headers.origin) throw new HttpError(403, 'Forbidden');   // browsers never get agent access
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), agentToken)) throw new HttpError(401, 'Unauthorised');
    const m = req.method;
    const body = m === 'POST' ? await readBody(req) : {};
    const client = typeof body.client === 'string' ? body.client.slice(0, 60) : 'AI tool';

    if (m === 'GET' && pathname === '/agent/status') {
      return send(res, 200, {
        state: state(), version: VERSION, pid: process.pid, keys: S.vault ? agentKeys().length : null,
        pass: S.pass ? { until: new Date(S.pass.until).toISOString(), limitedTo: passProject()?.name || null } : null,
      });
    }
    if (m === 'POST' && pathname === '/agent/open') {
      // Never hand the login link to agents: it would grant full UI access.
      const opened = openBrowser(makeLoginUrl());
      return send(res, 200, { opened });
    }
    if (m === 'POST' && pathname === '/agent/lock') { lock('cli'); return send(res, 200, { ok: true }); }
    if (m === 'POST' && pathname === '/agent/shutdown') {
      send(res, 200, { ok: true });
      setTimeout(() => shutdown('stop command'), 50);
      return;
    }
    if (pathname.startsWith('/agent/services')) return handleAgentServices(req, res, pathname, url, body, client);

    requireUnlocked();
    const V = S.vault;

    if (m === 'GET' && pathname === '/agent/keys') {
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const org = (url.searchParams.get('org') || '').toLowerCase();
      const provider = (url.searchParams.get('provider') || '').toLowerCase();
      const type = url.searchParams.get('type') || '';
      const status = url.searchParams.get('status') || '';
      const list = agentKeys().filter(k =>
        (!org || orgName(k.orgId).toLowerCase().includes(org)) &&
        (!provider || k.provider.toLowerCase().includes(provider)) &&
        (!type || k.type === type) &&
        (!status || k.status === status) &&
        (!q || [k.name, k.provider, k.notes, k.envVar, orgName(k.orgId)].join(' ').toLowerCase().includes(q)),
      ).map(agentKey);
      return send(res, 200, { keys: list, total: agentKeys().length });
    }

    // ----- Projects, for AI tools (no deleting) -----
    if (m === 'GET' && pathname === '/agent/projects') {
      const status = url.searchParams.get('status') || '';
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const list = agentProjects()
        .filter(x => (status ? x.status === status : x.status !== 'archived'))
        .filter(x => !q || [x.name, x.summary, orgName(x.orgId)].join(' ').toLowerCase().includes(q))
        .sort((a, b) => (b.pinned - a.pinned) || ((b.lastWorked || 0) - (a.lastWorked || 0)) || ((b.updated || 0) - (a.updated || 0)));
      return send(res, 200, { projects: list.map(projectSummary), total: agentProjects().length });
    }
    if (m === 'GET' && pathname === '/agent/project') {
      const x = agentProjectByRef(url.searchParams.get('ref'));
      return send(res, 200, { id: x.id, name: x.name, brief: await briefOf(x), folders: (x.folders || []).map(f => f.path) });
    }
    if (m === 'POST' && pathname === '/agent/projects') {
      if (S.pass?.projectId) throw new HttpError(403, `The agent pass only covers ${passProject()?.name || 'one project'}, so new projects cannot be created until it ends.`);
      const x = newProject({ name: body.name, summary: body.summary, folders: body.folders || [], resume: body.resume, links: body.links || [], phases: body.phases, items: (body.items || []).concat((body.next || []).map(t => ({ phase: 'Next steps', title: t }))) }, client);
      audit({ source: client, action: 'project-created', target: x.name });
      save();
      return send(res, 200, { project: projectSummary(x) });
    }
    if (m === 'POST' && pathname === '/agent/project/update') {
      const x = agentProjectByRef(body.ref);
      const b = {};
      for (const k of ['name', 'summary', 'resume', 'status']) if (body[k] != null) b[k] = body[k];
      if (Array.isArray(body.add_folders)) b.folders = [...x.folders, ...body.add_folders.map(f => ({ path: f }))];
      cl.ensureChecklist(x);
      if (Array.isArray(body.add_next)) checklistDo(() => cl.addItems(x, { items: body.add_next.map(t => ({ phase: 'Next steps', title: t })) }, client));
      if (Array.isArray(body.complete_next)) checklistDo(() => cl.updateItems(x, body.complete_next.map(t => ({ item: t, status: 'done' })), client));
      if (b.status === 'archived' && !body.confirm_archive) throw new HttpError(400, 'Only archive a project when the user asks you to (set confirm_archive).');
      applyProject(x, b, client);
      if (body.note) logProject(x, body.note, client);
      else x.log.unshift({ at: Date.now(), source: client, text: `Updated ${Object.keys(b).join(', ') || 'nothing'}` });
      audit({ source: client, action: 'project-updated', target: x.name });
      save();
      return send(res, 200, { project: projectSummary(x) });
    }
    if (m === 'GET' && pathname === '/agent/project/checklist') {
      const x = agentProjectByRef(url.searchParams.get('ref'));
      cl.ensureChecklist(x);
      const phase = url.searchParams.get('phase'); const status = url.searchParams.get('status');
      const ph = phase ? cl.findPhase(x, phase) : null;
      if (phase && !ph) throw new HttpError(404, `No phase "${phase}" in ${x.name}`);
      const items = cl.displayOrder(x).filter(i => (!ph || i.phaseId === ph.id) && (!status || i.status === status));
      const parRef = i => { const par = i.parentId && x.items.find(q => q.id === i.parentId); return par ? cl.fullRef(x, par) : undefined; };
      const kidInfo = i => {
        if (i.parentId) return undefined;
        const kids = x.items.filter(c => c.parentId === i.id && c.status !== 'superseded');
        return kids.length ? `${kids.filter(c => c.status === 'done').length}/${kids.length} done` : undefined;
      };
      const byPhase = x.phases.filter(p => !ph || p === ph).map(p => ({
        phase: `${p.code} · ${p.name}`,
        items: items.filter(i => i.phaseId === p.id).map(i => ({ id: cl.fullRef(x, i), parent: parRef(i), title: i.title, status: i.status, owner: i.owner || null, subtasks: kidInfo(i), notes: i.notes || undefined })),
      })).filter(g => g.items.length);
      return send(res, 200, { project: x.name, key: x.key, stats: cl.stats(x), phases: byPhase });
    }
    if (m === 'POST' && pathname === '/agent/project/checklist') {
      const x = agentProjectByRef(body.ref);
      cl.ensureChecklist(x);
      if (body.replace) {
        if (!body.confirm_replace) throw new HttpError(400, 'Replacing a whole checklist deletes its items. Only do it when the user asks (set confirm_replace).');
        x.phases = []; x.items = [];
      }
      const added = checklistDo(() => cl.addItems(x, { phases: body.phases || [], items: body.items || [] }, client));
      x.lastWorked = x.updated = Date.now();
      x.log.unshift({ at: Date.now(), source: client, text: `Added ${added.length} checklist item${added.length === 1 ? '' : 's'}` });
      audit({ source: client, action: 'checklist-added', target: x.name });
      save();
      return send(res, 200, { added: added.map(i => ({ id: cl.fullRef(x, i), title: i.title, status: i.status })), stats: cl.stats(x) });
    }
    if (m === 'POST' && pathname === '/agent/project/checklist/update') {
      const x = agentProjectByRef(body.ref);
      const r = checklistDo(() => cl.updateItems(x, body.updates || [], client));
      if (r.changed.length) {
        x.lastWorked = x.updated = Date.now();
        const done = r.changed.filter(i => i.status === 'done');
        x.log.unshift({ at: Date.now(), source: client, text: done.length ? `Done: ${done.map(i => `${cl.fullRef(x, i)} ${i.title}`).join('; ').slice(0, 600)}` : `Updated ${r.changed.length} checklist item${r.changed.length === 1 ? '' : 's'}` });
        save();
      }
      return send(res, 200, { changed: r.changed.map(i => ({ id: cl.fullRef(x, i), title: i.title, status: i.status, owner: i.owner || null })), missing: r.missing, stats: cl.stats(x) });
    }
    if (m === 'POST' && pathname === '/agent/project/log') {
      const x = agentProjectByRef(body.ref);
      logProject(x, body.text, client, body.resume);
      save();
      return send(res, 200, { project: projectSummary(x) });
    }
    if (m === 'POST' && pathname === '/agent/project/open') {
      const x = agentProjectByRef(body.ref);
      const f = x.folders?.[Number(body.folder) || 0];
      if (!f) throw new HttpError(400, 'This project has no folder linked. Add one with update_project (add_folders).');
      let r;
      try { r = await proj.openFolder(f.path, body.how || 'folder'); }
      catch (e) { throw new HttpError(400, e.message); }
      audit({ source: client, action: 'project-opened', target: `${x.name}: ${f.path}` });
      requireUnlocked();   // it may have locked while the folder was opening
      x.lastOpened = Date.now();
      save();
      return send(res, 200, r);
    }

    if (m === 'POST' && pathname === '/agent/env') {
      const bindings = buildBindings(agentKeys(), body);
      const file = typeof body.path === 'string' ? path.resolve(body.path) : '';
      if (!file) throw new HttpError(400, 'path is required');
      const result = writeEnvFile({ file, bindings, mode: body.mode, ensureGitignore: body.ensureGitignore !== false, forbiddenDirs: [p.home] });
      audit({ source: client, action: 'env-file', keys: [...bindings.values()].map(k => k.name), target: file });
      save();
      return send(res, 200, result);
    }

    if (m === 'POST' && pathname === '/agent/run') {
      const bindings = buildBindings(agentKeys(), body);
      const command = typeof body.command === 'string' ? body.command : '';
      audit({ source: client, action: 'run', keys: [...bindings.values()].map(k => k.name), target: command.slice(0, 300), cwd: body.cwd });
      save();
      const result = await runWithSecrets({ command, cwd: body.cwd, baseEnv: body.env, bindings, scrubKeys: V.keys, timeoutSec: body.timeoutSec });
      return send(res, 200, result);
    }

    throw new HttpError(404, 'Not found');
  }

  async function serveAsset(res, pathname) {
    const [file, type] = ASSETS[pathname];
    // In the exe, text files are embedded as-is and binary files (fonts) as base64.
    const emb = EMBEDDED_UI?.[file];
    const buf = EMBEDDED_UI
      ? (file.endsWith('.woff2') ? Buffer.from(emb, 'base64') : Buffer.from(emb, 'utf8'))
      : fs.readFileSync(path.join(uiDir(), file));
    send(res, 200, buf, type, type.startsWith('font/') ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {});
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      if (!hostOk(req)) throw new HttpError(421, 'Wrong host');   // blocks DNS rebinding
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const pn = url.pathname;
      if (pn.startsWith('/agent/')) return await handleAgent(req, res, pn, url);
      if (pn === '/open' && req.method === 'GET') return await handleOpen(req, res, url);
      if (pn.startsWith('/api/')) return await handleApi(req, res, pn, url);
      if (req.method === 'GET' && ASSETS[pn]) return await serveAsset(res, pn);
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e.status || (e instanceof HttpError ? 500 : 400);
      if (!e.status) log('request error:', e.message);
      send(res, status, { error: e.message || 'Error', ...(e.extra || {}) });
    }
  });

  // ---------- lifecycle ----------
  function lockTick() {
    if (!S.vault) return;
    const now = Date.now();
    const idle = now - S.lastActive > S.vault.settings.autoLockMin * MINUTE;
    if (S.pass && now >= S.pass.until) {
      endPass('time is up');
      if (idle || S.uiLocked) lock('agent pass ended');
      return;
    }
    if (!idle) return;
    if (S.pass) {
      if (!S.uiLocked) { S.uiLocked = true; log('page locked after inactivity; agent pass continues'); }
    } else lock('inactivity');
  }
  const timer = setInterval(lockTick, Math.min(10_000, Math.max(50, MINUTE / 6)));

  let closing = false;
  function shutdown(reason) {
    if (closing) return;
    closing = true;
    log('stopping:', reason);
    clearInterval(timer);
    lock('shutdown');
    saveSessions(true);
    try {
      const a = JSON.parse(fs.readFileSync(p.agent, 'utf8'));
      if (a.pid === process.pid) fs.unlinkSync(p.agent);
    } catch {}
    server.close();
    setTimeout(() => process.exit(0), 100).unref();
  }

  await new Promise((resolve, reject) => {
    const listen = want => {
      server.removeAllListeners('error');
      server.once('error', e => {
        if (e.code === 'EADDRINUSE' && want !== 0 && process.env.KEYVAULT_PORT == null) {
          log(`port ${want} is in use, picking a free one`);
          return listen(0);
        }
        reject(e);
      });
      server.listen(want, '127.0.0.1', resolve);
    };
    listen(process.env.KEYVAULT_PORT != null ? Number(process.env.KEYVAULT_PORT) || 0 : DEFAULT_PORT);
  });
  port = server.address().port;
  writeAtomic(p.agent, JSON.stringify({ pid: process.pid, port, token: agentToken, version: VERSION, startedAt: new Date().toISOString() }, null, 2));
  log(`KeyVault ${VERSION} listening on 127.0.0.1:${port} (vault: ${p.vault})`);

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  if (open) openBrowser(makeLoginUrl());

  return { port, makeLoginUrl, shutdown };
}
