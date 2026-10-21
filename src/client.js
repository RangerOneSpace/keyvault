// Talking to the running daemon from the CLI and the MCP server.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { paths, ensureHome } from './store.js';
import { selfCommand } from './util.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function readAgentFile() {
  try { return JSON.parse(fs.readFileSync(paths().agent, 'utf8')); } catch { return null; }
}

export function agentRequest(agent, method, pathname, body, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: agent.port, method, path: pathname, timeout: timeoutMs,
      headers: {
        host: `127.0.0.1:${agent.port}`,
        authorization: `Bearer ${agent.token}`,
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('KeyVault did not respond in time')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export async function liveAgent() {
  const a = readAgentFile();
  if (!a || !a.port || !a.token) return null;
  try {
    const r = await agentRequest(a, 'GET', '/agent/status', null, 2000);
    if (r.status === 200) return a;
  } catch {}
  return null;
}

export async function ensureDaemon() {
  let a = await liveAgent();
  if (a) return a;
  ensureHome();
  const self = selfCommand(['serve', '--no-open', '--background']);
  const child = spawn(self.command, self.args, {
    detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  child.unref();
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    await sleep(200);
    a = await liveAgent();
    if (a) return a;
  }
  throw new Error(`KeyVault did not start. Run "keyvault serve" in a terminal to see why, or check ${paths().log}`);
}

// Single-instance guard for the daemon process.
export function acquireDaemonLock() {
  const lockFile = path.join(ensureHome(), 'daemon.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      const release = () => {
        try { if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockFile); } catch {}
      };
      process.on('exit', release);
      // Heartbeat: a live daemon keeps its lock fresh, so only a genuinely
      // abandoned lock ever looks older than the 30 second stale limit.
      setInterval(() => {
        try {
          if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) { const now = new Date(); fs.utimesSync(lockFile, now, now); }
        } catch {}
      }, 10_000).unref();
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0; let age = Infinity;
      try { pid = Number(fs.readFileSync(lockFile, 'utf8').trim()); age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch {}
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; } }
      // A daemon that is really starting writes agent.json within a second or
      // two. An old lock whose pid is "alive" is usually a reused pid after a
      // crash or reboot (common on Windows), so treat it as stale.
      if (alive && age < 30_000) return false;
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
  return false;
}
