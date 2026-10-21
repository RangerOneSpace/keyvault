// GitHub search for the Projects tab: find a repo (your own, private ones
// included, or anywhere on GitHub), see whether it is already on this
// computer, and clone it into a folder. Only runs when you search: KeyVault
// makes no requests to GitHub otherwise.
//
// Private repos need a GitHub token stored in the vault (a key whose variable
// is GITHUB_TOKEN, GH_TOKEN or GITHUB_PAT, or whose provider is GitHub). The
// token is only ever sent to api.github.com and, for a clone, to github.com,
// and git gets it through environment variables, never the command line or
// the repo's config.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { checkFolder, scanForRepos, defaultScanRoots } from './projects.js';

const API = () => process.env.KEYVAULT_GITHUB_API || 'https://api.github.com';
const WEB = () => process.env.KEYVAULT_GITHUB_WEB || 'https://github.com';
const TOKEN_VARS = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT', 'GITHUB_PERSONAL_ACCESS_TOKEN'];

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function findToken(keys = []) {
  const live = keys.filter(k => k.status !== 'revoked' && k.value);
  const k = live.find(x => TOKEN_VARS.includes(String(x.envVar || '').toUpperCase()))
    || live.find(x => /github/i.test(x.provider || '') || /github/i.test(x.name || ''));
  return k ? { value: k.value, name: k.name } : null;
}

async function gh(pathname, token) {
  let res;
  try {
    res = await fetch(`${API()}${pathname}`, {
      headers: {
        accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'KeyVault (Ranger One)',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GitHubError(502, 'Could not reach GitHub. Check your internet connection.');
  }
  if (res.status === 401) throw new GitHubError(400, 'GitHub did not accept the token in your vault. It may have expired: update it in Keys.');
  if (res.status === 403 || res.status === 429) {
    throw new GitHubError(429, token ? 'GitHub rate limit reached. Try again in a minute.' : 'GitHub limits searches without a token. Add a GitHub token to the vault (variable GITHUB_TOKEN) for more searches and your private repos.');
  }
  if (!res.ok) throw new GitHubError(502, `GitHub answered ${res.status}.`);
  return res.json();
}

const shape = r => ({
  fullName: r.full_name, name: r.name, owner: r.owner?.login || '',
  description: r.description || '', private: !!r.private, fork: !!r.fork, archived: !!r.archived,
  url: r.html_url, cloneUrl: r.clone_url, language: r.language || '', stars: r.stargazers_count || 0,
  pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : 0,
});

// scope "mine": your repos (owner, collaborator and your organisations'), filtered by q.
// scope "all": GitHub's repository search.
export async function search({ q = '', scope = 'mine', token = null } = {}) {
  q = String(q || '').trim().slice(0, 200);
  if (scope === 'mine') {
    if (!token) throw new GitHubError(400, 'To list your own repos, private ones included, add a GitHub token to the vault with the variable name GITHUB_TOKEN. You can still search all of GitHub without one.');
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await gh(`/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`, token);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.map(shape).filter(r => words.every(w => `${r.fullName} ${r.description} ${r.language}`.toLowerCase().includes(w)));
  }
  if (!q) throw new GitHubError(400, 'Type something to search for.');
  const r = await gh(`/search/repositories?q=${encodeURIComponent(q)}&per_page=30`, token);
  return (r.items || []).map(shape);
}

// Where each GitHub repo already lives on this computer, from the origin
// remotes of the repos under your code folders (read from .git/config, no git run).
export function localClones(roots = defaultScanRoots()) {
  const map = new Map();
  for (const r of scanForRepos(roots, 500)) {
    let cfg = '';
    try { cfg = fs.readFileSync(path.join(r.path, '.git', 'config'), 'utf8'); } catch { continue; }
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
    const full = m && repoFromRemote(m[1]);
    if (full && !map.has(full)) map.set(full, r.path);
  }
  return map;
}

// "owner/repo" (lowercase) from any github.com remote or web URL.
export function repoFromRemote(u) {
  const s = String(u || '').trim();
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(s);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// Clone owner/repo into parent/<repo>. Returns the new folder.
export function clone({ fullName, parent, folderName, token = null }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(fullName || '')) || /\.\./.test(fullName)) throw new GitHubError(400, 'That is not a GitHub repo name.');
  const p = checkFolder(parent);
  if (!p.ok) throw new GitHubError(400, p.error || 'Choose the folder to clone into.');
  const name = String(folderName || fullName.split('/')[1]).trim();
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new GitHubError(400, 'The folder name can only use letters, numbers, dots, dashes and underscores.');
  const dest = path.join(p.path, name);
  if (fs.existsSync(dest)) throw new GitHubError(409, `${dest} already exists. Link that folder instead, or pick another name.`);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (token) {
    // Basic auth header for github.com only, given to this one git process.
    const n = Number(env.GIT_CONFIG_COUNT) || 0;
    env.GIT_CONFIG_COUNT = String(n + 1);
    env[`GIT_CONFIG_KEY_${n}`] = `http.${WEB()}/.extraheader`;
    env[`GIT_CONFIG_VALUE_${n}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  const url = `${WEB()}/${fullName}.git`;
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.fsmonitor=false', 'clone', '--', url, dest],
      { env, cwd: p.path, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve(dest);
        if (err.code === 'ENOENT') return reject(new GitHubError(400, 'Git is not installed. Install it from git-scm.com, then try again.'));
        const msg = String(stderr || err.message).split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^Cloning into/.test(s)).pop() || 'git clone failed';
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
        reject(new GitHubError(400, /not found|could not read Username|Authentication failed/i.test(msg)
          ? `GitHub would not let KeyVault clone ${fullName}. ${token ? 'Check the token in your vault can read this repo.' : 'If it is private, add a GitHub token to the vault (variable GITHUB_TOKEN).'}`
          : msg.replace(/AUTHORIZATION:\s*basic\s+\S+/gi, '[token]').slice(0, 300)));
      });
  });
}
