import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
const payloadSource = await readFile(new URL('../_lib/publicFormProcessingPayload.js', import.meta.url), 'utf8');
const processorSource = await readFile(new URL('../forms/process-application.js', import.meta.url), 'utf8');

test('no-action submissions do not require an internal processing origin', () => {
  const actionGate = source.indexOf('if ((hasEntityPipelines || hasCurrentSetProcessing) && !surveyIsAnonymous)');
  const originResolution = source.indexOf(
    'const internalApiBaseUrl = dependencies.internalApiBaseUrl || getInternalApiBaseUrl(null)',
    actionGate,
  );
  assert.ok(actionGate > -1 && originResolution > actionGate);
  // Current-set reconciliation is deliberately an additional server-side
  // action. Ordinary forms with neither persisted entity actions nor the
  // target-form current-set configuration bypass this entire block.
  assert.match(source, /const hasEntityPipelines = hasPersistedFormEntityActions\(form\);/);
  assert.match(source, /const hasCurrentSetProcessing = !!currentSetConfiguration;/);
});

test('public submission processing retains legacy action configurations', () => {
  assert.match(source, /from\('form'\)\s*\.select\('\*'\)/,
    'the complete server-only form projection retains all legacy actions and the continuation digest');
  for (const key of ['member_entity_action', 'organization_entity_action', 'additional_member_creations']) {
    assert.ok(processorSource.includes(`persistedForm.${key}`),
      `the processor reloads authoritative ${key} rather than trusting the handoff`);
  }
  assert.match(source, /hasPersistedFormEntityActions\(form\)/);
});

test('public processing binds server-derived tenant admin authority into the signed hop', () => {
  const deriveAt = source.indexOf('sessionHasAdminAccess = tenantContext?.tenantId === tenantData.id');
  const signAt = source.indexOf('verifiedAdminAccess: sessionHasAdminAccess');
  const bodyAt = source.indexOf('body: JSON.stringify(buildPublicFormProcessingPayload({');
  assert.ok(deriveAt > -1 && signAt > deriveAt && bodyAt > signAt);
  assert.match(source.slice(bodyAt), /verifiedAdminAccess:\s*sessionHasAdminAccess/);
  assert.match(payloadSource, /verified_admin_access:\s*verifiedAdminAccess/);
  assert.match(source, /await \(dependencies\.hasAdminAccess \|\| hasAdminAccess\)\(tenantContext\)/);
  assert.doesNotMatch(
    source.slice(source.indexOf('const { form_id,'), source.indexOf('} = req.body;') + 13),
    /verified_admin_access/,
  );
});