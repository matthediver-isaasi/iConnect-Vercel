import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { journalDatabase } from './campaignPreparation.js';

const state = { id: 'generation', segment: 0 };
const keyFor = id => createHash('sha256').update(JSON.stringify(['member', [['eq', ['id', id]]]])).digest('hex');
const saved = (id, sequence) => ({
  generation: state.id, segment: 0, sequence, key: keyFor(id),
  result: { data: [{ id, version: 'saved' }], count: null, error: null },
});

// Pure in-memory database; no application clients, environment or network.
function fixture(history = []) {
  const model = { history, cacheReads: 0, sourceReads: 0, writes: 0, clock: 0, pageSizes: [] };
  const db = {
    from(table) {
      const filters = []; let max = Infinity; let single = false;
      const q = {
        select() { return q; },
        eq(k, v) { filters.push(r => r[k] === v); return q; },
        gte(k, v) { filters.push(r => r[k] >= v); return q; },
        lt(k, v) { filters.push(r => r[k] < v); return q; },
        order() { return q; },
        limit(n) { max = n; return q; },
        abortSignal() { return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            model.clock += 100;
            if (table !== 'campaign_preparation_read') {
              model.sourceReads++;
              if (model.sourceError) throw new Error('source failed');
              return { data: [{ version: 'current' }], error: null };
            }
            model.cacheReads++;
            if (model.cacheError) throw new Error('history unavailable');
            const rows = model.history.filter(r => filters.every(f => f(r)))
              .sort((a, b) => a.sequence - b.sequence).slice(0, max);
            model.pageSizes.push(rows.length);
            return { data: structuredClone(single ? rows[0] || null : rows), error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name, args) {
      assert.equal(name, 'campaign_preparation_step');
      assert.equal(args.p_action, 'read');
      model.clock += 100;
      model.writes++;
      if (model.writeError) return { error: { message: 'checkpoint failed' } };
      const p = args.p_payload;
      if (!model.history.some(r => r.key === p.key)) {
        model.history.push({ generation: state.id, ...structuredClone(p) });
      }
      return { data: {}, error: null };
    },
  };
  return { model, db, journal: () => journalDatabase(db, state, 'owner', 1_000_000, () => model.clock) };
}

test('fresh transition skips redundant history reads but checkpoints every source result', async () => {
  const f = fixture(), journal = f.journal();
  for (let i = 0; i < 20; i++) await journal.from('member').eq('id', `m${i}`);
  assert.equal(f.model.cacheReads, 1);
  assert.equal(f.model.sourceReads, 20);
  assert.equal(f.model.writes, 20);
  // Previously: 3 cache pages + 20 exact lookups + 20 sources + 20 writes.
  assert.equal(f.model.clock, 4100);
  assert.ok(f.model.clock < 6300);
});

test('repeated queries in a fresh transition still use their durable first result', async () => {
  const f = fixture(), journal = f.journal();
  const original = await journal.from('member').eq('id', 'same');
  f.model.sourceError = true;
  const repeated = await journal.from('member').eq('id', 'same');
  assert.deepEqual(repeated, { ...original, count: null });
  assert.equal(f.model.sourceReads, 1);
  assert.equal(f.model.writes, 1);
});

test('sparse crash history is not mistaken for an empty segment', async () => {
  const f = fixture([saved('late', 90)]);
  const result = await f.journal().from('member').eq('id', 'late');
  assert.equal(result.data[0].version, 'saved');
  assert.equal(f.model.sourceReads, 0);
});

test('reordered replay finds a query beyond the bounded first page by identity', async () => {
  const f = fixture([...Array.from({ length: 8 }, (_, i) => saved(`other${i}`, i)), saved('target', 90)]);
  const result = await f.journal().from('member').eq('id', 'target');
  assert.equal(result.data[0].id, 'target');
  assert.equal(f.model.cacheReads, 2);
  assert.equal(f.model.sourceReads, 0);
  assert.ok(f.model.pageSizes.every(n => n <= 8));
});

test('restart replays checkpointed results without rereading source data', async () => {
  const f = fixture();
  await f.journal().from('member').eq('id', 'saved');
  f.model.sourceError = true;
  await f.journal().from('member').eq('id', 'saved');
  assert.equal(f.model.sourceReads, 1);
  assert.equal(f.model.writes, 1);
});

test('failed checkpoint does not turn an unsaved result into a successful replay', async () => {
  const f = fixture();
  f.model.writeError = true;
  await assert.rejects(f.journal().from('member').eq('id', 'unsaved'), /checkpoint failed/);
  assert.equal(f.model.history.length, 0);
  f.model.writeError = false;
  await f.journal().from('member').eq('id', 'unsaved');
  assert.equal(f.model.sourceReads, 2);
});

test('history read failure fails closed without consulting source data', async () => {
  const f = fixture();
  f.model.cacheError = true;
  await assert.rejects(f.journal().from('member').eq('id', 'member'), /history unavailable/);
  assert.equal(f.model.sourceReads, 0);
});

test('concurrent fresh reads share one emptiness probe and each keep a checkpoint', async () => {
  const f = fixture(), journal = f.journal();
  await Promise.all(Array.from({ length: 8 }, (_, i) => journal.from('member').eq('id', `m${i}`)));
  assert.equal(f.model.cacheReads, 1);
  assert.equal(f.model.writes, 8);
});

test('legacy long transitions fall back to durable lookups after bounded bookkeeping', async () => {
  const f = fixture(), journal = f.journal();
  for (let i = 0; i < 80; i++) await journal.from('member').eq('id', `m${i}`);
  f.model.sourceError = true;
  await journal.from('member').eq('id', 'm0');
  assert.equal(f.model.sourceReads, 80);
  assert.ok(f.model.pageSizes.every(n => n <= 8));
});
