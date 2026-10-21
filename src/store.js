// Where KeyVault keeps its files, and safe (atomic) writes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function paths() {
  const home = process.env.KEYVAULT_HOME
    ? path.resolve(process.env.KEYVAULT_HOME)
    : path.join(os.homedir(), '.keyvault');
  return {
    home,
    vault: path.join(home, 'vault.json'),
    backup: path.join(home, 'vault.previous.json'),
    agent: path.join(home, 'agent.json'),
    log: path.join(home, 'daemon.log'),
    sessions: path.join(home, 'sessions.json'),
  };
}

export function ensureHome() {
  const { home } = paths();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Write to a temp file, flush, then rename over the target. A crash mid-write
// can never leave a half-written vault. Retries cover Windows antivirus and
// indexers briefly holding the file open.
export function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      sleepSync(50 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw lastErr;
}

export function readVaultText() { return readText(paths().vault); }

export function writeVaultText(text) {
  const p = paths();
  ensureHome();
  // Keep the previous version alongside, so one bad save is always recoverable.
  if (fs.existsSync(p.vault)) {
    try { fs.copyFileSync(p.vault, p.backup); } catch {}
  }
  writeAtomic(p.vault, text);
}

export function vaultExists() { return fs.existsSync(paths().vault); }
