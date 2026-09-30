// Regression tests for Task #3555 — write-time tenant guard on MEMBER
// updates in the form application processor, mirroring the organisation
// guard tests in formOrgResolution.test.mjs (Task #3550).
//
// The guard is the generalised applyWriteTenantGuard (of which
// applyOrgWriteTenantGuard is an alias): a member UPDATE is hard-filtered
// to the effective tenant (or tenant_id IS NULL for legacy adoption) so a
// badly-resolved cross-tenant member row can never be mutated — the update
// simply matches 0 rows and the processor fails loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWriteTenantGuard, applyOrgWriteTenantGuard, runGuardedTenantUpdate } from './formOrgResolution.js';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001'; // submitting tenant
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002'; // other tenant

// Minimal filter recorder standing in for a PostgREST update builder. The
// guard must only ever use plain .eq()/.is() filters — PostgREST .or() is
// unreliable on UPDATE.
function makeFilterRecorder() {
  const applied = [];
  const q = {
    eq(col, val) { applied.push(['eq', col, val]); return q; },
    is(col, val) { applied.push(['is', col, val]); return q; },
    or(val) { throw new Error(`guard must not use .or() on UPDATE (got: ${val})`); },
    applied,
  };
  return q;
}

test('member guard: row in the effective tenant -> update filtered to that tenant', () => {
  const q = makeFilterRecorder();
  applyWriteTenantGuard(q, TENANT_A, { id: 'm1', tenant_id: TENANT_A });
  assert.deepEqual(q.applied, [['eq', 'tenant_id', TENANT_A]]);
});

test('member guard: cross-tenant member row -> filter binds to the EFFECTIVE tenant (update matches 0 rows)', () => {
  const q = makeFilterRecorder();
  applyWriteTenantGuard(q, TENANT_A, { id: 'm1', tenant_id: TENANT_B });
  assert.deepEqual(q.applied, [['eq', 'tenant_id', TENANT_A]]);
});

test('member guard: NULL-tenant legacy member -> update filtered to tenant_id IS NULL (adoption)', () => {
  const q = makeFilterRecorder();
  applyWriteTenantGuard(q, TENANT_A, { id: 'm1', tenant_id: null });
  assert.deepEqual(q.applied, [['is', 'tenant_id', null]]);
});

test('member guard: no effective tenant (legacy/pre-tenant form) -> no extra filter', () => {
  const q = makeFilterRecorder();
  applyWriteTenantGuard(q, null, { id: 'm1', tenant_id: TENANT_B });
  assert.deepEqual(q.applied, []);
});

test('member guard: row object without tenant_id is treated as legacy (IS NULL) — callers must select tenant_id', () => {
  const q = makeFilterRecorder();
  applyWriteTenantGuard(q, TENANT_A, { id: 'm1' });
  assert.deepEqual(q.applied, [['is', 'tenant_id', null]]);
});

test('applyOrgWriteTenantGuard remains an alias of the generalised guard', () => {
  assert.equal(applyOrgWriteTenantGuard, applyWriteTenantGuard);
});

// ---------------------------------------------------------------------------
// runGuardedTenantUpdate — the update wrapper the processor's member update
// paths use. Fake PostgREST update builder that applies eq/is filters against
// an in-memory row store, mutating matched rows like a real UPDATE.
function makeFakeUpdateSupabase(rows) {
  const calls = [];
  return {
    rows,
    calls,
    from(table) {
      let payload = null;
      const filters = [];
      const builder = {
        update(p) { payload = p; return builder; },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        is(col, val) { filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val)); return builder; },
        or() { throw new Error('guard must not use .or() on UPDATE'); },
        select(sel) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          for (const r of matched) Object.assign(r, payload);
          calls.push({ table, payload, matched: matched.length, sel });
          return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null });
        },
      };
      return builder;
    },
  };
}

test('guarded update: in-tenant member row is updated and returned', async () => {
  const row = { id: 'm1', tenant_id: TENANT_A, first_name: 'Old' };
  const supabase = makeFakeUpdateSupabase([row]);
  const result = await runGuardedTenantUpdate(supabase, {
    table: 'member', id: 'm1', payload: { first_name: 'New' },
    effectiveTenantId: TENANT_A, existingRow: row,
  });
  assert.equal(result.error, null);
  assert.equal(result.blocked, false);
  assert.equal(row.first_name, 'New');
});

test('guarded update: cross-tenant member row matches 0 rows -> blocked, row untouched', async () => {
  const row = { id: 'm1', tenant_id: TENANT_B, first_name: 'Theirs' };
  const supabase = makeFakeUpdateSupabase([row]);
  const result = await runGuardedTenantUpdate(supabase, {
    table: 'member', id: 'm1', payload: { first_name: 'Clobbered' },
    effectiveTenantId: TENANT_A, existingRow: row,
  });
  assert.equal(result.blocked, true, 'guard must report the blocked write');
  assert.equal(row.first_name, 'Theirs', 'other tenant\'s row must never be mutated');
});

test('guarded update: legacy NULL-tenant member is ADOPTED into the effective tenant', async () => {
  const row = { id: 'm1', tenant_id: null, first_name: 'Legacy' };
  const supabase = makeFakeUpdateSupabase([row]);
  const result = await runGuardedTenantUpdate(supabase, {
    table: 'member', id: 'm1', payload: { first_name: 'New' },
    effectiveTenantId: TENANT_A, existingRow: row,
  });
  assert.equal(result.blocked, false);
  assert.equal(row.first_name, 'New');
  assert.equal(row.tenant_id, TENANT_A, 'allowed legacy update must stamp tenant_id (adoption)');
});

test('guarded update: explicit payload tenant_id is not overridden by adoption stamping', async () => {
  const row = { id: 'm1', tenant_id: null };
  const supabase = makeFakeUpdateSupabase([row]);
  await runGuardedTenantUpdate(supabase, {
    table: 'member', id: 'm1', payload: { tenant_id: TENANT_A, first_name: 'x' },
    effectiveTenantId: TENANT_A, existingRow: row,
  });
  assert.equal(row.tenant_id, TENANT_A);
});

test('guarded update: no effective tenant -> no adoption stamp, no tenant filter', async () => {
  const row = { id: 'm1', tenant_id: null, first_name: 'Old' };
  const supabase = makeFakeUpdateSupabase([row]);
  const result = await runGuardedTenantUpdate(supabase, {
    table: 'member', id: 'm1', payload: { first_name: 'New' },
    effectiveTenantId: null, existingRow: row,
  });
  assert.equal(result.blocked, false);
  assert.equal(row.first_name, 'New');
  assert.equal(row.tenant_id, null, 'pre-tenant flow must not invent a tenant');
});
