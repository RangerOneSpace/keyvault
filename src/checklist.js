// Project checklists: phases of items with an ID, a status and an owner,
// like a build checklist. You and your AI tools fill them in and keep them
// current. Everything here works on a plain project object and throws
// ChecklistError with a message meant for a person.

import crypto from 'node:crypto';

export const ITEM_STATUSES = ['todo', 'in_progress', 'done', 'blocked', 'superseded'];
export const STATUS_LABEL = { todo: 'to do', in_progress: 'in progress', done: 'done', blocked: 'blocked', superseded: 'superseded' };
const OPEN = new Set(['todo', 'in_progress', 'blocked']);
const MAX_ITEMS = 2000;
const MAX_PHASES = 60;
const MAX_SUBTASKS = 50;

export class ChecklistError extends Error {}
const fail = msg => { throw new ChecklistError(msg); };
const id = () => crypto.randomBytes(12).toString('hex');

function text(v, max, field, required = false) {
  if (v == null) v = '';
  if (typeof v !== 'string') fail(`${field} must be text`);
  v = v.trim();
  if (required && !v) fail(`${field} is required`);
  if (v.length > max) fail(`${field} is too long (max ${max} characters)`);
  return v;
}

// "Phase 3: vault + forge" -> "VAULT", "Foundations" -> "FOUND"
export function phaseCodeFrom(name) {
  const words = String(name || '').replace(/^phase\s*[\w.]+\s*[:\-–—]?\s*/i, '').toUpperCase().match(/[A-Z0-9]+/g) || [];
  const w = words[0] || 'GEN';
  return w.length <= 6 ? w : w.slice(0, 5);   // LAUNCH stays whole, FOUNDATIONS becomes FOUND
}
// "Ranger One website" -> "ROW"
export function projectKeyFrom(name) {
  const words = String(name || '').toUpperCase().match(/[A-Z0-9]+/g) || ['P'];
  const k = words.length > 1 ? words.map(w => w[0]).join('') : words[0];
  return k.slice(0, 4);
}
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
export const normStatus = s => {
  const v = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  const alias = { open: 'todo', to_do: 'todo', pending: 'todo', not_started: 'todo', doing: 'in_progress', started: 'in_progress', wip: 'in_progress', complete: 'done', completed: 'done', finished: 'done', closed: 'done', stuck: 'blocked', replaced: 'superseded', obsolete: 'superseded', cancelled: 'superseded', canceled: 'superseded' };
  const r = alias[v] || v;
  if (!ITEM_STATUSES.includes(r)) fail(`Status must be one of: ${ITEM_STATUSES.join(', ')}`);
  return r;
};

// Older projects had a plain "next steps" list. Fold it into the checklist once.
export function ensureChecklist(x) {
  if (!Array.isArray(x.phases)) x.phases = [];
  if (!Array.isArray(x.items)) x.items = [];
  if (!x.key) x.key = projectKeyFrom(x.name);
  if (Array.isArray(x.next) && x.next.length) {
    const ph = ensurePhase(x, { name: 'Next steps', code: 'NEXT' });
    for (const n of x.next) {
      if (!n || !n.text) continue;
      pushItem(x, ph, { title: n.text, status: n.done ? 'done' : 'todo', owner: '' }, 'you');
    }
  }
  delete x.next;
  x.phases = x.phases.filter(p => p && p.id && p.code);
  x.items = x.items.filter(i => i && i.id && i.title && x.phases.some(p => p.id === i.phaseId));
  // Subtasks: one level deep, always in their parent's phase.
  const byId = new Map(x.items.map(i => [i.id, i]));
  for (const i of x.items) {
    if (!i.parentId) { delete i.parentId; continue; }
    const par = byId.get(i.parentId);
    if (!par || par === i || par.parentId) delete i.parentId;
    else if (i.phaseId !== par.phaseId) i.phaseId = par.phaseId;
  }
  return x;
}

export function childrenOf(x, it) { return x.items.filter(i => i.parentId === it.id); }

