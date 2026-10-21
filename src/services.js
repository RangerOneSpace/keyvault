// Services: Docker containers and programs listening on localhost ports.
// No dependencies: talks to the Docker Engine API over its socket (or the
// Docker Desktop named pipe on Windows) and reads listening ports with the
// operating system's own tools.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ============================== Docker ==============================

export function dockerTarget() {
  const h = process.env.DOCKER_HOST;
  if (h) {
    if (h.startsWith('unix://')) return { socketPath: h.slice(7) };
    if (h.startsWith('npipe://')) return { socketPath: h.slice(8).replace(/\//g, '\\') };
    if (h.startsWith('tcp://')) {
      const u = new URL(h.replace(/^tcp:/, 'http:'));
      return { host: u.hostname, port: Number(u.port) || 2375 };
    }
  }
  if (isWin) return { socketPath: '\\\\.\\pipe\\docker_engine' };
  const candidates = [
    '/var/run/docker.sock',
    path.join(os.homedir(), '.docker', 'run', 'docker.sock'),
    path.join(os.homedir(), '.colima', 'default', 'docker.sock'),
    path.join(os.homedir(), '.orbstack', 'run', 'docker.sock'),
    path.join(os.homedir(), '.rd', 'docker.sock'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return { socketPath: c };
  return { socketPath: '/var/run/docker.sock' };
}

function dockerRequest(method, p, { timeout = 8000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...dockerTarget(), method, path: p, timeout }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size <= 4 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, buf });
        let body = null;
        try { body = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch {}
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Docker did not respond in time'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

function explainDockerError(e) {
  if (['ENOENT', 'ECONNREFUSED'].includes(e.code)) {
    return isWin || isMac ? 'Docker Desktop is not running.' : 'Docker is not running, or its socket was not found. Set DOCKER_HOST if it lives somewhere unusual.';
  }
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    return isWin ? 'No permission to talk to Docker Desktop.' : 'No permission to talk to Docker. Add your user to the "docker" group, then log out and back in.';
  }
  return e.message;
}

export async function dockerStatus() {
  try {
    const r = await dockerRequest('GET', '/version', { timeout: 2500 });
    if (r.status !== 200) return { available: false, error: `Docker returned HTTP ${r.status}` };
    return { available: true, version: r.body?.Version || null };
  } catch (e) {
    return { available: false, error: explainDockerError(e) };
  }
}

function mergePorts(list) {
  const map = new Map();
  for (const p of list) {
    if (!p.PublicPort) continue;
    const key = `${p.PublicPort}/${p.Type}`;
    const cur = map.get(key) || { hostPort: p.PublicPort, containerPort: p.PrivatePort, proto: p.Type, hosts: [] };
    const ip = p.IP || '0.0.0.0';
    if (!cur.hosts.includes(ip)) cur.hosts.push(ip);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => a.hostPort - b.hostPort);
}

export async function listContainers() {
  const r = await dockerRequest('GET', '/containers/json?all=1');
  if (r.status !== 200) throw new Error(r.body?.message || `Docker returned HTTP ${r.status}`);
  return (r.body || []).map(c => {
    const L = c.Labels || {};
    return {
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      state: c.State,            // running, exited, paused, restarting, created, dead
      status: c.Status,          // "Up 2 hours (healthy)"
      created: (c.Created || 0) * 1000,
      project: L['com.docker.compose.project'] || null,
      service: L['com.docker.compose.service'] || null,
      workingDir: L['com.docker.compose.project.working_dir'] || null,
      configFiles: L['com.docker.compose.project.config_files'] || null,
      ports: mergePorts(c.Ports || []),
    };
  }).sort((a, b) => (a.project || '~').localeCompare(b.project || '~') || a.name.localeCompare(b.name));
}

const CONTAINER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const CONTAINER_ACTIONS = ['start', 'stop', 'restart'];

export async function containerAction(ref, action) {
  if (!CONTAINER_REF.test(String(ref))) throw new Error('Invalid container name or id');
  if (!CONTAINER_ACTIONS.includes(action)) throw new Error(`Action must be one of: ${CONTAINER_ACTIONS.join(', ')}`);
  const q = action === 'start' ? '' : '?t=10';
  const r = await dockerRequest('POST', `/containers/${encodeURIComponent(ref)}/${action}${q}`, { timeout: 30_000 });
  if (r.status === 204 || r.status === 304) return { ok: true, changed: r.status === 204 };
  if (r.status === 404) throw new Error(`No container called "${ref}"`);
  throw new Error(r.body?.message || `Docker returned HTTP ${r.status}`);
}

// Docker multiplexes stdout/stderr unless the container has a TTY.
export function demuxDockerLog(buf) {
  if (buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    const out = []; let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      out.push(buf.subarray(i + 8, i + 8 + size));
      i += 8 + size;
    }
    return Buffer.concat(out).toString('utf8');
  }
  return buf.toString('utf8');
}

export async function containerLogs(ref, tail = 300) {
  if (!CONTAINER_REF.test(String(ref))) throw new Error('Invalid container name or id');
  const n = Math.min(Math.max(Number(tail) || 300, 10), 2000);
  const r = await dockerRequest('GET', `/containers/${encodeURIComponent(ref)}/logs?stdout=1&stderr=1&timestamps=1&tail=${n}`, { raw: true, timeout: 10_000 });
  if (r.status === 404) throw new Error(`No container called "${ref}"`);
  if (r.status !== 200) throw new Error(`Docker returned HTTP ${r.status}`);
  return demuxDockerLog(r.buf);
}

// Compose project names as Docker labels record them. New `docker compose`
// projects are lowercase, but older Compose versions and tools such as the
// Supabase CLI create names with capitals and dots (Ranger_One_Platform).
// Must start with a letter or digit, so it can never be read as a command flag;
// it is only ever passed as a separate argument, never through a shell.
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// Arguments for `docker compose up -d`, run WITHOUT a shell. The config file
// paths come from Docker labels, which a container image could set, so they
// are never interpolated into a command string.
export function composeArgv(project, configFiles) {
  if (!PROJECT_NAME.test(project)) throw new Error('Invalid compose project name');
  const argv = ['docker', 'compose', '-p', project];
  for (const f of String(configFiles || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const winAbs = /^[A-Za-z]:[\\/]/.test(f);
    if (!(path.isAbsolute(f) || winAbs) || /[\0-\x1f]/.test(f)) throw new Error(`Refusing unusual compose file path: ${f.slice(0, 120)}`);
    argv.push('-f', f);
  }
  argv.push('up', '-d');
  return argv;
}

// Docker Desktop's own helper processes own published ports on Windows and macOS.
export const DOCKER_PROCESS = /^(com\.docker\.|docker|dockerd|vpnkit|wslrelay|docker-proxy|containerd|rootlesskit)/i;

// ============================== Ports ==============================

const SYSTEM_PROCESSES = new Set([
  'system', 'idle', 'svchost.exe', 'lsass.exe', 'wininit.exe', 'services.exe', 'spoolsv.exe', 'smss.exe', 'csrss.exe',
  'winlogon.exe', 'searchindexer.exe', 'mdnsresponder.exe', 'jhi_service.exe',
  'launchd', 'rapportd', 'controlce', 'controlcenter', 'sharingd', 'remoted', 'identityservicesd',
  'systemd', 'systemd-resolve', 'systemd-resolved', 'avahi-daemon', 'cupsd', 'rpcbind', 'chronyd',
]);

function splitHostPort(s) {
  const i = s.lastIndexOf(':');
  if (i < 0) return null;
  let host = s.slice(0, i);
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '*') host = '0.0.0.0';
  host = host.replace(/%.*$/, '');   // strip IPv6 zone
  return { host, port };
}

// Windows: `netstat -ano`. Uses the foreign address (0.0.0.0:0 / [::]:0)
// to spot listeners, so it works on non-English Windows too.
export function parseNetstat(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'TCP' || parts.length < 5) continue;
    const [, local, foreign] = parts;
    const pid = Number(parts[parts.length - 1]);
    if (!/^(0\.0\.0\.0|\[::\]|\*):(0|\*)$/.test(foreign)) continue;
    if (parts.length >= 5 && /^BOUND$/i.test(parts[3])) continue;   // bound but not listening
    const hp = splitHostPort(local);
    if (hp && Number.isInteger(pid)) rows.push({ ...hp, pid });
  }
  return rows;
}

