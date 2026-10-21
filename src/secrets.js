// Using secrets without handing them to an AI:
//  - writeEnvFile: put selected keys into a .env file on disk
//  - runWithSecrets: run a command with keys injected as environment variables,
//    and scrub EVERY stored key out of anything the command prints.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeAtomic } from './store.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_OUTPUT = 64 * 1024;

export function isEnvName(s) { return typeof s === 'string' && ENV_NAME.test(s); }

// Find a key by id, exact name (case-insensitive) or env var name.
export function resolveKey(keys, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Empty key reference');
  const r = ref.trim();
  const byId = keys.find(k => k.id === r);
  if (byId) return byId;
  const lower = r.toLowerCase();
  let hits = keys.filter(k => k.name.toLowerCase() === lower);
  if (hits.length === 0) hits = keys.filter(k => k.envVar && k.envVar === r && k.status !== 'revoked');
  if (hits.length === 0) throw new Error(`No key matches "${r.slice(0, 120)}". Call list_keys to see what is available.`);
  if (hits.length > 1) {
    throw new Error(`"${r.slice(0, 120)}" matches ${hits.length} keys (${hits.map(k => `${k.name} [${k.id}]`).join(', ')}). Use the key id instead.`);
  }
  return hits[0];
}

// Turn { vars: {ENV: ref}, keys: [ref] } into Map(ENV -> key).
export function buildBindings(allKeys, { vars, keys } = {}) {
  const out = new Map();
  const bind = (name, key) => {
    if (!isEnvName(name)) throw new Error(`"${String(name).slice(0, 80)}" is not a valid environment variable name`);
    if (key.status === 'revoked') throw new Error(`"${key.name}" is marked as revoked in KeyVault, so it was not used.`);
    out.set(name, key);
  };
  if (vars && typeof vars === 'object') {
    for (const [name, ref] of Object.entries(vars)) bind(name, resolveKey(allKeys, ref));
  }
  if (Array.isArray(keys)) {
    for (const ref of keys) {
      const k = resolveKey(allKeys, ref);
      if (!k.envVar) throw new Error(`"${k.name}" has no default environment variable name. Pass it in "vars" instead, for example {"MY_KEY": "${k.name}"}.`);
      bind(k.envVar, k);
    }
  }
  if (out.size === 0) throw new Error('No keys selected. Pass "vars" ({"ENV_NAME": "key name or id"}) or "keys" (["key name or id"]).');
  return out;
}

// ---------------------------------------------------------------- redaction

const MIN_SECRET = 4;

