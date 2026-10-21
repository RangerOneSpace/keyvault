// KeyVault MCP server (stdio).
//
// Your AI tool (Claude Code, Claude Desktop, Codex, Cursor, LM Studio...) starts
// this process. It speaks MCP over stdin/stdout and forwards requests to the
// KeyVault daemon. No tool here can return a key value to the model.

import path from 'node:path';
import readline from 'node:readline';
import { ensureDaemon, agentRequest } from './client.js';
import { verifyPackage } from './package-safety.js';
import { VERSION, TYPES } from './util.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'KeyVault holds the user\'s API keys, encrypted on their own machine.',
  'You can see key names and metadata, but never the key values, and you should never ask the user to paste a key into the chat.',
  'To use keys, call write_env_file (writes them to a .env file) or run_with_secrets (runs a command with them as environment variables; values are scrubbed from output).',
  'If a key the user needs is missing, call open_vault and ask them to add it there.',
  'If a tool says the vault is locked, ask the user to unlock KeyVault in their browser, then try again.',
  'For unattended work (overnight runs, long jobs), tell the user they can start an agent pass in KeyVault: it keeps the vault available to AI tools until a time they choose, optionally limited to one project and its keys, while the KeyVault page itself still locks. Do not try to work around a locked vault.',
  'KeyVault also manages local services: list_services shows Docker containers and everything listening on a localhost port; service_logs, container_action, compose_up_with_keys and free_port act on them.',
  'KeyVault keeps the user\'s projects too, so work can be picked up where it was left. When the user wants to resume, continue or switch to a project, call get_project first: it returns where they left off, the open checklist items, the project folders (work in those folders) and recent activity.',
  'Each project has a build checklist: phases (like "FOUND foundations") holding items with an id such as RO-FOUND-001 (subtasks of an item get ids like RO-FOUND-001.1), a status (todo, in_progress, done, blocked, superseded) and an owner. When a project has no checklist, or the plan changes, fill it in with add_checklist_items. As you work, keep it current with update_checklist_items: mark an item in_progress when you start it and done when it is finished (break a big item into subtasks and tick those off, then mark the parent done), blocked with a note when stuck, superseded when the plan changed.',
  'Before proposing or installing any dependency found online or suggested by a model, call verify_package with the exact ecosystem and package name. Never use a package marked BLOCKED_BY_DATASET, even if a registry or web search says it exists. A registry match only confirms existence, not safety or trust; NOT_FOUND and UNKNOWN are not approval. Verify candidates using the canonical maintainer documentation and source before proposing or installing them. The Trend Micro reference covers Python module names only; it does not cover npm.',
  'Before a working session ends, or after finishing something meaningful, call log_progress with what was done and where to resume next. Never delete or archive a project, or replace a whole checklist, unless the user explicitly asks.',
].join(' ');

const refProps = {
  vars: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Map of ENV_VAR_NAME to a key name or key id, for example {"ANTHROPIC_API_KEY": "Anthropic Production"}.',
  },
  keys: {
    type: 'array',
    items: { type: 'string' },
    description: 'Key names or ids to use under each key\'s default env var name (the envVar field from list_keys).',
  },
};