// FOUND-001 -> FOUND-001.1, FOUND-001.2 ...
function nextSubRef(x, par) {
  let max = 0;
  const re = new RegExp(`^${par.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);
  for (const it of x.items) {
    const m = it.parentId === par.id && re.exec(it.ref || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${par.ref}.${max + 1}`;
}
function rerefChildren(x, par) {
  let n = 0;
  for (const c of childrenOf(x, par)) { c.phaseId = par.phaseId; c.ref = `${par.ref}.${++n}`; }
}
// A subtask's parent is always a top-level item: naming a subtask means its parent.
function topParent(x, ref) {
  const par = findItem(x, ref);
  if (!par) fail(`Parent item "${ref}" not found`);
  return par.parentId ? x.items.find(i => i.id === par.parentId) || par : par;
}
// Items phase by phase, each followed by its subtasks.
export function displayOrder(x) {
  const out = [];
  for (const ph of x.phases || []) {
    for (const it of x.items) {
      if (it.phaseId !== ph.id || it.parentId) continue;
      out.push(it);
      for (const c of childrenOf(x, it)) out.push(c);
    }
  }
  return out;
}

export function findPhase(x, ref) {
  if (ref == null || ref === '') return null;
  const r = String(ref).trim();
  const lc = r.toLowerCase();
  const exact = x.phases.find(p => p.id === r)
    || x.phases.find(p => p.code === r.toUpperCase())
    || x.phases.find(p => p.name.toLowerCase() === lc);
  if (exact) return exact;
  const part = x.phases.filter(p => p.name.toLowerCase().includes(lc));
  return part.length === 1 ? part[0] : null;   // only when it can only mean one phase
}

export function ensurePhase(x, { name, code } = {}) {
  // Exact matches only here, so "Phase 1" never lands in "Phase 10".
  const c0 = cleanCode(code); const n0 = String(name || '').trim().toLowerCase();
  const existing = (c0 && x.phases.find(p => p.code === c0)) || (n0 && x.phases.find(p => p.name.toLowerCase() === n0)) || null;
  if (existing) return existing;
  if (x.phases.length >= MAX_PHASES) fail(`At most ${MAX_PHASES} phases per project`);
  const nm = text(name || code || 'General', 80, 'Phase name', true);
  let c = cleanCode(code) || phaseCodeFrom(nm);
  let base = c; let i = 2;
  while (x.phases.some(p => p.code === c)) c = `${base.slice(0, 6)}${i++}`;
  const ph = { id: id(), code: c, name: nm };
  x.phases.push(ph);
  return ph;
}

function nextRef(x, ph) {
  let max = 0;
  for (const it of x.items) {
    const m = it.phaseId === ph.id && new RegExp(`^${ph.code}-(\\d+)$`).exec(it.ref || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${ph.code}-${String(max + 1).padStart(3, '0')}`;
}

function pushItem(x, ph, b, who, par = null) {
  if (x.items.length >= MAX_ITEMS) fail(`At most ${MAX_ITEMS} checklist items per project`);
  if (par && childrenOf(x, par).length >= MAX_SUBTASKS) fail(`At most ${MAX_SUBTASKS} subtasks per item`);
  const now = Date.now();
  const it = {
    id: id(), ref: par ? nextSubRef(x, par) : nextRef(x, ph), phaseId: par ? par.phaseId : ph.id,
    title: text(b.title, 300, 'Item', true),
    status: b.status ? normStatus(b.status) : 'todo',
    owner: text(b.owner, 40, 'Owner'),
    notes: text(b.notes, 2000, 'Notes'),
    created: now, updated: now, by: who,
  };
  if (par) {
    it.parentId = par.id;
    const fam = [par, ...childrenOf(x, par)];
    x.items.splice(x.items.indexOf(fam[fam.length - 1]) + 1, 0, it);
  } else x.items.push(it);
  return it;
}

export function findItem(x, ref) {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const up = r.toUpperCase();
  const key = `${x.key}-`;
  const bare = up.startsWith(key) ? up.slice(key.length) : up;
  const lc = r.toLowerCase();
  return x.items.find(i => i.id === r)
    || x.items.find(i => i.ref === bare)
    || x.items.find(i => i.title.toLowerCase() === lc)
    || x.items.find(i => OPEN.has(i.status) && i.title.toLowerCase().includes(lc))
    || x.items.find(i => i.title.toLowerCase().includes(lc))
    || null;
}

// Add phases and items in one go. items: [{ phase, title, status, owner, notes, parent, subtasks }]
export function addItems(x, { phases = [], items = [] } = {}, who) {
  ensureChecklist(x);
  if (!Array.isArray(phases) || !Array.isArray(items)) fail('phases and items must be lists');
  for (const p of phases) ensurePhase(x, typeof p === 'string' ? { name: p } : p);
  const added = [];
  for (const b of items) {
    const src = typeof b === 'string' ? { title: b } : b;
    let it;
    if (src.parent != null && String(src.parent).trim()) {
      it = pushItem(x, null, src, who, topParent(x, src.parent));
    } else {
      const ph = findPhase(x, src.phase) || ensurePhase(x, { name: src.phase || 'General' });
      it = pushItem(x, ph, src, who);
    }
    added.push(it);
    if (src.subtasks != null) {
      if (!Array.isArray(src.subtasks)) fail('subtasks must be a list');
      const par = it.parentId ? x.items.find(i => i.id === it.parentId) : it;
      for (const sb of src.subtasks) added.push(pushItem(x, null, typeof sb === 'string' ? { title: sb } : sb, who, par));
    }
  }
  return added;
}

// updates: [{ item, status, owner, notes, title, phase, parent }]
export function updateItems(x, updates = [], who) {
  ensureChecklist(x);
  if (!Array.isArray(updates)) fail('updates must be a list');
  const changed = []; const missing = [];
  for (const u of updates) {
    const it = findItem(x, u.item ?? u.id ?? u.ref);
    if (!it) { missing.push(String(u.item ?? u.id ?? u.ref ?? '')); continue; }
    if (u.status != null) it.status = normStatus(u.status);
    if (u.owner != null) it.owner = text(u.owner, 40, 'Owner');
    if (u.notes != null) it.notes = text(u.notes, 2000, 'Notes');
    if (u.title != null) it.title = text(u.title, 300, 'Item', true);
    if (u.parent != null) {
      const pr = String(u.parent).trim();
      if (!pr) {
        if (it.parentId) {   // back to a normal item, in the same phase
          const ph = x.phases.find(p => p.id === it.phaseId);
          delete it.parentId;
          it.ref = nextRef(x, ph);
        }
      } else {
        const par = topParent(x, pr);
        if (par === it) fail(`${fullRef(x, it)} cannot be its own subtask`);
        if (childrenOf(x, it).length) fail(`${fullRef(x, it)} has subtasks of its own, so it cannot become a subtask`);
        if (it.parentId !== par.id) {
          if (childrenOf(x, par).length >= MAX_SUBTASKS) fail(`At most ${MAX_SUBTASKS} subtasks per item`);
          x.items.splice(x.items.indexOf(it), 1);
          it.parentId = par.id;
          it.phaseId = par.phaseId;
          it.ref = nextSubRef(x, par);
          const fam = [par, ...childrenOf(x, par)];
          x.items.splice(x.items.indexOf(fam[fam.length - 1]) + 1, 0, it);
        }
      }
    }
    if (u.phase != null) {
      const ph = findPhase(x, u.phase) || ensurePhase(x, { name: u.phase });
      if (ph.id !== it.phaseId) {
        if (it.parentId) fail(`${fullRef(x, it)} is a subtask, so it stays in its parent's phase. Move the parent, or detach it first (parent: "")`);
        it.phaseId = ph.id;
        it.ref = nextRef(x, ph);
        rerefChildren(x, it);
      }
    }
    it.updated = Date.now(); it.by = who;
    changed.push(it);
  }
  return { changed, missing };
}

