// Ready-to-paste config for connecting AI tools to the KeyVault MCP server.
// Uses absolute paths to node and to this install, which works on Windows,
// macOS and Linux without relying on PATH inside GUI apps.

import os from 'node:os';
import path from 'node:path';
import { selfCommand } from './util.js';

export function mcpCommand() {
  return selfCommand(['mcp']);
}

function tomlString(s) {
  // Literal strings keep Windows backslashes intact.
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\-./:\\]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

export function connectSnippets() {
  const { command, args } = mcpCommand();
  const jsonBlock = JSON.stringify({ mcpServers: { keyvault: { command, args } } }, null, 2);
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  const claudeDesktopPath = isWin
    ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : isMac
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      how: 'Run this once in any terminal. It makes KeyVault available in every project.',
      lang: 'shell',
      snippet: `claude mcp add keyvault --scope user -- ${shellQuote(command)} ${args.map(shellQuote).join(' ')}`,
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      how: `Open Settings > Developer > Edit Config (the file is ${claudeDesktopPath}). Add the "keyvault" entry inside "mcpServers", save, then fully quit and reopen Claude.`,
      lang: 'json',
      snippet: jsonBlock,
    },
    {
      id: 'codex',
      name: 'OpenAI Codex CLI',
      how: `Add this to ${path.join(home, '.codex', 'config.toml')}, then restart Codex.`,
      lang: 'toml',
      snippet: `[mcp_servers.keyvault]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n`,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      how: `Add this to ${path.join(home, '.cursor', 'mcp.json')} (or Settings > MCP > Add new server), then reload Cursor.`,
      lang: 'json',
      snippet: jsonBlock,
    },
    {
      id: 'lm-studio',
      name: 'LM Studio and other MCP clients',
      how: 'Most MCP clients, including LM Studio for local models, use this same "mcpServers" format. Paste it into the client\'s MCP config file.',
      lang: 'json',
      snippet: jsonBlock,
    },
  ];
}