const TOOLS = [
  {
    name: 'verify_package',
    title: 'Verify a dependency candidate',
    description: 'Check an exact PyPI or npm package name before proposing or installing it. PyPI names are checked against a pinned Trend Micro hallucinated-module dataset and then the official registry. npm is checked for registry existence only; the dataset does not cover npm. A registry match is never a safety approval. This tool does not install packages.',
    inputSchema: {
      type: 'object',
      properties: {
        ecosystem: { type: 'string', enum: ['pypi', 'npm'], description: 'Package registry ecosystem.' },
        name: { type: 'string', description: 'Exact package name as found in the proposed dependency or web source.' },
      },
      required: ['ecosystem', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'vault_status',
    title: 'KeyVault status',
    description: 'Check whether KeyVault is running and unlocked, and how many keys it holds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_keys',
    title: 'List API keys',
    description: 'List the API keys in the user\'s KeyVault: name, id, organisation, provider, type, environment, status, default env var name, expiry and notes. Never includes key values. Use write_env_file or run_with_secrets to use a key.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text filter over name, provider, notes, organisation and env var name.' },
        organisation: { type: 'string', description: 'Only keys for organisations whose name contains this text.' },
        provider: { type: 'string', description: 'Only keys whose provider contains this text, e.g. "anthropic".' },
        type: { type: 'string', enum: TYPES },
        status: { type: 'string', enum: ['active', 'rotated', 'revoked'] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'write_env_file',
    title: 'Write keys to a .env file',
    description: 'Write API keys from KeyVault into a dotenv file without the values passing through this conversation. Merges into an existing file by default (other lines are kept) and adds the file to .gitignore when it is inside a git repository. Returns only the variable names written.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Env file path. Relative paths resolve from the current working folder. Defaults to ".env".' },
        ...refProps,
        mode: { type: 'string', enum: ['merge', 'replace'], description: '"merge" (default) updates or adds only these variables. "replace" rewrites the file with only these variables.' },
        ensure_gitignore: { type: 'boolean', description: 'Add the file to .gitignore if it is not already ignored. Default true.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run_with_secrets',
    title: 'Run a command with keys',
    description: 'Run a shell command with API keys from KeyVault injected as environment variables. Any key value that appears in the output is replaced with [KEYVAULT:NAME] before you see it. Use it to call APIs or run scripts and tests that need a key. Do not try to print, transform or send key values elsewhere.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        ...refProps,
        cwd: { type: 'string', description: 'Working folder. Defaults to the current working folder.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 120.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'list_services',
    title: 'List local services',
    description: 'List Docker containers (grouped by compose project, with state and published ports) and every program listening on a TCP port on this computer (process, pid, whether it is reachable from the network or this computer only, and the page title if it serves HTTP). Works even when the vault is locked.',
    inputSchema: {
      type: 'object',
      properties: { include_system: { type: 'boolean', description: 'Also include operating system services. Default false.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'service_logs',
    title: 'Container logs',
    description: 'Read the most recent log lines from a Docker container. Any API key stored in KeyVault is replaced with [KEYVAULT:NAME] before you see it.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or id, from list_services.' },
        tail: { type: 'integer', minimum: 10, maximum: 2000, description: 'Number of lines. Default 200.' },
      },
      required: ['container'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'container_action',
    title: 'Start, stop or restart a container',
    description: 'Start, stop or restart a Docker container by name or id.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name or id, from list_services.' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'] },
      },
      required: ['container', 'action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'compose_up_with_keys',
    title: 'Start a compose project with its keys',
    description: 'Run "docker compose up -d" for a compose project, injecting the API keys the user linked to that project in KeyVault as environment variables (for ${VAR} references in the compose file). Output is scrubbed of key values.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Compose project name, from list_services.' } },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'free_port',
    title: 'Free up a port',
    description: 'Stop the program listening on a TCP port on this computer, for example a dev server left running on port 3000. Refuses Docker containers (use container_action) and operating system services.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 1, maximum: 65535 } },
      required: ['port'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List the user\'s projects in KeyVault, most recently worked on first: name, status, organisation, folders, where they left off (short) and the next open step. Archived projects are hidden unless status is "archived".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by text in the name, summary or organisation.' },
        status: { type: 'string', enum: ['active', 'paused', 'done', 'archived'] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_project',
    title: 'Resume a project',
    description: 'Get the full brief for a project so you can pick it up where the user left off: summary, where they left off, the open checklist items by phase, folders (with git branch, uncommitted changes and last commit), links, the keys linked to it (names only) and recent activity. Use the folder paths as the place to work.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project name (or part of it) or id.' } },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_project',
    title: 'Create a project',
    description: 'Create a project in KeyVault, for example for the folder you are working in. Folders must be full paths that exist on this computer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        summary: { type: 'string', description: 'One or two sentences on what the project is.' },
        folders: { type: 'array', items: { type: 'string' }, description: 'Full folder paths. Defaults to the current working folder.' },
        checklist: { type: 'array', description: 'Optional starting checklist, see add_checklist_items.', items: { type: 'object', properties: { phase: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, owner: { type: 'string' } }, required: ['title'] } },
        next_steps: { type: 'array', items: { type: 'string' }, description: 'Simple list of to-dos (added to a "Next steps" phase).' },
        resume: { type: 'string', description: 'Where things stand right now.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'update_project',
    title: 'Update a project',
    description: 'Change a project: rename it, set its status, rewrite the summary or "where I left off", or add folders. Only the fields you pass change. For checklist items use add_checklist_items and update_checklist_items. Cannot delete a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (or part of it) or id.' },
        name: { type: 'string', description: 'New name.' },
        status: { type: 'string', enum: ['active', 'paused', 'done', 'archived'] },
        summary: { type: 'string' },
        resume: { type: 'string', description: 'Replace "where I left off".' },
        add_folders: { type: 'array', items: { type: 'string' } },
        add_next_steps: { type: 'array', items: { type: 'string' }, description: 'Shortcut: add simple items to the "Next steps" phase.' },
        complete_next_steps: { type: 'array', items: { type: 'string' }, description: 'Shortcut: mark checklist items done, by id or title.' },
        note: { type: 'string', description: 'Optional line for the activity log explaining the change.' },
        confirm_archive: { type: 'boolean', description: 'Required to archive. Only when the user asked.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'get_checklist',
    title: 'Read a project checklist',
    description: 'Get a project\'s full build checklist, grouped by phase: every item\'s id (like RO-FOUND-001), title, status, owner and notes, plus totals. Filter by phase or status if the list is long.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (or part of it) or id.' },
        phase: { type: 'string', description: 'Phase code or name, optional.' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked', 'superseded'] },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'add_checklist_items',
    title: 'Add to a project checklist',
    description: 'Add phases and items to a project\'s build checklist. Use it to write the plan for a new project (break the work into phases, each with concrete items) or to add work you discover. Each item gets an id like KEY-PHASE-001. To break an item into steps, give it subtasks (they get ids like KEY-PHASE-001.1), or add a subtask to an existing item by setting parent to that item\'s id. Phases are created when first named. Set replace with confirm_replace only when the user asks to start the checklist over.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (or part of it) or id.' },
        phases: { type: 'array', description: 'Phases to create, in order. Optional: phases named by items are created too.', items: { type: 'object', properties: { name: { type: 'string', description: 'e.g. "Phase 0: website and logo"' }, code: { type: 'string', description: 'Short code used in item ids, e.g. "WEB". Letters and digits, up to 8.' } }, required: ['name'] } },
        items: { type: 'array', items: { type: 'object', properties: {
          phase: { type: 'string', description: 'Phase name or code.' },
          parent: { type: 'string', description: 'Make this a subtask of an existing item (its id, e.g. RO-FOUND-001). The phase is taken from the parent.' },
          title: { type: 'string', description: 'One concrete piece of work.' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked', 'superseded'] },
          owner: { type: 'string', description: 'Who does it, e.g. "human", "claude", "human+claude".' },
          notes: { type: 'string' },
          subtasks: { type: 'array', description: 'Smaller steps of this item, in order. One level only.', items: { type: 'object', properties: {
            title: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked', 'superseded'] },
            owner: { type: 'string' },
            notes: { type: 'string' },
          }, required: ['title'] } },
        }, required: ['title'] } },
        replace: { type: 'boolean', description: 'Delete the existing checklist first. Needs confirm_replace.' },
        confirm_replace: { type: 'boolean', description: 'Only when the user asked to start the checklist over.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'update_checklist_items',
    title: 'Update checklist items',
    description: 'Change items on a project\'s checklist: status (todo, in_progress, done, blocked, superseded), owner, notes, title, phase, or parent (make it a subtask of another item, or an empty string to make a subtask a normal item again). Refer to items by id (RO-FOUND-001, FOUND-001 or a subtask such as FOUND-001.2) or by title. Mark items done as you finish them so the user and the next session see real progress.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (or part of it) or id.' },
        updates: { type: 'array', items: { type: 'object', properties: {
          item: { type: 'string', description: 'Item id or title.' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked', 'superseded'] },
          owner: { type: 'string' },
          notes: { type: 'string', description: 'Replaces the item notes, e.g. why it is blocked.' },
          title: { type: 'string' },
          phase: { type: 'string', description: 'Move to this phase (name or code). Subtasks move with their parent.' },
          parent: { type: 'string', description: 'Item id to nest this under as a subtask, or "" to un-nest it.' },
        }, required: ['item'] } },
      },
      required: ['project', 'updates'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'log_progress',
    title: 'Log progress on a project',
    description: 'Record what was done in this session on a project, and optionally update "where I left off" so the next session (with any AI tool, or the user) can resume straight away.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (or part of it) or id.' },
        done: { type: 'string', description: 'What was done, in a sentence or two.' },
        resume: { type: 'string', description: 'Where to pick up next time. Replaces the current "where I left off".' },
      },
      required: ['project', 'done'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'open_project',
    title: 'Open a project folder',
    description: 'Open a project\'s folder on the user\'s computer: in the file explorer, VS Code, Cursor or a terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        with: { type: 'string', enum: ['folder', 'vscode', 'cursor', 'terminal'], description: 'Default "folder".' },
        folder: { type: 'integer', minimum: 0, description: 'Which folder, if the project has several (0 = first).' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'open_vault',
    title: 'Open KeyVault',
    description: 'Open KeyVault in the user\'s browser so they can unlock it, or add, edit or rotate a key themselves. Use this whenever a needed key is missing instead of asking for it in chat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

let clientName = 'AI tool';
let lastAutoOpen = 0;

class ToolError extends Error {}

async function lockedMessage(agent) {
  let opened = false;
  if (Date.now() - lastAutoOpen > 30 * 60_000) {   // at most once every 30 minutes, so an unattended run does not keep opening tabs
    lastAutoOpen = Date.now();
    try { opened = (await agentRequest(agent, 'POST', '/agent/open', {})).body?.opened; } catch {}
  }
  return opened
    ? 'KeyVault is locked. I opened the unlock page in the user\'s browser. Ask the user to unlock KeyVault, then try again. For unattended work they can start an agent pass in KeyVault.'
    : 'KeyVault is locked. Ask the user to unlock it (run "keyvault" in a terminal to open it), then try again. For unattended work they can start an agent pass in KeyVault.';
}

async function call(agent, method, pathname, body, timeoutMs) {
  const r = await agentRequest(agent, method, pathname, body, timeoutMs);
  if (r.status === 423) throw new ToolError(await lockedMessage(agent));
  if (r.status !== 200) throw new ToolError(r.body?.error || `KeyVault returned HTTP ${r.status}`);
  return r.body;
}

const cwdOf = p => (p ? path.resolve(process.cwd(), p) : process.cwd());

async function callTool(name, args = {}) {
  if (name === 'verify_package') {
    const result = await verifyPackage({ ecosystem: args.ecosystem, name: args.name });
    const details = [
      `Decision: ${result.status}`,
      `Ecosystem: ${result.ecosystem}`,
      `Package: ${result.name}`,
      `Reference coverage: ${result.corpusCoverage}`,
      result.version ? `Registry version: ${result.version}` : '',
      result.source ? `Dataset: ${result.source}` : '',
      result.evidence?.length ? `Matching records: ${JSON.stringify(result.evidence)}` : '',
      result.message,
    ].filter(Boolean);
    return details.join('\n');
  }

  const agent = await ensureDaemon();

  if (name === 'vault_status') {
    const s = await call(agent, 'GET', '/agent/status');
    if (s.state === 'unlocked') {
      const pass = s.pass ? ` An agent pass keeps it available to you until ${s.pass.until}${s.pass.limitedTo ? `, limited to the project "${s.pass.limitedTo}" and its keys` : ''}.` : '';
      return `KeyVault ${s.version} is unlocked and ${s.pass?.limitedTo ? 'gives you' : 'holds'} ${s.keys} key${s.keys === 1 ? '' : 's'}.${pass}`;
    }
    if (s.state === 'locked') return `KeyVault ${s.version} is running but locked. Call open_vault or ask the user to unlock it.`;
    return `KeyVault ${s.version} is running but no vault has been created yet. Call open_vault so the user can set one up.`;
  }

  if (name === 'list_keys') {
    const q = new URLSearchParams();
    if (args.query) q.set('q', args.query);
    if (args.organisation) q.set('org', args.organisation);
    if (args.provider) q.set('provider', args.provider);
    if (args.type) q.set('type', args.type);
    if (args.status) q.set('status', args.status);
    const r = await call(agent, 'GET', `/agent/keys?${q}`);
    const head = `${r.keys.length} of ${r.total} key${r.total === 1 ? '' : 's'} (values are never shown).`;
    return `${head}\n${JSON.stringify(r.keys, null, 2)}`;
  }

  if (name === 'write_env_file') {
    const file = cwdOf(args.path || '.env');
    const r = await call(agent, 'POST', '/agent/env', {
      path: file, vars: args.vars, keys: args.keys, mode: args.mode,
      ensureGitignore: args.ensure_gitignore !== false, client: clientName,
    });
    const git = {
      'added': `Added ${r.git.entry} to ${r.git.gitignore}.`,
      'already-ignored': 'The file is already ignored by git.',
      'not-a-git-repo': 'The folder is not inside a git repository.',
      'skipped': 'Did not check .gitignore.',
      'unknown': r.git.note,
    }[r.git.status] || '';
    return `Wrote ${r.written.join(', ')} to ${r.file}. ${git}`.trim();
  }

  if (name === 'run_with_secrets') {
    const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 120, 1), 600);
    const r = await call(agent, 'POST', '/agent/run', {
      command: args.command, cwd: cwdOf(args.cwd), env: process.env,
      vars: args.vars, keys: args.keys, timeoutSec, client: clientName,
    }, (timeoutSec + 30) * 1000);
    const parts = [
      r.timedOut ? `Timed out after ${timeoutSec}s and was stopped.` : `Exit code: ${r.exitCode ?? 'none'}${r.signal ? ` (signal ${r.signal})` : ''}`,
      r.stdout ? `--- stdout ---\n${r.stdout}` : '--- stdout: (empty) ---',
      r.stderr ? `--- stderr ---\n${r.stderr}` : '',
      r.truncated ? '(output was truncated to 64 KB per stream)' : '',
    ];
    return parts.filter(Boolean).join('\n');
  }

  if (name === 'list_services') {
    const r = await call(agent, 'GET', `/agent/services${args.include_system ? '?system=1' : ''}`);
    const lines = [];
    lines.push(r.docker.available ? `Docker ${r.docker.version || ''}: ${r.containers.length} container(s).` : `Docker unavailable: ${r.docker.error}`);
    if (r.portsError) lines.push(r.portsError);
    lines.push(JSON.stringify({ containers: r.containers, ports: r.ports }, null, 2));
    return lines.join('\n');
  }

  if (name === 'service_logs') {
    const q = new URLSearchParams({ ref: String(args.container || ''), tail: String(args.tail || 200) });
    const r = await call(agent, 'GET', `/agent/services/logs?${q}`);
    return r.logs || '(no log output)';
  }

  if (name === 'container_action') {
    const r = await call(agent, 'POST', '/agent/services/container', { ref: args.container, action: args.action, client: clientName });
    return r.changed === false ? `${args.container} was already ${args.action === 'start' ? 'running' : 'stopped'}.` : `Done: ${args.action} ${args.container}.`;
  }

  if (name === 'compose_up_with_keys') {
    const r = await call(agent, 'POST', '/agent/services/compose-up', { project: args.project, client: clientName }, 330_000);
    return [
      r.timedOut ? 'Timed out and was stopped.' : `Exit code: ${r.exitCode ?? 'none'}`,
      r.stdout ? `--- stdout ---\n${r.stdout}` : '',
      r.stderr ? `--- stderr ---\n${r.stderr}` : '',
    ].filter(Boolean).join('\n');
  }

  if (name === 'free_port') {
    const r = await call(agent, 'POST', '/agent/services/free-port', { port: args.port, client: clientName });
    if (r.message) return r.message;
    return `Stopped ${r.stopped.map(s => `${s.process || 'process'} (pid ${s.pid})`).join(', ')}. Port ${args.port} is free.`;
  }

  if (name === 'list_projects') {
    const q = new URLSearchParams();
    if (args.query) q.set('q', args.query);
    if (args.status) q.set('status', args.status);
    const r = await call(agent, 'GET', `/agent/projects?${q}`);
    if (!r.projects.length) return r.total ? 'No projects match. Try without a filter, or status "archived".' : 'No projects yet. Create one with create_project, or the user can add them in KeyVault > Projects.';
    return `${r.projects.length} project${r.projects.length === 1 ? '' : 's'} (most recently worked on first):\n${JSON.stringify(r.projects, null, 2)}`;
  }

  if (name === 'get_project') {
    const r = await call(agent, 'GET', `/agent/project?${new URLSearchParams({ ref: String(args.project || '') })}`);
    return r.brief;
  }

  if (name === 'create_project') {
    const r = await call(agent, 'POST', '/agent/projects', {
      name: args.name, summary: args.summary, resume: args.resume,
      folders: (args.folders && args.folders.length ? args.folders : [process.cwd()]).map(f => cwdOf(f)),
      items: args.checklist || [], next: args.next_steps || [], client: clientName,
    });
    return `Created project "${r.project.name}" with folder${r.project.folders.length === 1 ? '' : 's'} ${r.project.folders.join(', ') || '(none)'}. Checklist: ${r.project.checklist}.`;
  }

  if (name === 'update_project') {
    const r = await call(agent, 'POST', '/agent/project/update', {
      ref: args.project, name: args.name, status: args.status, summary: args.summary, resume: args.resume,
      add_folders: args.add_folders?.map(f => cwdOf(f)), add_next: args.add_next_steps, complete_next: args.complete_next_steps,
      note: args.note, confirm_archive: args.confirm_archive, client: clientName,
    });
    return `Updated "${r.project.name}" (${r.project.status}). Checklist: ${r.project.checklist}${r.project.nextItem ? `. Next: ${r.project.nextItem}` : ''}.`;
  }

  if (name === 'get_checklist') {
    const q = new URLSearchParams({ ref: String(args.project || '') });
    if (args.phase) q.set('phase', args.phase);
    if (args.status) q.set('status', args.status);
    const r = await call(agent, 'GET', `/agent/project/checklist?${q}`);
    const s = r.stats;
    if (!s.total) return `"${r.project}" has no checklist yet. Write one with add_checklist_items.`;
    return `${r.project} checklist (subtasks list their parent item id): ${s.done} of ${s.total - s.superseded} done, ${s.in_progress} in progress, ${s.blocked} blocked, ${s.todo} to do, ${s.superseded} superseded.\n${JSON.stringify(r.phases, null, 2)}`;
  }

  if (name === 'add_checklist_items') {
    const r = await call(agent, 'POST', '/agent/project/checklist', {
      ref: args.project, phases: args.phases || [], items: args.items || [],
      replace: !!args.replace, confirm_replace: !!args.confirm_replace, client: clientName,
    });
    return `Added ${r.added.length} item${r.added.length === 1 ? '' : 's'}:\n${r.added.map(i => `${i.id} ${i.title} (${i.status})`).join('\n')}\nChecklist now ${r.stats.total} items, ${r.stats.done} done.`;
  }

  if (name === 'update_checklist_items') {
    const r = await call(agent, 'POST', '/agent/project/checklist/update', { ref: args.project, updates: args.updates || [], client: clientName });
    const lines = r.changed.map(i => `${i.id} ${i.title}: ${i.status}${i.owner ? ` (${i.owner})` : ''}`);
    if (r.missing.length) lines.push(`Not found: ${r.missing.join(', ')}. Call get_checklist for the ids.`);
    return `${lines.join('\n')}\nChecklist: ${r.stats.done} of ${r.stats.total - r.stats.superseded} done.`;
  }

  if (name === 'log_progress') {
    const r = await call(agent, 'POST', '/agent/project/log', { ref: args.project, text: args.done, resume: args.resume, client: clientName });
    return `Logged progress on "${r.project.name}".${args.resume ? ' "Where I left off" is updated.' : ''}`;
  }

  if (name === 'open_project') {
    const r = await call(agent, 'POST', '/agent/project/open', { ref: args.project, how: args.with || 'folder', folder: args.folder || 0, client: clientName });
    return r.opened ? `Opened ${r.dir} (${r.how}).` : `Did not open ${r.dir}: ${r.note || 'not available'}.`;
  }

  if (name === 'open_vault') {
    const r = await call(agent, 'POST', '/agent/open', {});
    return r.opened
      ? 'Opened KeyVault in the user\'s browser.'
      : 'Could not open a browser automatically. Ask the user to run "keyvault" in a terminal.';
  }

  throw new ToolError(`Unknown tool: ${name}`);
}

export function runMcpServer() {
  const write = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize': {
          clientName = String(params?.clientInfo?.name || clientName).slice(0, 60);
          const pv = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
          return ok(id, {
            protocolVersion: pv,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'keyvault', title: 'KeyVault', version: VERSION },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping': return ok(id, {});
        case 'tools/list': return ok(id, { tools: TOOLS });
        case 'tools/call': {
          try {
            const text = await callTool(params?.name, params?.arguments || {});
            return ok(id, { content: [{ type: 'text', text }] });
          } catch (e) {
            return ok(id, { content: [{ type: 'text', text: e.message || String(e) }], isError: true });
          }
        }
        default:
          if (typeof method === 'string' && method.startsWith('notifications/')) return;
          if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      if (isRequest) fail(id, -32603, e.message || 'Internal error');
    }
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
  });
  rl.on('close', () => process.exit(0));
}
