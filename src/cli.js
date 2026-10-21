import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';
import { VERSION, IS_SEA } from './util.js';
import { liveAgent, ensureDaemon, agentRequest, acquireDaemonLock } from './client.js';
import { connectSnippets } from './connect.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function help() {
  return `KeyVault ${VERSION} by Ranger One
A local, encrypted API key vault that your AI tools can use without seeing your keys.

Usage:
  keyvault               Open KeyVault (starts it in the background if needed)
  keyvault status        Show whether KeyVault is running and unlocked
  keyvault lock          Lock the vault now
  keyvault stop          Stop KeyVault
  keyvault autostart [on|off]
                         Start KeyVault in the background when you sign in
  keyvault background    Start KeyVault in the background without opening it
  keyvault config [app]  Print setup for your AI tools
                         (claude-code, claude-desktop, codex, cursor, lm-studio)
  keyvault mcp           Run the MCP server (your AI tool starts this, not you)
  keyvault serve         Run KeyVault in this window instead (for troubleshooting)
  keyvault --version

Vault folder: ${paths().home}
Change it by setting the KEYVAULT_HOME environment variable.`;
}

function waitForEnter(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY && !IS_SEA) return resolve('');
    if (prompt) process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', line => { rl.close(); resolve(line); });
    rl.once('close', () => resolve(''));
  });
}

// A running KeyVault from an OLDER version is replaced, so an update takes
// effect as soon as you open the new one. A NEWER one is kept: opening an old
// copy of KeyVault.exe (a forgotten download, a backup) must never downgrade you.
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
async function runningAgent() {
  const a = await liveAgent();
  if (!a) return null;
  const st = (await agentRequest(a, 'GET', '/agent/status').catch(() => null))?.body;
  if (st && (st.version === VERSION || newer(st.version, VERSION))) return a;
  await stopRunning();
  return null;
}

async function stopRunning() {
  const a = await liveAgent();
  if (a) {
    await agentRequest(a, 'POST', '/agent/shutdown', {}).catch(() => {});
    for (let i = 0; i < 50 && await liveAgent(); i++) await sleep(100);
  }
  // Wait for the old process to exit and release its lock.
  const lock = path.join(paths().home, 'daemon.lock');
  for (let i = 0; i < 50 && fs.existsSync(lock); i++) await sleep(100);
}

// Run KeyVault in this window. Used by the exe when you double-click it, and
// by `keyvault serve`. The window shows a login link in case the browser does
// not open by itself.
async function serveHere({ open, background }) {
  if (!acquireDaemonLock()) {
    if (!background) console.log('Another KeyVault is starting. Try again in a few seconds.');
    return false;
  }
  const { startDaemon } = await import('./daemon.js');
  const d = await startDaemon({ open, logFile: paths().log });
  if (background) return true;
  process.title = 'KeyVault';
  const link = () => d.makeLoginUrl();
  console.log('');
  console.log(`  KeyVault ${VERSION} by Ranger One`);
  console.log('  Running in this window (troubleshooting mode). Closing it stops KeyVault.');
  console.log('  Normally just double-click KeyVault.exe: it runs in the background instead.');
  console.log('');
  if (open) console.log('  Your browser should open now. If it does not, paste this link into it.');
  else console.log('  Paste this link into your browser.');
  console.log('  It works once, within 2 minutes:');
  console.log('');
  console.log(`    ${link()}`);
  console.log('');
  console.log('  Press Enter for a fresh link.');
  process.stdin.on('data', () => {
    console.log(`\n    ${link()}\n`);
  });
  return true;
}

