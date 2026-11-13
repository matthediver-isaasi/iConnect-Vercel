import test from 'node:test';
import assert from 'node:assert/strict';
import { reorderPortalMenu, createPortalMenuOrderQueue } from './portalMenuOrder.js';

const rows = ['a', 'b', 'c', 'd'].map((id, display_order) => ({ id, display_order, is_active: true, section: 'user', parent_id: null }));
const ids = list => [...list].sort((a, b) => a.display_order - b.display_order).map(row => row.id);
const tick = () => new Promise(resolve => setImmediate(resolve));
test('arrows change only two sibling positions and retain all other fields', () => {
  const result = reorderPortalMenu(rows, 'b', 'up');
  assert.deepEqual(ids(result), ['b', 'a', 'c', 'd']);
  assert.equal(result.filter((row, i) => row.display_order !== rows[i].display_order).length, 2);
  assert.equal(reorderPortalMenu(rows, 'a', 'up'), rows);
  assert.equal(reorderPortalMenu(rows, 'd', 'down'), rows);
  assert.equal(result.find(row => row.id === 'b').parent_id, null);
});
test('dragging stays in section and parent, with inactive and hidden rows unchanged', () => {
  const list = [...rows, { ...rows[0], id: 'child', parent_id: 'a' },
    { ...rows[0], id: 'admin', section: 'admin' }, { ...rows[0], id: 'inactive', is_active: false }];
  for (const id of ['child', 'admin', 'inactive']) assert.equal(reorderPortalMenu(list, 'a', id), list);
  assert.deepEqual(ids(reorderPortalMenu(rows, 'a', 'd')), ['b', 'c', 'd', 'a']);
  const filtered = reorderPortalMenu(rows, 'a', 'down', ['a', 'c', 'd']);
  assert.equal(filtered.find(row => row.id === 'b').display_order, 1);
  assert.equal(filtered.find(row => row.id === 'a').display_order, 2);
});
test('duplicate legacy positions are normalized to integer orders', () => {
  const result = reorderPortalMenu(rows.map(row => ({ ...row, display_order: 0 })), 'a', 'c');
  assert.deepEqual(ids(result), ['b', 'c', 'a', 'd']);
  assert.equal(new Set(result.map(row => row.display_order)).size, 4);
});
test('rapid moves update immediately and serialize changed-only writes', async () => {
  const writes = [], releases = [], changes = [], saves = [];
  const queue = createPortalMenuOrderQueue({
    write: (id, order) => { writes.push([id, order]); return new Promise(resolve => releases.push(resolve)); },
    changed: value => changes.push(value), saved: value => saves.push(value),
    failed: () => assert.fail('unexpected failure'),
  });
  queue.move(rows, 'a', 'down');
  assert.deepEqual(ids(changes.at(-1)), ['b', 'a', 'c', 'd']);
  assert.equal(writes.length, 2);
  queue.move(rows, 'a', 'd');
  assert.deepEqual(ids(changes.at(-1)), ['b', 'c', 'd', 'a']);
  assert.equal(writes.length, 2);
  releases.splice(0).forEach(resolve => resolve());
  await tick();
  assert.equal(writes.length, 5);
  releases.splice(0).forEach(resolve => resolve());
  await tick();
  assert.deepEqual(ids(saves[0]), ['b', 'c', 'd', 'a']);
});
test('partial failures await every write then request authoritative reload', async () => {
  let finish, failed = 0, saved = 0;
  const queue = createPortalMenuOrderQueue({
    write: id => id === 'a' ? Promise.reject(new Error('network')) : new Promise(resolve => { finish = resolve; }),
    changed: () => {}, saved: () => saved++, failed: async () => { failed++; },
  });
  queue.move(rows, 'a', 'down');
  await tick();
  assert.equal(failed, 0);
  finish();
  await tick();
  assert.equal(failed, 1);
  assert.equal(saved, 0);
});
test('leaving the page finishes queued saves without notifying disposed UI', async () => {
  const releases = [], persisted = [];
  const queue = createPortalMenuOrderQueue({
    write: () => new Promise(resolve => releases.push(resolve)),
    changed: () => {}, saved: () => assert.fail('disposed callback'),
    persisted: value => persisted.push(value), failed: () => assert.fail('unexpected'),
  });
  queue.move(rows, 'a', 'down');
  queue.move(rows, 'a', 'd');
  queue.stop();
  releases.splice(0).forEach(resolve => resolve());
  await tick();
  releases.splice(0).forEach(resolve => resolve());
  await tick();
  assert.deepEqual(ids(persisted[0]), ['b', 'c', 'd', 'a']);
});