export function deleteItem(x, ref) {
  const it = findItem(x, ref);
  if (!it) fail('Checklist item not found');
  x.items = x.items.filter(i => i !== it && i.parentId !== it.id);   // its subtasks go with it
  return it;
}

export function renamePhase(x, ref, name) {
  const ph = findPhase(x, ref);
  if (!ph) fail('Phase not found');
  ph.name = text(name, 80, 'Phase name', true);
  return ph;
}

export function deletePhase(x, ref) {
  const ph = findPhase(x, ref);
  if (!ph) fail('Phase not found');
  if (x.items.some(i => i.phaseId === ph.id)) fail('Move or delete this phase\'s items first');
  x.phases = x.phases.filter(p => p !== ph);
  return ph;
}

export function movePhase(x, ref, dir) {
  const i = x.phases.findIndex(p => p === findPhase(x, ref));
  if (i < 0) fail('Phase not found');
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= x.phases.length) return;
  [x.phases[i], x.phases[j]] = [x.phases[j], x.phases[i]];
}

export function moveItem(x, ref, dir) {
  const it = findItem(x, ref);
  if (!it) fail('Checklist item not found');
  const same = x.items.filter(i => i.phaseId === it.phaseId && (i.parentId || '') === (it.parentId || ''));
  const k = same.indexOf(it); const other = same[k + (dir < 0 ? -1 : 1)];
  if (!other) return;
  const a = x.items.indexOf(it); const b = x.items.indexOf(other);
  [x.items[a], x.items[b]] = [x.items[b], x.items[a]];
}