// Windows: `tasklist /fo csv /nh`
export function parseTasklist(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map;
}

// macOS: `lsof -nP -iTCP -sTCP:LISTEN -F pcn`
export function parseLsof(text) {
  const rows = []; let pid = null; let cmd = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const t = line[0]; const v = line.slice(1);
    if (t === 'p') { pid = Number(v); cmd = null; }
    else if (t === 'c') cmd = v;
    else if (t === 'n') {
      const hp = splitHostPort(v.split('->')[0]);
      if (hp) rows.push({ ...hp, pid, process: cmd });
    }
  }
  return rows;
}

function hexToIPv4(hex) {
  const b = Buffer.from(hex, 'hex');
  return [b[3], b[2], b[1], b[0]].join('.');
}
function hexToIPv6(hex) {
  const groups = [];
  for (let i = 0; i < 32; i += 8) {
    const w = Buffer.from(hex.slice(i, i + 8), 'hex').reverse();
    groups.push(w.readUInt16BE(0).toString(16), w.readUInt16BE(2).toString(16));
  }
  const s = groups.join(':');
  if (s === '0:0:0:0:0:0:0:0') return '::';
  if (s === '0:0:0:0:0:0:0:1') return '::1';
  const v4 = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(s);
  if (v4) { const a = parseInt(v4[1], 16); const b = parseInt(v4[2], 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return s;
}

// Linux: /proc/net/tcp and tcp6 (state 0A = LISTEN)
export function parseProcNet(text, v6 = false) {
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const [hexAddr, hexPort] = f[1].split(':');
    rows.push({ host: v6 ? hexToIPv6(hexAddr) : hexToIPv4(hexAddr), port: parseInt(hexPort, 16), inode: f[9] });
  }
  return rows;
}

function linuxRows() {
  const rows = [];
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    try { rows.push(...parseProcNet(fs.readFileSync(file, 'utf8'), v6)); } catch {}
  }
  const want = new Set(rows.map(r => r.inode));
  const owner = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${d}/fd/${fd}`));
        if (m && want.has(m[1]) && !owner.has(m[1])) owner.set(m[1], Number(d));
      } catch {}
    }
  }
  return rows.map(r => {
    const pid = owner.get(r.inode) ?? null;
    let proc = null;
    if (pid) { try { proc = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch {} }
    return { host: r.host, port: r.port, pid, process: proc };
  });
}

const LOOPBACK = h => h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.startsWith('127.');

export function groupListeners(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.port}:${r.pid ?? '?'}`;
    const cur = map.get(key) || { port: r.port, pid: r.pid ?? null, process: r.process || null, addresses: [] };
    if (!cur.addresses.includes(r.host)) cur.addresses.push(r.host);
    if (!cur.process && r.process) cur.process = r.process;
    map.set(key, cur);
  }
  return [...map.values()].map(l => ({
    ...l,
    exposure: l.addresses.every(LOOPBACK) ? 'local' : 'network',
    system: (l.pid != null && l.pid <= 4) || SYSTEM_PROCESSES.has(String(l.process || '').toLowerCase()),
    dockerProcess: DOCKER_PROCESS.test(String(l.process || '')),
  })).sort((a, b) => a.port - b.port);
}

