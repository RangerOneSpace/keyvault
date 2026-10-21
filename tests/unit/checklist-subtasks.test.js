// Checklist subtasks: one level deep, ids like FOUND-001.1, always in the parent's phase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cl from '../../src/checklist.js';

const make = () => {
  const x = cl.ensureChecklist({ name: 'Ranger One' });
  cl.addItems(x, { items: [{ phase: 'Foundations', title: 'Brand', subtasks: ['Logo', { title: 'Fonts', status: 'done' }] }, { phase: 'FOUND', title: 'Domain' }] }, 't');
  return x;
};
const refs = x => cl.displayOrder(x).map(i => i.ref);

test('subtasks get dotted ids and sit under their parent', () => {
  const x = make();
  assert.deepEqual(refs(x), ['FOUND-001', 'FOUND-001.1', 'FOUND-001.2', 'FOUND-002']);
  cl.addItems(x, { items: [{ parent: 'RO-FOUND-001.2', title: 'Colours' }] }, 't');   // a subtask's id means its parent
  assert.deepEqual(refs(x), ['FOUND-001', 'FOUND-001.1', 'FOUND-001.2', 'FOUND-001.3', 'FOUND-002']);
  assert.throws(() => cl.addItems(x, { items: [{ parent: 'NOPE-9', title: 'x' }] }, 't'), /not found/);
});

test('the next item is the next open subtask, not its parent', () => {
  const x = make();
  assert.equal(cl.nextOpen(x)[0].title, 'Logo');
  cl.updateItems(x, [{ item: 'Logo', status: 'done' }], 't');
  assert.equal(cl.nextOpen(x)[0].title, 'Brand', 'parent comes up once its subtasks are done');
});

test('nest, un-nest, move and delete', () => {
  const x = make();
  cl.updateItems(x, [{ item: 'FOUND-002', parent: 'FOUND-001' }], 't');
  assert.equal(x.items.find(i => i.title === 'Domain').ref, 'FOUND-001.3');
  assert.throws(() => cl.updateItems(x, [{ item: 'FOUND-001', parent: 'FOUND-001.1' }], 't'), /own subtask|subtasks of its own/);
  assert.throws(() => cl.updateItems(x, [{ item: 'FOUND-001.3', phase: 'Launch' }], 't'), /is a subtask/);
  cl.updateItems(x, [{ item: 'FOUND-001.3', parent: '' }], 't');
  assert.equal(x.items.find(i => i.title === 'Domain').ref, 'FOUND-002');
  cl.updateItems(x, [{ item: 'FOUND-001', phase: 'Launch' }], 't');
  assert.deepEqual(refs(x).filter(r => r.startsWith('LAUNC')), ['LAUNCH-001', 'LAUNCH-001.1', 'LAUNCH-001.2'], 'subtasks move with their parent');
  cl.deleteItem(x, 'LAUNCH-001');
  assert.equal(x.items.length, 1, 'deleting an item deletes its subtasks');
});

test('the brief shows subtasks indented with a count', () => {
  const md = cl.checklistMarkdown(make());
  assert.match(md, /- \[ \] RO-FOUND-001 Brand {2}\(to do, 1\/2 subtasks done\)/);
  assert.match(md, /\n {2}- \[ \] RO-FOUND-001\.1 Logo/);
});

test('broken parent links are repaired on load', () => {
  const x = make();
  x.items.find(i => i.title === 'Logo').parentId = 'missing';
  cl.ensureChecklist(x);
  assert.equal(x.items.find(i => i.title === 'Logo').parentId, undefined);
});
