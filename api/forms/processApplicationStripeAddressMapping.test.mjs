import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./process-application.js', import.meta.url), 'utf8');

test('Stripe address mappings run after normal and related-record mappings', () => {
  const related = source.lastIndexOf('const relatedRecords = await processPrimaryPipelineRelatedRecords');
  const stripe = source.lastIndexOf('const stripeAddressMappings = await processPersistedStripeAddressMappings');
  const completion = source.lastIndexOf('updatePayload.entity_processing_completed_at');
  assert.ok(related >= 0 && stripe > related && completion > stripe);
});

test('entity creation provenance is persisted immediately for both primary targets', () => {
  assert.match(source, /persistEntityCreationProvenance\('organization', orgInsertData\.id\)[\s\S]{0,400}\.from\('organization'\)\s*\.insert\(orgInsertData\)/);
  assert.match(source, /persistEntityCreationProvenance\('member', memberInsertData\.id\)[\s\S]{0,400}\.from\('member'\)\s*\.insert\(memberInsertData\)/);
});

test('failed post-insert retries adopt verified provenance before email/name resolution', () => {
  assert.match(source, /loadPersistedFormEntityCreations\(\{[\s\S]*submissionId: submission_id/);
  assert.match(source, /effectivePrefillOrgId = persistedCreatedOrganizationId \|\| prefill_organization_id/);
  assert.match(source, /effectivePrefillMemberId = persistedCreatedMemberId \|\| prefill_member_id/);
  assert.match(source, /organization: new Set\(persistedEntityCreations\.organization\)/);
  assert.match(source, /\.\.\.persistedEntityCreations\.member/);
});

test('completed address ledger bypasses every normal processing side effect', () => {
  const ledger = source.indexOf("from('form_stripe_address_mapping_ledger')");
  const structured = source.indexOf('processPersistedStructuredActions({');
  const organizationProcessing = source.indexOf('// Process organization based on orgAction');
  assert.ok(ledger >= 0 && ledger < structured && ledger < organizationProcessing);
  const completedBranch = source.slice(ledger, structured);
  assert.match(completedBranch, /if \(completedAddressMapping\) \{[\s\S]*return res\.json/);
});

test('target-resolution signature drift rejects before processor side effects', () => {
  const ledger = source.indexOf("from('form_stripe_address_mapping_ledger')");
  const signature = source.indexOf('validateStripeAddressTargetResolution(', ledger);
  const structured = source.indexOf('processPersistedStructuredActions({');
  assert.ok(ledger >= 0 && signature > ledger && signature < structured);
  assert.match(source.slice(signature, structured), /STRIPE_ADDRESS_TARGET_RESOLUTION_DRIFT/);
});