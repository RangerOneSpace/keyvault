import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import BUILD from './build-info.js';

// True inside the standalone KeyVault executable (Node single executable app).
export const IS_SEA = !!BUILD?.sea;

export const VERSION = BUILD?.version ?? JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version;

// How to run KeyVault itself with some arguments: the exe runs directly,
// the npm install runs `node bin/keyvault.js`.
export function selfCommand(args) {
  if (IS_SEA) return { command: process.execPath, args };
  return { command: process.execPath, args: [fileURLToPath(new URL('../bin/keyvault.js', import.meta.url)), ...args] };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function uid() {
  return crypto.randomBytes(12).toString('hex');
}

export function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

export function openBrowser(url) {
  if (process.env.KEYVAULT_NO_BROWSER) return false;
  try {
    let cmd; let args;
    if (process.platform === 'win32') {
      // `start` via cmd is the most dependable way to reach the default browser.
      // The URL is ours (127.0.0.1, base64url token), so it contains no quotes or &.
      const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "" "${url}""`], {
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      });
      p.on('error', () => { try { spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref(); } catch {} });
      p.on('exit', code => { if (code) { try { spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref(); } catch {} } });
      p.unref();
      return true;
    }
    if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else { cmd = 'xdg-open'; args = [url]; }
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

export const TYPES = ['LLM', 'Cloud', 'Database', 'Payments', 'Service', 'Other'];
export const ENVS = ['Production', 'Staging', 'Development', 'Personal'];
export const STATUSES = ['active', 'rotated', 'revoked'];
// Organisation colours chosen to read well on Ranger One navy.
export const PALETTE = ['#0074D9', '#3DDC97', '#FFB020', '#9B7BFF', '#22B8CF', '#FF6B6B', '#5CB3FF', '#E879F9', '#A3E635', '#F8FAFC'];