export async function listListeners() {
  if (isWin) {
    const [{ stdout: ns }, tl] = await Promise.all([
      execFileP('netstat', ['-ano'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
      execFileP('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' })),
    ]);
    const names = parseTasklist(tl.stdout);
    return groupListeners(parseNetstat(ns).map(r => ({ ...r, process: names.get(r.pid) || null })));
  }
  if (isMac) {
    const { stdout } = await execFileP('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { maxBuffer: 16 * 1024 * 1024 })
      .catch(e => ({ stdout: e.stdout || '' }));   // lsof exits 1 when it finds nothing
    return groupListeners(parseLsof(stdout));
  }
  return groupListeners(linuxRows());
}

// ---------- quick HTTP probe, so each port shows what is actually there ----------
const probeCache = new Map();

// The app's own icon, for the Apps page. Fetched from the same local port only,
// size-limited and returned as a data: URL so the page never loads anything
// from elsewhere (its Content Security Policy allows only 'self' and data:).
const ICON_TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp)$/;
const ICON_MAX = 48 * 1024;

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' })[m]);
}

export function iconHref(html) {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']{1,300})["']/i.exec(tag)?.[1];
    if (!href) continue;
    if (href.startsWith('data:')) return ICON_TYPES.test(href.slice(5).split(/[;,]/)[0]) && href.length < ICON_MAX * 1.4 ? href : null;
    // Same server only: a path, never another host.
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
    return href.startsWith('/') ? href : `/${href.replace(/^\.\//, '')}`;
  }
  return '/favicon.ico';
}

