// Regression tripwire for the ordering of tenant resolution inside
// api/forms/process-application.js.
//
// The authoritative tenant (resolveEffectiveEntityTenant) and the
// TENANT_MISMATCH rejection MUST run before ANY tenant-scoped database query
// — in particular before the server-side uniqueness-validation block — so a
// client-controlled body tenant_id can never influence a tenant-scoped query
// prior to rejection. The handler wires a live supabase client at import
// time, so this is asserted structurally against the source rather than by
// invoking the handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const src = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'process-application.js'),
  'utf8'
);

const idx = (needle) => {
  const i = src.indexOf(needle);
  assert.notEqual(i, -1, `expected to find: ${needle}`);
  return i;
};

test('tenant resolution + mismatch rejection run before uniqueness validation', () => {
  const resolveAt = idx('await resolveEffectiveEntityTenant(supabase,');
  const mismatchAt = idx("code: 'TENANT_MISMATCH'");
  const uniquenessAt = idx('SERVER-SIDE UNIQUENESS VALIDATION');
  assert.ok(resolveAt < uniquenessAt, 'resolveEffectiveEntityTenant must run before the uniqueness block');
  assert.ok(mismatchAt < uniquenessAt, 'TENANT_MISMATCH rejection must precede the uniqueness block');
});

test('tenant is resolved exactly once and mismatch rejects with 403', () => {
  assert.equal(src.split('await resolveEffectiveEntityTenant(supabase,').length - 1, 1);
  const rejectBlock = src.slice(idx('tenantResolution.mismatch'), idx("code: 'TENANT_MISMATCH'"));
  assert.match(rejectBlock, /status\(403\)/);
});

test('uniqueness validation uses the authoritative tenant, not the raw body tenant', () => {
  const uniquenessAt = idx('SERVER-SIDE UNIQUENESS VALIDATION');
  // Window sized to reach the uniqueness loop even with intervening blocks
  // (e.g. the submit-control re-evaluation inserted between the marker and
  // the tenant assignment).
  const block = src.slice(uniquenessAt, uniquenessAt + 4000);
  assert.match(block, /effectiveTenantId = effectiveEntityTenantId \|\| formData\.tenant_id/);
  assert.ok(!/effectiveTenantId = tenant_id/.test(block), 'uniqueness block must not trust body tenant_id');
});

test('org resolution and org UPDATE go through the shared tenant-guarded helpers (Task #3550)', () => {
  // Resolution must use the unit-tested shared chain, and the organisation
  // UPDATE must be wrapped in the write-time tenant guard so a cross-tenant
  // row can never be mutated regardless of how it was resolved.
  idx('await resolveExistingOrganization(supabase,');
  idx('applyOrgWriteTenantGuard(');
  idx("code: 'CROSS_TENANT_ORG_WRITE'");
  // The guarded update must check affected rows (0 rows = guard fired).
  const guardAt = idx('applyOrgWriteTenantGuard(');
  const window = src.slice(guardAt, guardAt + 1500);
  assert.match(window, /updatedRows\.length === 0/);
});

test('no tenant-scoped query trusts the raw body tenant after resolution', () => {
  // Every .eq('tenant_id', ...) filter and tenant stamp in the handler must use
  // the resolved tenant; the raw body value may only appear in equality
  // validation, logging/diagnostics, or comments.
  assert.ok(!src.includes(".eq('tenant_id', tenant_id)"), "found .eq('tenant_id', tenant_id) using the raw body value");
  assert.ok(!/tenant_id:\s*tenant_id\s*[,}]\s*\n\s*\}?\)?\s*\.select/.test(src));
});