// Build a scrubber from a list of key objects. Each value is replaced with a
// label; values are matched longest first so one key inside another is safe.
export function redactor(keys) {
  const pairs = [];
  const seen = new Set();
  for (const k of keys || []) {
    const v = k?.value;
    if (typeof v !== 'string' || v.length < MIN_SECRET || seen.has(v)) continue;
    seen.add(v);
    pairs.push([v, `[KEYVAULT:${k.envVar || k.name || 'key'}]`]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const scrub = text => {
    let t = String(text ?? '');
    for (const [v, label] of pairs) t = t.split(v).join(label);
    return t;
  };
  // Also remove a partial key left at the very end of truncated output.
  scrub.tail = text => {
    let t = scrub(text);
    for (const [v, label] of pairs) {
      for (let n = Math.min(v.length - 1, t.length); n >= MIN_SECRET; n--) {
        if (t.endsWith(v.slice(0, n))) { t = `${t.slice(0, t.length - n)}${label}(cut)`; break; }
      }
    }
    return t;
  };
  return scrub;
}

// ---------------------------------------------------------------- .env files

function quoteEnvValue(v) {
  if (/^[A-Za-z0-9_\-.:/+=@]*$/.test(v)) return v;
  // Single quotes are literal in dotenv and docker compose, so "$" is not expanded.
  if (!/['\r\n]/.test(v)) return `'${v}'`;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

// Merge or replace variables in a dotenv-style file, keeping comments and other lines.
export function renderEnv(existing, values, mode = 'merge') {
  const lines = mode === 'merge' && existing ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(values);
  const re = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const out = lines.map(line => {
    const m = re.exec(line);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${quoteEnvValue(v)}`;
    }
    return line;
  });
  if (pending.size && out.length && out[out.length - 1].trim() !== '') out.push('');
  if (pending.size) out.push('# Added by KeyVault');
  for (const [name, v] of pending) out.push(`${name}=${quoteEnvValue(v)}`);
  return out.join('\n') + '\n';
}

function findGitRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const gitignoreEscape = rel => rel.replace(/([\\*?[\]])/g, '\\$1').replace(/^([#!])/, '\\$1');

// If the file is inside a git repo and not ignored, add it to .gitignore.
export function ensureGitIgnored(file) {
  const root = findGitRoot(path.dirname(file));
  if (!root) return { status: 'not-a-git-repo' };
  const rel = path.relative(root, file).split(path.sep).join('/');
  const check = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, windowsHide: true });
  if (check.error) {
    return { status: 'unknown', note: 'git was not found, so KeyVault could not confirm this file is ignored. Check your .gitignore.' };
  }
  if (check.status === 0) return { status: 'already-ignored' };
  const gi = path.join(root, '.gitignore');
  const current = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  const entry = `/${gitignoreEscape(rel)}`;
  fs.writeFileSync(gi, `${current}${sep}# Secrets written by KeyVault\n${entry}\n`);
  return { status: 'added', gitignore: gi, entry };
}

// Only dotenv-style names: .env, .env.local, .env.production, prod.env ...
export const ENV_FILE_NAME = /^(\.env(\.[A-Za-z0-9_-]+)*|[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.env)$/;

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function writeEnvFile({ file, bindings, mode = 'merge', ensureGitignore = true, forbiddenDirs = [] }) {
  if (!path.isAbsolute(file)) throw new Error('Env file path must be absolute');
  const base = path.basename(file);
  if (!ENV_FILE_NAME.test(base)) throw new Error(`KeyVault only writes dotenv files (".env", ".env.local", "prod.env" and so on), not "${base.slice(0, 80)}".`);
  const dir = path.dirname(file);
  for (const f of forbiddenDirs) {
    if (isInside(path.resolve(dir), path.resolve(f))) throw new Error('KeyVault will not write env files inside its own folder.');
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder does not exist: ${dir}`);
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error(`${file} is not a regular file`);
  const values = new Map([...bindings].map(([name, key]) => [name, key.value]));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  writeAtomic(file, renderEnv(existing, values, mode === 'replace' ? 'replace' : 'merge'), 0o600);
  const git = ensureGitignore ? ensureGitIgnored(file) : { status: 'skipped' };
  return { file, written: [...bindings.keys()], git };
}

// ---------------------------------------------------------------- running commands

function capture(limit) {
  const chunks = []; let size = 0; let dropped = 0;
  return {
    push(buf) {
      if (size < limit) { const take = buf.subarray(0, limit - size); chunks.push(take); size += take.length; dropped += buf.length - take.length; }
      else dropped += buf.length;
    },
    text() { return Buffer.concat(chunks).toString('utf8'); },
    get dropped() { return dropped; },
  };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

// Run either a shell command string (`command`) or a program with an argument
// list (`argv`, no shell involved). `scrubKeys` should be EVERY key in the
// vault, not just the ones injected, so nothing stored can leak via output.
export function runWithSecrets({ command, argv, cwd, baseEnv, bindings, scrubKeys, timeoutSec = 120 }) {
  if (!argv && (typeof command !== 'string' || !command.trim())) throw new Error('Command is required');
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working folder does not exist: ${cwd}`);
  }
  const timeout = Math.min(Math.max(Number(timeoutSec) || 120, 1), 600) * 1000;
  const env = { ...(baseEnv && typeof baseEnv === 'object' ? baseEnv : process.env) };
  for (const [name, key] of bindings) env[name] = key.value;
  const scrub = redactor([...(scrubKeys || []), ...bindings.values()]);
  const longest = Math.max(0, ...[...(scrubKeys || []), ...bindings.values()].map(k => k.value?.length || 0));
  // Capture a little extra so a key straddling the limit is still recognised whole.
  const limit = MAX_OUTPUT + longest + 16;

  return new Promise(resolve => {
    const opts = { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] };
    const child = argv ? spawn(argv[0], argv.slice(1), { ...opts, shell: false }) : spawn(command, { ...opts, shell: true });
    const out = capture(limit);
    const err = capture(limit);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    const finish = (text, dropped) => {
      const clean = scrub(text);
      if (clean.length <= MAX_OUTPUT && !dropped) return { text: clean, cut: false };
      return { text: scrub.tail(clean.slice(0, MAX_OUTPUT)), cut: true };
    };
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: '', stderr: scrub(e.code === 'ENOENT' && argv ? `${argv[0]} was not found. Is it installed and on your PATH?` : e.message), truncated: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const o = finish(out.text(), out.dropped);
      const e = finish(err.text(), err.dropped);
      resolve({ exitCode: code, signal, timedOut, stdout: o.text, stderr: e.text, truncated: o.cut || e.cut });
    });
  });
}