function fetchIcon(host, port, href) {
  if (!href) return Promise.resolve(null);
  if (href.startsWith('data:')) return Promise.resolve(href);
  return new Promise(resolve => {
    const req = http.get({ host, port, path: href, timeout: 900, headers: { 'user-agent': 'KeyVault-Services/1', accept: 'image/*' } }, res => {
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (res.statusCode !== 200 || !ICON_TYPES.test(type)) { res.resume(); return resolve(null); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > ICON_MAX) { res.destroy(); resolve(null); } else chunks.push(c); });
      res.on('end', () => { if (size && size <= ICON_MAX) resolve(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`); else resolve(null); });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

export function probeHttp(port, host = '127.0.0.1') {
  const key = `${host}:${port}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return Promise.resolve(hit.value);
  return new Promise(resolve => {
    const done = value => { probeCache.set(key, { at: Date.now(), value }); resolve(value); };
    const req = http.get({ host, port, path: '/', timeout: 900, headers: { 'user-agent': 'KeyVault-Services/1', accept: 'text/html,*/*' } }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { if (size < 65536) { chunks.push(c); size += c.length; } else res.destroy(); });
      let finished = false;
      const finish = async () => {
        if (finished) return; finished = true;
        const html = Buffer.concat(chunks).toString('utf8');
        const t = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
        const title = t ? decodeEntities(t[1].replace(/\s+/g, ' ').trim()) : null;
        const icon = await fetchIcon(host, port, iconHref(html)).catch(() => null);
        done({ http: true, status: res.statusCode, title, icon, server: String(res.headers.server || '').slice(0, 60) || null });
      };
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('timeout', () => { req.destroy(); done({ http: false }); });
    req.on('error', () => done({ http: false }));
  });
}

export async function probeAll(listeners, skipPorts = []) {
  const queue = listeners.filter(l => !l.system && !skipPorts.includes(l.port));
  const out = new Map();
  const worker = async () => {
    while (queue.length) {
      const l = queue.shift();
      const host = l.addresses.some(a => a === '::1') && !l.addresses.some(a => a.includes('.')) ? '::1' : '127.0.0.1';
      out.set(l.port, await probeHttp(l.port, host));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

export async function stopProcess(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 4) throw new Error('That process cannot be stopped from here');
  if (n === process.pid || n === process.ppid) throw new Error('That is KeyVault itself');
  if (isWin) {
    const r = spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'taskkill failed').trim());
    return { ok: true };
  }
  try { process.kill(n, 'SIGTERM'); }
  catch (e) { throw new Error(e.code === 'EPERM' ? 'No permission to stop that process (it belongs to another user)' : e.code === 'ESRCH' ? 'That process has already stopped' : e.message); }
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { process.kill(n, 0); } catch { return { ok: true }; }
  }
  try { process.kill(n, 'SIGKILL'); } catch {}
  return { ok: true, forced: true };
}

// ============================== Snapshot ==============================

export async function snapshot({ ownPort, probe = true } = {}) {
  const docker = await dockerStatus();
  let containers = [];
  if (docker.available) {
    try { containers = await listContainers(); }
    catch (e) { docker.available = false; docker.error = e.message; }
  }
  let listeners = []; let portsError = null;
  try { listeners = await listListeners(); }
  catch (e) { portsError = `Could not read listening ports: ${e.message}`; }
  listeners = listeners.filter(l => l.port !== ownPort);

  const byPort = new Map();
  for (const c of containers) for (const p of c.ports) if (p.proto === 'tcp') byPort.set(p.hostPort, c);
  const probes = probe ? await probeAll(listeners.filter(l => l.pid !== process.pid), [ownPort]) : new Map();

  listeners = listeners.map(l => {
    const c = byPort.get(l.port);
    return {
      ...l,
      container: c ? { id: c.id, name: c.name, project: c.project } : null,
      probe: probes.get(l.port) || null,
    };
  });
  return { docker, containers, listeners, portsError, platform: process.platform, at: Date.now() };
}
