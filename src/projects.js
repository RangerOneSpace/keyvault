// Projects: the "pick up where you left off" harness.
//
// A project is a named piece of work with local folders, a note on where you
// left off, a build checklist and an activity log. Projects live inside the encrypted
// vault (notes can be sensitive). This module holds the parts that touch the
// computer: checking folders, reading git status, opening a folder in
// Explorer / VS Code / Cursor / a terminal, the Windows folder picker, finding
// existing repos, and writing the brief an AI tool reads to resume work.
//
// Nothing here ever runs a path through a shell. Paths go to programs as
// separate arguments, or to PowerShell through environment variables.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { checklistMarkdown } from './checklist.js';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'];
export const OPENERS = ['folder', 'vscode', 'cursor', 'terminal'];

// ---------------------------------------------------------------- folders
export function checkFolder(p) {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'Folder path is empty' };
  if (/[\0-\x1f]/.test(p)) return { ok: false, error: 'Folder path has invalid characters' };
  const winAbs = /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
  if (!(path.isAbsolute(p) || winAbs)) return { ok: false, error: 'Use a full folder path, for example C:\\Users\\you\\code\\my-app' };
  const resolved = path.resolve(p.trim());
  try {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return { ok: false, path: resolved, error: 'That is a file, not a folder' };
  } catch {
    return { ok: false, path: resolved, missing: true, error: 'That folder does not exist (moved, renamed or on a drive that is not connected)' };
  }
  return { ok: true, path: resolved };
}

// ---------------------------------------------------------------- git
const gitCache = new Map();
function git(dir, args) {
  // A repo's own config could otherwise make `git status` run a program
  // (core.fsmonitor), so that and the pager are switched off for every call.
  const safe = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '--no-pager'];
  return new Promise(resolve => {
    execFile('git', [...safe, '-C', dir, ...args], {
      encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

export async function folderStatus(p) {
  const chk = checkFolder(p);
  if (!chk.ok) return { path: chk.path || p, exists: false, error: chk.error };
  const hit = gitCache.get(chk.path);
  if (hit && Date.now() - hit.at < 20_000) return hit.value;
  const out = { path: chk.path, exists: true, git: null, name: path.basename(chk.path) };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(chk.path, 'package.json'), 'utf8'));
    if (pkg?.name) out.package = String(pkg.name).slice(0, 80);
  } catch {}
  if (fs.existsSync(path.join(chk.path, '.git')) || (await git(chk.path, ['rev-parse', '--is-inside-work-tree'])) === 'true') {
    const branch = await git(chk.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch != null) {
      const [porcelain, last, remote] = await Promise.all([
        git(chk.path, ['status', '--porcelain']).then(x => x || ''),
        git(chk.path, ['log', '-1', '--format=%ct%x09%s']),
        git(chk.path, ['remote', 'get-url', 'origin']),
      ]);
      const [ts, ...subj] = (last || '').split('\t');
      out.git = {
        branch,
        changes: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
        lastCommit: last ? { at: Number(ts) * 1000, subject: subj.join('\t').slice(0, 200) } : null,
        remote: remote ? webUrl(remote) : null,
      };
    }
  }
  gitCache.set(chk.path, { at: Date.now(), value: out });
  return out;
}

// git@github.com:org/repo.git -> https://github.com/org/repo (only well-formed hosts)
function webUrl(remote) {
  let m = /^git@([\w.-]+):([\w.\-/]+?)(\.git)?$/.exec(remote);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^https?:\/\/(?:[^@/]+@)?([\w.-]+(?::\d+)?)\/([\w.\-/]+?)(\.git)?$/.exec(remote);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

// ---------------------------------------------------------------- opening
function detached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
    p.once('error', e => { if (!settled) { settled = true; reject(e); } });
    p.once('spawn', () => { if (!settled) { settled = true; p.unref(); resolve(); } });
  });
}

