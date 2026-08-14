// Regression tests for Task #3550 — cross-tenant organisation match on form
// submission.
//
// The core scenario: a submission names an organisation whose name only
// exists in ANOTHER tenant. Resolution must return "not found" so the
// processor's create path runs in the submitting tenant, and the write-time
// guard must make it impossible to UPDATE the other tenant's row even if a
// bad resolution slipped through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExistingOrganization, applyOrgWriteTenantGuard } from './formOrgResolution.js';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001'; // submitting tenant
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002'; // other tenant

// ---------------------------------------------------------------------------
// Minimal fake PostgREST builder. Supports the exact chains the resolver
// uses: .select().eq().maybeSingle(), .select().ilike().or().limit().maybeSingle().
function makeFakeSupabase(tables) {
  const matches = (row, filters) => filters.every((f) => {
    if (f.kind === 'eq') return row[f.col] === f.val;
    if (f.kind === 'ilike') return String(row[f.col] ?? '').toLowerCase() === String(f.val).toLowerCase();
    if (f.kind === 'or') {
      // Only the shape the resolver builds: tenant_id.eq.<id>,tenant_id.is.null
      return f.val.split(',').some((clause) => {
        const [col, op, ...rest] = clause.split('.');
        const v = rest.join('.');
        if (op === 'eq') return row[col] === v;
        if (op === 'is' && v === 'null') return row[col] === null || row[col] === undefined;
        return false;
      });
    }
    return false;
  });

  return {
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push({ kind: 'eq', col, val }); return builder; },
        ilike(col, val) { filters.push({ kind: 'ilike', col, val }); return builder; },
        or(val) { filters.push({ kind: 'or', val }); return builder; },
        limit() { return builder; },
        maybeSingle() {
          const rows = (tables[table] || []).filter((r) => matches(r, filters));
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
      };
      return builder;
    },
  };
}

function makeRejector(effectiveTenantId, notes) {
  return (row, stage, extra = {}) => {
    const cross = !!(effectiveTenantId && row?.tenant_id && row.tenant_id !== effectiveTenantId);
    if (cross) notes.push({ stage, ...extra, found_id: row.id, found_tenant_id: row.tenant_id });
    return cross;
  };
}

test('same-name org in ANOTHER tenant is not resolved — create path runs in submitting tenant', async () => {
  const otherTenantsOrg = { id: 'org-b', name: 'isaasi', tenant_id: TENANT_B };
  const supabase = makeFakeSupabase({ organization: [otherTenantsOrg] });
  const notes = [];
  const { existingOrg, orgResolutionMethod } = await resolveExistingOrganization(supabase, {
    effectiveTenantId: TENANT_A,
    effectivePrefillOrgId: null,
    submissionId: null,
    memberIdForOrgLookup: null,
    memberEmail: null,
    orgName: 'isaasi',
    rejectCrossTenant: makeRejector(TENANT_A, notes),
  });
  assert.equal(existingOrg, null, 'cross-tenant name collision must resolve to null (=> new org created in submitting tenant)');
  assert.equal(orgResolutionMethod, null);
});

test('same-name org in the SAME tenant is resolved by name match', async () => {
  const ownOrg = { id: 'org-a', name: 'isaasi', tenant_id: TENANT_A };
  const supabase = makeFakeSupabase({ organization: [{ id: 'org-b', name: 'isaasi', tenant_id: TENANT_B }, ownOrg] });
  const { existingOrg, orgResolutionMethod } = await resolveExistingOrganization(supabase, {
    effectiveTenantId: TENANT_A,
    orgName: 'ISAASI',
    rejectCrossTenant: makeRejector(TENANT_A, []),
  });
  assert.equal(existingOrg?.id, 'org-a');
  assert.equal(orgResolutionMethod, 'org_name_match');
});

test('legacy NULL-tenant org remains matchable by name', async () => {
  const legacy = { id: 'org-legacy', name: 'isaasi', tenant_id: null };
  const supabase = makeFakeSupabase({ organization: [legacy] });
  const { existingOrg } = await resolveExistingOrganization(supabase, {
    effectiveTenantId: TENANT_A,
    orgName: 'isaasi',
    rejectCrossTenant: makeRejector(TENANT_A, []),
  });
  assert.equal(existingOrg?.id, 'org-legacy');
});

test('cross-tenant prefill_organization_id is rejected with a note and falls through to name scope', async () => {
  const crossOrg = { id: 'org-b', name: 'isaasi', tenant_id: TENANT_B };
  const supabase = makeFakeSupabase({ organization: [crossOrg] });
  const notes = [];
  const { existingOrg } = await resolveExistingOrganization(supabase, {
    effectiveTenantId: TENANT_A,
    effectivePrefillOrgId: 'org-b',
    prefillWasExplicit: true,
    orgName: 'isaasi',
    rejectCrossTenant: makeRejector(TENANT_A, notes),
  });
  assert.equal(existingOrg, null);
  assert.equal(notes.length, 1, 'rejection must leave a note');
  assert.equal(notes[0].found_tenant_id, TENANT_B);
});

test('cross-tenant form_submission.organization_id is rejected', async () => {
  const crossOrg = { id: 'org-b', name: 'Other', tenant_id: TENANT_B };
  const supabase = makeFakeSupabase({
    organization: [crossOrg],
    form_submission: [{ id: 'sub-1', organization_id: 'org-b' }],
  });
  const notes = [];
  const { existingOrg } = await resolveExistingOrganization(supabase, {
    effectiveTenantId: TENANT_A,
    submissionId: 'sub-1',
    rejectCrossTenant: makeRejector(TENANT_A, notes),
  });
  assert.equal(existingOrg, null);
  assert.equal(notes.length, 1);
});

// ---------------------------------------------------------------------------
// Write-time tenant guard
function makeFilterRecorder() {
  const applied = [];
  const q = {
    eq(col, val) { applied.push(['eq', col, val]); return q; },
    is(col, val) { applied.push(['is', col, val]); return q; },
    applied,
  };
  return q;
}

test('write guard: row in a tenant -> update filtered to effective tenant', () => {
  const q = makeFilterRecorder();
  applyOrgWriteTenantGuard(q, TENANT_A, { id: 'x', tenant_id: TENANT_A });
  assert.deepEqual(q.applied, [['eq', 'tenant_id', TENANT_A]]);
});

test('write guard: cross-tenant row -> filter still binds to the EFFECTIVE tenant (update matches 0 rows)', () => {
  const q = makeFilterRecorder();
  applyOrgWriteTenantGuard(q, TENANT_A, { id: 'x', tenant_id: TENANT_B });
  assert.deepEqual(q.applied, [['eq', 'tenant_id', TENANT_A]]);
});

test('write guard: NULL-tenant legacy row -> update filtered to tenant_id IS NULL (adoption)', () => {
  const q = makeFilterRecorder();
  applyOrgWriteTenantGuard(q, TENANT_A, { id: 'x', tenant_id: null });
  assert.deepEqual(q.applied, [['is', 'tenant_id', null]]);
});

test('write guard: no effective tenant -> no extra filter', () => {
  const q = makeFilterRecorder();
  applyOrgWriteTenantGuard(q, null, { id: 'x', tenant_id: TENANT_B });
  assert.deepEqual(q.applied, []);
});