async function openUi() {
  // Always run KeyVault as a hidden background process, so closing this
  // window (or the terminal) never stops it or locks the vault.
  const agent = (await runningAgent()) || await ensureDaemon();
  const r = await agentRequest(agent, 'POST', '/agent/open', {});

  if (r.body?.opened) {
    console.log(`KeyVault is running in the background on http://127.0.0.1:${agent.port}`);
    console.log('Opening it in your browser now. You can close this window.');
    if (IS_SEA) await sleep(1500);   // long enough to read, then the window closes itself
    else console.log('\nTip: run "keyvault config" to connect Claude, Codex, Cursor and other AI tools.');
    return;
  }

  // No browser could be opened: fall back to running here with a login link to paste.
  console.log('Could not open a browser automatically.');
  if (IS_SEA) {
    await stopRunning();
    await serveHere({ open: false, background: false });
    return;
  }
  console.log('To get a login link you can paste yourself, run:');
  console.log('  keyvault stop');
  console.log('  keyvault serve');
}

export async function main(argv) {
  const [cmd = 'open', ...rest] = argv;
  switch (cmd) {
    case 'open':
    case 'start':
      return openUi();

    case 'serve': {
      const background = rest.includes('--background');
      if (await runningAgent()) {
        if (!background) console.log('KeyVault is already running. Use "keyvault stop" first, then "keyvault serve".');
        return;
      }
      await serveHere({ open: !rest.includes('--no-open'), background });
      return;
    }

    // Used at sign-in: make sure KeyVault is running, open nothing, exit.
    case 'background': {
      try { (await runningAgent()) || await ensureDaemon(); }
      catch (e) { console.error(e.message); process.exitCode = 1; }
      return;
    }

    case 'autostart': {
      const as = await import('./autostart.js');
      const want = rest[0];
      try {
        const st = want === 'on' ? await as.enable() : want === 'off' ? await as.disable() : await as.status();
        if (!st.supported) console.log('Starting at sign-in is not supported on this system.');
        else if (st.enabled) console.log(`KeyVault starts in the background when you sign in.${st.current === false ? ' (The entry points at another copy of KeyVault. Run "keyvault autostart on" from the copy you use.)' : ''}`);
        else console.log('KeyVault does not start at sign-in. Turn it on with: keyvault autostart on');
      } catch (e) { console.error(e.message); process.exitCode = 1; }
      if (IS_SEA && !want) await waitForEnter('Press Enter to close.');
      return;
    }

    case 'mcp': {
      const { runMcpServer } = await import('./mcp.js');
      return runMcpServer();
    }

    case 'status': {
      const a = await liveAgent();
      if (!a) { console.log('KeyVault is not running. Start it with: keyvault'); return; }
      const r = await agentRequest(a, 'GET', '/agent/status');
      const s = r.body;
      const state = { unlocked: `unlocked (${s.keys} keys)`, locked: 'locked', none: 'running, no vault created yet' }[s.state];
      console.log(`KeyVault ${s.version}: ${state}. Process ${s.pid}, port ${a.port}.`);
      console.log(`Vault file: ${paths().vault}`);
      return;
    }

    case 'lock': {
      const a = await liveAgent();
      if (!a) { console.log('KeyVault is not running.'); return; }
      await agentRequest(a, 'POST', '/agent/lock', {});
      console.log('Locked.');
      return;
    }

    case 'stop': {
      if (!await liveAgent()) { console.log('KeyVault is not running.'); return; }
      await stopRunning();
      console.log('Stopped.');
      return;
    }

    case 'config': {
      const want = rest[0];
      const clients = connectSnippets().filter(c => !want || c.id === want);
      if (!clients.length) { console.error(`Unknown app "${want}". Try: ${connectSnippets().map(c => c.id).join(', ')}`); process.exitCode = 1; return; }
      for (const c of clients) console.log(`\n## ${c.name}\n${c.how}\n\n${c.snippet}\n`);
      if (IS_SEA) await waitForEnter('Press Enter to close.');
      return;
    }

    case '-v':
    case '--version':
    case 'version':
      console.log(VERSION);
      return;

    case '-h':
    case '--help':
    case 'help':
      console.log(help());
      if (IS_SEA) await waitForEnter('\nPress Enter to close.');
      return;

    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(help());
      process.exitCode = 1;
  }
}