// PowerShell gets the values through environment variables, never interpolated.
function powershell(script, env, { wait = false, timeoutMs = 10_000 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  if (!wait) return detached('powershell.exe', args, { windowsHide: true, env: { ...process.env, ...env } });
  return new Promise(resolve => {
    const p = spawn('powershell.exe', ['-STA', ...args], { windowsHide: true, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.on('close', code => { clearTimeout(t); resolve({ code, out: out.trim() }); });
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out: '' }); });
  });
}

function findEditor(kind) {
  if (isWin) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const candidates = kind === 'vscode'
      ? [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(pf, 'Microsoft VS Code', 'Code.exe')]
      : [path.join(local, 'Programs', 'cursor', 'Cursor.exe'), path.join(local, 'Programs', 'Cursor', 'Cursor.exe')];
    return candidates.find(c => fs.existsSync(c)) || null;
  }
  if (isMac) {
    const app = kind === 'vscode' ? '/Applications/Visual Studio Code.app' : '/Applications/Cursor.app';
    return fs.existsSync(app) ? app : null;
  }
  const bin = kind === 'vscode' ? 'code' : 'cursor';
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findWindowsTerminal() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const wt = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  return fs.existsSync(wt) ? wt : null;
}

let openersCache = null;
export function availableOpeners() {
  if (openersCache && Date.now() - openersCache.at < 60_000) return openersCache.value;
  const value = {
    folder: true,
    vscode: !!findEditor('vscode'),
    cursor: !!findEditor('cursor'),
    terminal: isWin || isMac || !!spawnSync('which', ['x-terminal-emulator'], { encoding: 'utf8' }).stdout,
  };
  openersCache = { at: Date.now(), value };
  return value;
}

export async function openFolder(p, how = 'folder') {
  const chk = checkFolder(p);
  if (!chk.ok) throw new Error(chk.error);
  const dir = chk.path;
  if (!OPENERS.includes(how)) throw new Error(`Open with one of: ${OPENERS.join(', ')}`);
  if (process.env.KEYVAULT_NO_BROWSER) return { opened: false, dir, how, note: 'Opening is switched off (KEYVAULT_NO_BROWSER)' };

  if (how === 'folder') {
    if (isWin) await detached('explorer.exe', [dir]);
    else await detached(isMac ? 'open' : 'xdg-open', [dir]);
  } else if (how === 'vscode' || how === 'cursor') {
    const exe = findEditor(how);
    if (!exe) throw new Error(how === 'vscode' ? 'VS Code is not installed (or not in the usual place)' : 'Cursor is not installed (or not in the usual place)');
    if (isMac) await detached('open', ['-a', exe, dir]);
    else await detached(exe, [dir], { windowsHide: true });
  } else if (how === 'terminal') {
    if (isWin) {
      const wt = findWindowsTerminal();
      if (wt) await detached(wt, ['-d', dir]);
      else await powershell('Start-Process -FilePath cmd.exe -WorkingDirectory $env:KV_DIR', { KV_DIR: dir });
    } else if (isMac) await detached('open', ['-a', 'Terminal', dir]);
    else await detached('x-terminal-emulator', [], { cwd: dir });
  }
  return { opened: true, dir, how };
}

// Native "choose a folder" dialog (Windows). Returns a path, or null if cancelled.
export async function pickFolder(start) {
  if (!isWin) throw new Error('The folder picker is available on Windows. Paste the folder path instead.');
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = "Minimized" }',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "Choose the project folder"',
    '$d.ShowNewFolderButton = $true',
    'if ($env:KV_START -and (Test-Path -LiteralPath $env:KV_START)) { $d.SelectedPath = $env:KV_START }',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
  ].join('; ');
  const r = await powershell(script, { KV_START: start || '' }, { wait: true, timeoutMs: 5 * 60_000 });
  const chosen = r.out.split(/\r?\n/).pop();
  return chosen ? checkFolder(chosen).path || null : null;
}

