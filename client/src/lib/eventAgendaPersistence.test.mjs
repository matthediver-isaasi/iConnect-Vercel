// Tests for the Edit Event agenda persistence helper (Task #3512):
// agenda mutations are compensated on failure (including operations whose
// response was lost after the request may have persisted), rollback failures
// are surfaced to the caller, and `undo()` reverses a successful pass when
// the subsequent parent event update fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { persistAgendaLinesWithRollback } from './eventAgendaPersistence.js';

const buildPayload = (line, sortOrder) => ({
  event_id: 'evt-1',
  description: line.description || null,
  sort_order: sortOrder,
});

// failCreateOnCall: 1-based index of the create CALL that throws (later
// creates — e.g. rollback recreations — succeed, modelling a transient error).
function makeApi({ failCreateOnCall = 0, failUpdateOnCall = 0, failAllCreates = false } = {}) {
  const calls = [];
  let nextId = 100;
  let createCalls = 0;
  let updateCalls = 0;
  return {
    calls,
    api: {
      create: async (payload) => {
        createCalls += 1;
        calls.push(['create', payload]);
        if (failAllCreates || createCalls === failCreateOnCall) throw new Error('create boom');
        return { id: `new-${nextId++}` };
      },
      update: async (id, payload) => {
        updateCalls += 1;
        calls.push(['update', id, payload]);
        if (updateCalls === failUpdateOnCall) throw new Error('update boom');
        return { id };
      },
      delete: async (id) => {
        calls.push(['delete', id]);
        return { id };
      },
    },
  };
}

const rowA = { id: 'a', description: 'Row A' };
const rowB = { id: 'b', description: 'Row B' };

test('success returns saved ids in order (updates + creates, deletes removed)', async () => {
  const { api, calls } = makeApi();
  const result = await persistAgendaLinesWithRollback({
    api,
    orderedLines: [{ id: 'a', description: 'Row A edited' }, { description: 'Row C new' }],
    initialRows: [rowA, rowB],
    buildPayload,
  });
  assert.equal(result.savedIds.length, 2);
  assert.equal(result.savedIds[0], 'a');
  assert.ok(String(result.savedIds[1]).startsWith('new-'));
  assert.deepEqual(calls.filter(([op]) => op === 'delete').map(([, id]) => id), ['b']);
});

test('transient create failure compensates prior mutations and flags the unresolved create', async () => {
  const { api, calls } = makeApi({ failCreateOnCall: 1 });
  let thrown;
  try {
    await persistAgendaLinesWithRollback({
      api,
      orderedLines: [{ id: 'a', description: 'Row A edited' }, { description: 'Row C new' }],
      initialRows: [rowA, rowB],
      buildPayload,
    });
  } catch (err) { thrown = err; }
  assert.match(thrown.message, /create boom/);
  // The failed create never returned an id, so the helper cannot verify the
  // row does not exist server-side — it must surface that honestly.
  assert.equal(thrown.rollbackFailures.length, 1);
  assert.equal(thrown.rollbackFailures[0].op, 'create');
  // Mutations before the failure (delete b, update a) are fully compensated.
  const updates = calls.filter(([op]) => op === 'update');
  assert.equal(updates.length, 2, 'a updated then restored');
  assert.equal(updates[1][2].description, 'Row A', 'a restored to snapshot value');
  const creates = calls.filter(([op]) => op === 'create');
  assert.equal(creates[creates.length - 1][1].description, 'Row B', 'b recreated from snapshot');
});

test('update whose response fails is still compensated (request may have persisted)', async () => {
  const { api, calls } = makeApi({ failUpdateOnCall: 1 });
  await assert.rejects(
    persistAgendaLinesWithRollback({
      api,
      orderedLines: [{ id: 'a', description: 'Row A edited' }],
      initialRows: [rowA, rowB],
      buildPayload,
    }),
    /update boom/,
  );
  const updates = calls.filter(([op]) => op === 'update');
  // The failed update itself is recorded before awaiting, so compensation
  // issues a restore update for `a` back to its snapshot value.
  assert.equal(updates.length, 2);
  assert.equal(updates[1][1], 'a');
  assert.equal(updates[1][2].description, 'Row A');
  // b's delete compensated by a recreate.
  const creates = calls.filter(([op]) => op === 'create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0][1].description, 'Row B');
});

test('rollback failures are surfaced on the thrown error', async () => {
  // Every create fails — including the rollback recreation of deleted row b —
  // so the caller must be told compensation was incomplete.
  const { api } = makeApi({ failAllCreates: true });
  let thrown;
  try {
    await persistAgendaLinesWithRollback({
      api,
      orderedLines: [{ id: 'a', description: 'Row A edited' }, { description: 'Row C new' }],
      initialRows: [rowA, rowB],
      buildPayload,
    });
  } catch (err) { thrown = err; }
  assert.match(thrown.message, /create boom/);
  assert.ok(Array.isArray(thrown.rollbackFailures));
  assert.ok(thrown.rollbackFailures.length >= 1);
  assert.ok(thrown.rollbackFailures.some((f) => f.op === 'delete' && f.id === 'b'), 'failed recreate of b reported');
});

test('mixed existing + new lines saved twice: second save updates, never duplicates', async () => {
  const { api, calls } = makeApi();
  // Existing row first, new row second — the case where index-based id
  // reconciliation used to drop the created id.
  const first = await persistAgendaLinesWithRollback({
    api,
    orderedLines: [{ id: 'a', description: 'Row A edited' }, { description: 'Row C new' }],
    initialRows: [rowA],
    buildPayload,
  });
  // persistedLines must carry the new server id on the created line.
  assert.equal(first.persistedLines[0].id, 'a');
  const newId = first.persistedLines[1].id;
  assert.ok(String(newId).startsWith('new-'), 'created line received its server id');

  // Second save: rebuild local state from persistedLines (as EditEvent does).
  calls.length = 0;
  const second = await persistAgendaLinesWithRollback({
    api,
    orderedLines: first.persistedLines,
    initialRows: first.persistedLines,
    buildPayload,
  });
  assert.deepEqual(second.savedIds, ['a', newId]);
  // No creates and no deletes on the second save — only updates.
  assert.deepEqual(calls.map(([op]) => op), ['update', 'update']);
  assert.equal(calls[1][1], newId);
});

test('undo() after success reverses creates, updates and deletes and reports failures', async () => {
  const { api, calls } = makeApi();
  const result = await persistAgendaLinesWithRollback({
    api,
    orderedLines: [{ id: 'a', description: 'Row A edited' }, { description: 'Row C new' }],
    initialRows: [rowA, rowB],
    buildPayload,
  });
  calls.length = 0;
  const failures = await result.undo();
  assert.deepEqual(failures, []);
  // Reverse order: created C removed, a restored, deleted b recreated.
  assert.deepEqual(calls.map(([op]) => op), ['delete', 'update', 'create']);
  assert.equal(calls[1][2].description, 'Row A');
  assert.equal(calls[2][1].description, 'Row B');
});
