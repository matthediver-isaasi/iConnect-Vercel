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

test('authorization, paid lifecycle, and stored submit-control all precede structured side effects', () => {
  const auth = src.indexOf('verifyFormProcessingRequest(req');
  const payment = src.indexOf('canProcessPersistedPaymentStatus(persistedSubmission.payment_status, { trustedInternal })');
  const submitControl = src.indexOf('const authoritativeSubmitControl = resolveSubmitControl');
  const structured = src.indexOf('processPersistedStructuredActions({');
  assert.ok(auth > -1 && payment > auth && submitControl > payment && structured > submitControl);
  assert.match(src, /form_values = authoritativeAnswers;/);
  assert.match(src, /fields = persistedForm\.fields \|\| \[\];/);
  assert.match(src, /entity_pipelines = hasPersistedLegacyFormEntityActions\(persistedForm\)/);
  assert.match(src, /\? persistedForm\.entity_pipelines\s*: \{ members: \[\], organisations: \[\] \};/);
  assert.match(src, /role_id = derivePersistedFormRole\(\{/);
  assert.match(src, /const prefillTargets = resolveFormProcessingPrefillTargets\(\{/);
  assert.match(src, /const processingAuthorization = \{[\s\S]*?isAdmin: authorizedAdmin,[\s\S]*?verifiedMemberId: authenticatedSubmitterMember\?\.id/);
  assert.match(src, /authorization: processingAuthorization,/);
  assert.match(src, /persistedSubmission\.payment_meta\?\.verified_submitter_member_id/);
  assert.match(src, /code:\s*'PROCESSING_IDENTITY_MISMATCH'/);
  assert.match(src, /resolveTrustedFormProcessingAdmin\(\{[\s\S]*?trustedInternal,[\s\S]*?verifiedAdminAccess: verified_admin_access/);
  assert.match(src, /persistedSubmission\.payment_meta\?\.verified_admin_access === true/);
  assert.match(src, /code:\s*'PROCESSING_AUTHORITY_MISMATCH'/);
});

test('legacy pipeline and action derivation happens only after persisted configuration replaces request copies', () => {
  const persistedPipelineAssignment = src.indexOf('entity_pipelines = hasPersistedLegacyFormEntityActions(persistedForm)');
  const pipelineNormalization = src.indexOf('const memberPipelines = entity_pipelines?.members || [];');
  const actionResolution = src.indexOf('} = resolveFormEntityActions({');
  assert.ok(persistedPipelineAssignment > 0);
  assert.ok(pipelineNormalization > persistedPipelineAssignment);
  assert.ok(actionResolution > persistedPipelineAssignment);
  assert.equal(src.slice(0, persistedPipelineAssignment).includes('const memberPipelines ='), false);
  assert.equal(src.slice(0, persistedPipelineAssignment).includes('resolveFormEntityActions({'), false);
  assert.match(src, /: \{ members: \[\], organisations: \[\] \};/);
});

test('legacy existing-record reuse is ownership-gated before primary and additional mutations', () => {
  const authContext = src.indexOf('const processingAuthorization = {');
  const orgGate = src.indexOf("assertLegacyExistingRecordAuthorized('organization', existingOrg.id);");
  const memberGate = src.indexOf("assertLegacyExistingRecordAuthorized('member', existingMember.id);");
  const additionalGate = src.indexOf("assertLegacyExistingRecordAuthorized('member', existingMemberId);");
  assert.ok(authContext > 0);
  assert.ok(orgGate > authContext);
  assert.ok(memberGate > orgGate);
  assert.ok(additionalGate > memberGate);
  assert.ok(orgGate < src.indexOf("supabase.from('organization').update(orgUpdateData)"));
  assert.ok(memberGate < src.indexOf("table: 'member'", memberGate));
  assert.ok(additionalGate < src.indexOf("table: 'member'", additionalGate));
  assert.match(src, /authorization: processingAuthorization,/);
  assert.match(src, /error instanceof StructuredActionAuthorizationError/);
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

test('non-deferred member communication writes use the shared RBAC persistence boundary', () => {
  assert.match(src, /await persistFormCommunicationSubscriptions\(\{/);
  assert.match(src, /tenantId: effectiveEntityTenantId/);
  assert.match(src, /resolvedMemberId: createdMemberId/);
  assert.ok(
    !src.includes(".from('member_communication_preference')"),
    'process-application must not bypass the shared communication eligibility guard',
  );
});