export function stats(x) {
  const s = { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, superseded: 0 };
  for (const i of x.items || []) { s.total++; s[i.status] = (s[i.status] || 0) + 1; }
  s.counted = s.total - s.superseded;
  return s;
}

// What to do next: anything in progress first, then the first item still to do.
export function nextOpen(x, n = 1) {
  // An item whose subtasks are still open is not itself the next thing: its next subtask is.
  const items = displayOrder(x);
  const busy = i => !i.parentId && childrenOf(x, i).some(c => OPEN.has(c.status));
  const pick = st => items.filter(i => i.status === st && !busy(i));
  return [...pick('in_progress'), ...pick('todo')].slice(0, n);
}

export const fullRef = (x, it) => `${x.key}-${it.ref}`;

export function checklistMarkdown(x, { openOnly = true, maxOpen = 80 } = {}) {
  const L = [];
  const s = stats(x);
  if (!s.total) return '(no checklist yet: add one with add_checklist_items)';
  L.push(`Progress: ${s.done} of ${s.counted} done${s.in_progress ? `, ${s.in_progress} in progress` : ''}${s.blocked ? `, ${s.blocked} blocked` : ''}${s.superseded ? ` (${s.superseded} superseded)` : ''}`);
  let shown = 0;
  for (const ph of x.phases) {
    const items = x.items.filter(i => i.phaseId === ph.id);
    if (!items.length) continue;
    const d = items.filter(i => i.status === 'done').length;
    const counted = items.filter(i => i.status !== 'superseded').length;
    L.push('', `### ${ph.code} · ${ph.name} (${d}/${counted} done)`);
    for (const it of displayOrder({ phases: [ph], items: x.items })) {
      const kidsOpen = !it.parentId && x.items.some(c => c.parentId === it.id && OPEN.has(c.status));
      if (openOnly && !OPEN.has(it.status) && !kidsOpen) continue;
      if (shown >= maxOpen) { L.push('- ... more (call get_checklist for the full list)'); break; }
      const box = it.status === 'done' ? 'x' : ' ';
      const kids = it.parentId ? [] : x.items.filter(c => c.parentId === it.id && c.status !== 'superseded');
      const kidCount = kids.length ? `, ${kids.filter(c => c.status === 'done').length}/${kids.length} subtasks done` : '';
      L.push(`${it.parentId ? '  ' : ''}- [${box}] ${fullRef(x, it)} ${it.title}  (${STATUS_LABEL[it.status]}${it.owner ? `, ${it.owner}` : ''}${kidCount})${it.notes ? `: ${it.notes.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      shown++;
    }
  }
  return L.join('\n');
}
