import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
const payloadSource = await readFile(new URL('../_lib/publicFormProcessingPayload.js', import.meta.url), 'utf8');

test('no-action submissions do not require an internal processing origin', () => {
  const actionGate = source.indexOf('if (hasEntityPipelines && !surveyIsAnonymous)');
  const originResolution = source.indexOf(
    'const baseUrl = dependencies.internalApiBaseUrl || getInternalApiBaseUrl(null)',
  );
  assert.ok(actionGate > -1 && originResolution > actionGate);
});

test('public submission processing retains legacy action configurations', () => {
  assert.match(source, /member_entity_action, organization_entity_action, additional_member_creations/);
  assert.match(source, /hasPersistedFormEntityActions\(form\)/);
});

test('public processing binds server-derived tenant admin authority into the signed hop', () => {
  const deriveAt = source.indexOf('sessionHasAdminAccess = tenantContext?.tenantId === tenantData.id');
  const signAt = source.indexOf('verifiedAdminAccess: sessionHasAdminAccess');
  const bodyAt = source.indexOf('body: JSON.stringify(buildPublicFormProcessingPayload({');
  assert.ok(deriveAt > -1 && signAt > deriveAt && bodyAt > signAt);
  assert.match(source.slice(bodyAt), /verifiedAdminAccess:\s*sessionHasAdminAccess/);
  assert.match(payloadSource, /verified_admin_access:\s*verifiedAdminAccess/);
  assert.match(source, /await hasAdminAccess\(tenantContext\)/);
  assert.doesNotMatch(
    source.slice(source.indexOf('const { form_id,'), source.indexOf('} = req.body;') + 13),
    /verified_admin_access/,
  );
});