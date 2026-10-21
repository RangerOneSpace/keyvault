// Start KeyVault when you sign in to your computer. Off until you turn it on
// (Settings > Start with your computer, or `keyvault autostart on`). It only
// starts the background process: the vault stays locked until you unlock it.
//
// Windows: a value under HKCU\Software\Microsoft\Windows\CurrentVersion\Run,
//   run through conhost --headless so no console window flashes at sign-in.
// macOS:   a LaunchAgent in ~/Library/LaunchAgents.
// Linux:   an XDG autostart entry in ~/.config/autostart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { selfCommand } from './util.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE = 'KeyVault';
const MAC_LABEL = 'io.rangerone.keyvault';

const run = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err?.code }));
});

const winQuote = a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

// The command that runs at sign-in: this same program, "background".
export function launchCommand() {
  const self = selfCommand(['background']);
  return [self.command, ...self.args];
}

function linuxFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', 'keyvault.desktop');
}
function macFile() { return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`); }

export function supported() {
  return ['win32', 'darwin', 'linux'].includes(process.platform);
}

function windowsLine() {
  const conhost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
  return [conhost, '--headless', ...launchCommand()].map(winQuote).join(' ');
}

// { supported, enabled, command, current } where current says whether the
// entry starts this copy of KeyVault (an old entry may point at another one).
export async function status() {
  if (!supported()) return { supported: false, enabled: false };
  const mine = launchCommand();
  if (process.platform === 'win32') {
    const r = await run('reg.exe', ['query', RUN_KEY, '/v', VALUE]);
    if (!r.ok) return { supported: true, enabled: false };
    const m = /REG_\w+\s+(.+)\s*$/m.exec(r.stdout);
    const command = m ? m[1].trim() : '';
    return { supported: true, enabled: true, command, current: command === windowsLine() };
  }
  const file = process.platform === 'darwin' ? macFile() : linuxFile();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { supported: true, enabled: false }; }
  const current = process.platform === 'darwin' ? text === macPlist() : text === linuxDesktop();
  return { supported: true, enabled: true, command: mine.join(' '), file, current };
}

function linuxDesktop() {
  const exec = launchCommand().map(a => `"${a.replace(/(["`$\\])/g, '\\$1')}"`).join(' ');
  return ['[Desktop Entry]', 'Type=Application', 'Name=KeyVault', 'Comment=Ranger One KeyVault, started in the background at sign-in',
    `Exec=${exec}`, 'Terminal=false', 'NoDisplay=true', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

function macPlist() {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${launchCommand().map(a => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

export async function enable() {
  if (!supported()) throw new Error('Starting at sign-in is not supported on this system.');
  if (process.platform === 'win32') {
    const r = await run('reg.exe', ['add', RUN_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', windowsLine(), '/f']);
    if (!r.ok) throw new Error(`Windows did not accept the startup entry: ${(r.stderr || r.stdout).trim() || r.code}`);
  } else {
    const file = process.platform === 'darwin' ? macFile() : linuxFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, process.platform === 'darwin' ? macPlist() : linuxDesktop(), { mode: 0o644 });
  }
  return status();
}

export async function disable() {
  if (!supported()) return { supported: false, enabled: false };
  if (process.platform === 'win32') {
    const st = await status();
    if (st.enabled) {
      const r = await run('reg.exe', ['delete', RUN_KEY, '/v', VALUE, '/f']);
      if (!r.ok) throw new Error(`Could not remove the startup entry: ${(r.stderr || r.stdout).trim() || r.code}`);
    }
  } else {
    try { fs.unlinkSync(process.platform === 'darwin' ? macFile() : linuxFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return status();
}