// ---------------------------------------------------------------- discovery
export function defaultScanRoots() {
  const h = os.homedir();
  return ['code', 'Code', 'projects', 'Projects', 'src', 'dev', 'repos', 'git', path.join('Documents', 'GitHub'), path.join('source', 'repos')]
    .map(d => path.join(h, d))
    .filter((d, i, a) => a.indexOf(d) === i && fs.existsSync(d));
}

// Git repos up to two levels below each root (root/repo and root/org/repo).
export function scanForRepos(roots = defaultScanRoots(), limit = 300) {
  const found = [];
  const seen = new Set();
  const isRepo = d => { try { return fs.existsSync(path.join(d, '.git')); } catch { return false; } };
  const kids = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => path.join(d, e.name)); } catch { return []; } };
  for (const root of roots) {
    for (const a of kids(root)) {
      if (found.length >= limit) break;
      if (isRepo(a)) { if (!seen.has(a)) { seen.add(a); found.push(a); } continue; }
      for (const b of kids(a)) {
        if (found.length >= limit) break;
        if (isRepo(b) && !seen.has(b)) { seen.add(b); found.push(b); }
      }
    }
  }
  return found.map(p => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(p, '.git')).mtimeMs; } catch {}
    return { path: p, name: path.basename(p), touched: mtime };
  }).sort((a, b) => b.touched - a.touched);
}

// ---------------------------------------------------------------- the brief
const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : 'never');
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// Markdown an AI tool (or a person) reads to pick the project back up.
export async function projectBrief(p, { orgName = () => '', keys = [], withStatus = true } = {}) {
  const L = [];
  L.push(`# ${p.name}`);
  L.push('');
  L.push(`Status: ${p.status}${p.orgId ? `  ·  Organisation: ${orgName(p.orgId)}` : ''}  ·  Last worked on: ${day(p.lastWorked || p.updated)}${p.lastWorked ? ` (${ago(p.lastWorked)})` : ''}`);
  if (p.summary) { L.push('', '## What this is', p.summary); }
  L.push('', '## Where I left off', p.resume || '(nothing noted yet)');
  L.push('', '## Checklist (open items; done ones are counted)');
  L.push(checklistMarkdown(p));
  L.push('', '## Folders');
  if (!(p.folders || []).length) L.push('(no folders linked)');
  for (const f of p.folders || []) {
    const st = withStatus ? await folderStatus(f.path) : null;
    let line = `- ${f.label ? `${f.label}: ` : ''}${f.path}`;
    if (st && !st.exists) line += '  (MISSING: folder not found)';
    else if (st?.git) {
      const g = st.git;
      line += `  (git ${g.branch}, ${g.changes ? `${g.changes} uncommitted change${g.changes === 1 ? '' : 's'}` : 'clean'}${g.lastCommit ? `, last commit "${g.lastCommit.subject}" ${ago(g.lastCommit.at)}` : ''})`;
    }
    L.push(line);
  }
  if ((p.links || []).length) {
    L.push('', '## Links');
    for (const l of p.links) L.push(`- ${l.label ? `${l.label}: ` : ''}${l.url}`);
  }
  if (keys.length) {
    L.push('', '## Keys for this project (in KeyVault; use write_env_file or run_with_secrets, never ask for the values)');
    for (const k of keys) L.push(`- ${k.name}${k.envVar ? ` (${k.envVar})` : ''}`);
  }
  if (p.composeProject) L.push('', `Docker compose project: ${p.composeProject}`);
  const log = (p.log || []).slice(0, 10);
  if (log.length) {
    L.push('', '## Recent activity');
    for (const e of log) L.push(`- ${day(e.at)} ${e.source ? `[${e.source}] ` : ''}${e.text}`);
  }
  L.push('', '---', 'Work through the checklist in order unless the user says otherwise. As you go, mark items in_progress, done or blocked with update_checklist_items (use the IDs above) and add new items you discover with add_checklist_items. When you finish a session, call log_progress with what was done and where to resume.');
  return L.join('\n');
}
