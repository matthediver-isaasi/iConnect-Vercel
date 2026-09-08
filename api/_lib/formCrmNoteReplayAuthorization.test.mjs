import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const processorPath = new URL('../forms/process-application.js', import.meta.url);
const migrationPath = new URL('../../migrations/add_form_crm_note_idempotency.sql', import.meta.url);

test('additional-member CRM-note retries use persisted pipeline evidence, never submitted email discovery', async () => {
  const source = await readFile(processorPath, 'utf8');
  const retryStart = source.indexOf("const { data: pipelineEntityLinks, error: pipelineEntityLinksError }");
  const retryEnd = source.indexOf('const relatedRecords = await processPrimaryPipelineRelatedRecords', retryStart);
  assert.ok(retryStart > 0 && retryEnd > retryStart);
  const retryBranch = source.slice(retryStart, retryEnd);

  assert.match(retryBranch, /\.from\('form_submission_pipeline_entity'\)/);
  assert.match(retryBranch, /\.eq\('tenant_id', effectiveEntityTenantId\)/);
  assert.match(retryBranch, /\.eq\('form_submission_id', submission_id\)/);
  assert.match(retryBranch, /persistedPipelineTargetId\('member', additionalPipeline\)/);
  assert.doesNotMatch(retryBranch, /\.ilike\('email'/);
});

test('normal additional-member processing records the authorized target before note persistence', async () => {
  const source = await readFile(processorPath, 'utf8');
  const linkWrite = source.indexOf("if (submission_id && memberConfig.id && existingMemberId)");
  const noteWrite = source.indexOf(
    'additionalMemberPipelineTargets.get(String(additionalPipeline.id))',
    linkWrite,
  );
  assert.ok(linkWrite > 0 && noteWrite > linkWrite);
  const evidenceWrite = source.slice(linkWrite, noteWrite);
  assert.match(evidenceWrite, /persistPipelineEntityCheckpoint\('member', memberConfig, existingMemberId\)/);
});

test('all normal-path CRM notes run after the durable submission linkage checkpoint', async () => {
  const source = await readFile(processorPath, 'utf8');
  const finalUpdate = source.indexOf(".from('form_submission')", source.indexOf('let submissionLinkagePersisted'));
  const linkageConfirmation = source.indexOf('submissionLinkagePersisted = true', finalUpdate);
  const deferredNotes = source.indexOf("persistCrmNotesForPipeline(", linkageConfirmation);
  assert.ok(finalUpdate > 0 && linkageConfirmation > finalUpdate && deferredNotes > linkageConfirmation);

  const normalProcessingStart = source.indexOf('// Process organization first');
  const normalProcessingBeforeCheckpoint = source.slice(normalProcessingStart, linkageConfirmation);
  assert.doesNotMatch(normalProcessingBeforeCheckpoint, /await persistCrmNotesForPipeline/);
});

test('partial pipeline evidence resumes only that exact pipeline and never marks the whole submission complete', async () => {
  const source = await readFile(processorPath, 'utf8');
  assert.match(source, /\.select\('created_member_id, created_organization_id, entity_processing_completed_at'\)/);
  assert.match(source, /\|\| existingSubmission\?\.entity_processing_completed_at/);
  assert.doesNotMatch(source, /\|\| pipelineEntityLinks\?\.length > 0/);
  assert.match(
    source,
    /checkpointMemberId = persistedPipelineTargetId\('member', memberConfig\)[\s\S]*String\(checkpointMemberId \|\| ''\) !== String\(existingMemberId\)[\s\S]*assertLegacyExistingRecordAuthorized/,
  );
  assert.match(source, /updatePayload\.entity_processing_completed_at = new Date\(\)\.toISOString\(\)/);
});

test('primary and additional pipeline checkpoints authorize only their exact entity targets', async () => {
  const source = await readFile(processorPath, 'utf8');
  assert.match(source, /persistPipelineEntityCheckpoint\(\s*'organization',\s*resolvePrimaryOrganizationPipeline\(orgPipelines\),\s*createdOrganizationId/);
  assert.match(source, /persistPipelineEntityCheckpoint\(\s*'member',\s*memberPipelines\.find\(item => item\.isPrimary \|\| item\.is_primary\),\s*createdMemberId/);
  assert.match(source, /persistedPipelineTargetId\('organization', primaryOrgPipeline\)/);
  assert.match(source, /persistedPipelineTargetId\('member', primaryMemberPipeline\)/);
  assert.match(source, /persistedPipelineTargetId\('member', memberConfig\)/);
  assert.match(source, /if \(updateError\)[\s\S]*throw updateError/);
  assert.match(source, /if \(memberError\)[\s\S]*throw memberError/);
});

test('uniqueness checks exclude exact replay targets but retain unrelated conflicts', async () => {
  const source = await readFile(processorPath, 'utf8');
  const uniquenessStart = source.indexOf('SERVER-SIDE UNIQUENESS VALIDATION');
  const uniquenessEnd = source.indexOf('const memberData = {}', uniquenessStart);
  const uniquenessBlock = source.slice(uniquenessStart, uniquenessEnd);
  assert.match(uniquenessBlock, /\.filter\(link => link\.entity_type === tableName && link\.entity_id\)/);
  assert.match(uniquenessBlock, /query = query\.neq\('id', replayTargetId\)/);
  assert.match(uniquenessBlock, /if \(count && count > 0\)/);
});

test('pipeline replay evidence is server-only and tenant-keyed in the database', async () => {
  const migration = await readFile(migrationPath, 'utf8');
  assert.match(migration, /UNIQUE \(tenant_id, form_submission_id, entity_type, pipeline_id\)/);
  assert.match(migration, /REVOKE ALL ON TABLE form_submission_pipeline_entity FROM PUBLIC, anon, authenticated/);
});