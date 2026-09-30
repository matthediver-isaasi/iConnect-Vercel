import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'relationship-display-labels.js'), 'utf8');

test('tenant dashboard users proceed without a member role after authenticated tenant validation', () => {
  assert.match(source, /import \{ getTenantContext \}/);
  assert.match(source, /const tenantCtx = await getTenantContext\(req\)/);
  assert.match(source, /!tenantCtx\.isAuthenticated \|\| !tenantCtx\.tenantId \|\| tenantCtx\.tenantMismatch/);
  assert.match(source, /if \(!tenantCtx\.tenantUserId\)/);
});

test('no-auth and cross-tenant mismatch contexts are denied', () => {
  assert.match(source, /!tenantCtx\.isAuthenticated/);
  assert.match(source, /!tenantCtx\.tenantId/);
  assert.match(source, /tenantCtx\.tenantMismatch/);
  assert.match(source, /return res\.status\(401\)\.json\(\{ error: 'Not authenticated' \}\)/);
});

test('member access retains tenant-scoped role and excluded-feature enforcement', () => {
  assert.match(source, /if \(!tenantCtx\.roleId\)/);
  assert.match(source, /\.eq\('id', tenantCtx\.roleId\)[\s\S]*?\.eq\('tenant_id', tenantCtx\.tenantId\)/);
  assert.match(source, /tenantCtx\.memberExcludedFeatures/);
  assert.match(source, /canAccessRelationshipLabelContext\(excludedFeatures, context\)/);
});

test('submission authorization remains tenant scoped and submission bound', () => {
  assert.match(source, /resolveReviewSubmissionIds\(supabase, tenantCtx\.tenantId, submissionIds\)/);
  assert.match(
    source,
    /loadSubmissionScopedRelationshipDisplayLabels\(\s*supabase,\s*tenantCtx\.tenantId,\s*authorizedSubmissionIds,\s*recordIds/,
  );
});
