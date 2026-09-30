import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveEntityTenant, isCrossTenantRow } from './formTenantScope.js';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

// Minimal fake supabase client: rows keyed by table -> id -> row.
function fakeSupabase(rowsByTable) {
  return {
    from(table) {
      const q = {
        _id: null,
        select() { return q; },
        eq(_col, val) { q._id = val; return q; },
        async maybeSingle() {
          return { data: rowsByTable[table]?.[q._id] || null, error: null };
        },
      };
      return q;
    },
  };
}

test('authenticated submission without body tenant resolves the form tenant', async () => {
  const supabase = fakeSupabase({ form: { 'form-1': { tenant_id: TENANT_A } } });
  const r = await resolveEffectiveEntityTenant(supabase, { tenant_id: null, form_id: 'form-1', submission_id: null });
  assert.equal(r.tenantId, TENANT_A);
  assert.equal(r.source, 'form');
  assert.equal(r.mismatch, null);
});

test('falls back to the submission tenant when the form has none', async () => {
  const supabase = fakeSupabase({
    form: { 'form-1': { tenant_id: null } },
    form_submission: { 'sub-1': { tenant_id: TENANT_A } },
  });
  const r = await resolveEffectiveEntityTenant(supabase, { tenant_id: null, form_id: 'form-1', submission_id: 'sub-1' });
  assert.equal(r.tenantId, TENANT_A);
  assert.equal(r.source, 'form_submission');
  assert.equal(r.mismatch, null);
});

test('malicious body tenant that mismatches the form tenant is flagged, authoritative tenant wins', async () => {
  const supabase = fakeSupabase({ form: { 'form-1': { tenant_id: TENANT_A } } });
  const r = await resolveEffectiveEntityTenant(supabase, { tenant_id: TENANT_B, form_id: 'form-1', submission_id: null });
  assert.equal(r.tenantId, TENANT_A);
  assert.deepEqual(r.mismatch, { supplied: TENANT_B, authoritative: TENANT_A });
});

test('body tenant matching the authoritative tenant is accepted', async () => {
  const supabase = fakeSupabase({ form: { 'form-1': { tenant_id: TENANT_A } } });
  const r = await resolveEffectiveEntityTenant(supabase, { tenant_id: TENANT_A, form_id: 'form-1', submission_id: null });
  assert.equal(r.tenantId, TENANT_A);
  assert.equal(r.mismatch, null);
});

test('body tenant is only used when no authoritative tenant exists (legacy forms)', async () => {
  const supabase = fakeSupabase({ form: {}, form_submission: {} });
  const r = await resolveEffectiveEntityTenant(supabase, { tenant_id: TENANT_A, form_id: 'missing', submission_id: 'missing' });
  assert.equal(r.tenantId, TENANT_A);
  assert.equal(r.source, 'request_body');
  assert.equal(r.mismatch, null);
});

test('no tenant anywhere resolves to null without a mismatch', async () => {
  const supabase = fakeSupabase({});
  const r = await resolveEffectiveEntityTenant(supabase, { tenant_id: null, form_id: null, submission_id: null });
  assert.equal(r.tenantId, null);
  assert.equal(r.source, null);
  assert.equal(r.mismatch, null);
});

test('isCrossTenantRow rejects rows from a different tenant', () => {
  assert.equal(isCrossTenantRow(TENANT_A, { id: 'x', tenant_id: TENANT_B }), true);
});

test('isCrossTenantRow accepts same-tenant and legacy NULL-tenant rows', () => {
  assert.equal(isCrossTenantRow(TENANT_A, { id: 'x', tenant_id: TENANT_A }), false);
  assert.equal(isCrossTenantRow(TENANT_A, { id: 'x', tenant_id: null }), false);
});

test('isCrossTenantRow is permissive when no effective tenant is known', () => {
  assert.equal(isCrossTenantRow(null, { id: 'x', tenant_id: TENANT_B }), false);
  assert.equal(isCrossTenantRow(TENANT_A, null), false);
});
