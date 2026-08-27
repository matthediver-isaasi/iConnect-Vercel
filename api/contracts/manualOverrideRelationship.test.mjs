import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authorizeManualContractOverride } from './manual-override.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'manual-override.js'), 'utf8');

test('manual override requires admin authorization before reading request data or contracts', () => {
  assert.match(source, /import \{ getTenantContext, hasAdminAccess \}/);
  assert.match(source, /authorizeManualContractOverride\(tenantContext\)/);

  const auth = source.indexOf('authorizeManualContractOverride(tenantContext)');
  const body = source.indexOf('const {', source.indexOf('tenantContext'));
  const firstRead = source.indexOf(".from('contract_instance')");
  assert.ok(auth > -1 && auth < body, 'admin authorization must precede request processing');
  assert.ok(auth < firstRead, 'admin authorization must precede contract reads');
});

test('manual override authorization denies members and permits admins', async () => {
  let calls = 0;
  assert.deepEqual(await authorizeManualContractOverride(null, {
    hasAdminAccessFn: async () => {
      calls += 1;
      return true;
    },
  }), { status: 401, error: 'Unauthorized' });
  assert.equal(calls, 0, 'unauthenticated requests must not reach admin checks');

  assert.deepEqual(await authorizeManualContractOverride(
    { isAuthenticated: true, tenantId: 'tenant-1', memberId: 'member-1' },
    { hasAdminAccessFn: async () => false },
  ), { status: 403, error: 'Admin access required' });

  assert.equal(await authorizeManualContractOverride(
    { isAuthenticated: true, tenantId: 'tenant-1', tenantUserId: 'admin-1' },
    { hasAdminAccessFn: async () => true },
  ), null);
});

test('manual overrides validate full answers against tenant-scoped saved contract fields', () => {
  assert.match(
    source,
    /\.from\('form'\)[\s\S]*?\.select\('id, name, description, slug, contract_settings, fields'\)[\s\S]*?\.eq\('id', contractFormId\)[\s\S]*?\.eq\('tenant_id', tenantContext\.tenantId\)/,
  );
  assert.match(
    source,
    /\.validateSubmission\(\{ form: contractForm, submissionData: fullSubmissionData \}\)/,
  );
});

test('manual override validation dominates the contract answer-data insert', () => {
  const fullData = source.indexOf('const fullSubmissionData = {');
  const validation = source.indexOf(
    '.validateSubmission({ form: contractForm, submissionData: fullSubmissionData })',
  );
  const answerInsert = source.indexOf('const { data: newSubmission, error: submissionError }');
  assert.ok(fullData > -1 && validation > fullData, 'full submission data must exist before validation');
  assert.ok(answerInsert > validation, 'validation must complete before the answer-data insert');
  assert.match(
    source.slice(answerInsert),
    /submission_data: fullSubmissionData/,
  );
});

test('manual override relationship failures return only generic client errors', () => {
  assert.match(source, /error instanceof FormRelationshipError && error\.status < 500/);
  assert.match(source, /status\(400\)\.json\(\{ error: 'Invalid relationship selection' \}\)/);
  assert.match(source, /status\(500\)\.json\(\{ error: 'Failed to validate submission' \}\)/);
});