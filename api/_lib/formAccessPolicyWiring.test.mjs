import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => readFileSync(path.join(here, relativePath), 'utf8');

function assertOrdered(source, earlier, later, label) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.notEqual(earlierIndex, -1, `${label}: missing ${earlier}`);
  assert.notEqual(laterIndex, -1, `${label}: missing ${later}`);
  assert.ok(earlierIndex < laterIndex, `${label}: ${earlier} must run before ${later}`);
}

test('single-form and survey reads authorize before releasing public content', () => {
  const single = read('../public/form/[slug].js');
  assertOrdered(single, 'const access = await resolveFormAccess', 'const publicForm = {}', 'single form');
  assertOrdered(single, 'if (!access.allowed) return sendFormAccessDenied', 'const publicForm = {}', 'single form');

  const survey = read('../public/survey-assignment/[token].js');
  assert.match(survey, /import \{ isFormScheduleAvailable \}/);
  assertOrdered(survey, 'if (!isFormScheduleAvailable(form))', 'const access = await resolveFormAccess', 'survey assignment');
  assertOrdered(survey, 'const access = await resolveFormAccess', 'const baseResponse = {', 'survey assignment');
  assertOrdered(survey, 'if (!access.allowed) return sendFormAccessDenied', 'const baseResponse = {', 'survey assignment');
});

test('public form lists omit denied records rather than returning partial metadata', () => {
  const source = read('../public/forms.js');
  assert.match(source, /availableForms = \(forms \|\| \[\]\)\.filter\(\(form\) => isFormScheduleAvailable\(form\)\)/);
  assert.match(source, /if \(!access\.allowed\) return null/);
  assert.match(source, /\.filter\(Boolean\)/);
});

test('submission authorization runs before form submission processing', () => {
  const source = read('../public/form-submission.js');
  assertOrdered(source, 'const formAccess = await resolveFormAccess', 'let surveyAssignment = null', 'submission');
  assertOrdered(source, 'if (!formAccess.allowed) return sendFormAccessDenied', 'let surveyAssignment = null', 'submission');
});

test('all draft operations resolve policy before reading or mutating draft content', () => {
  const source = read('../public/form-draft.js');
  assert.match(source, /import \{ isFormScheduleAvailable \}/);
  assert.equal((source.match(/resolveFormAccess\(\{/g) || []).length, 3);
  assert.equal((source.match(/sendFormAccessDenied\(res, access\)/g) || []).length, 3);
  assert.equal((source.match(/if \(!isFormScheduleAvailable\(form\)\)/g) || []).length, 3);
  assert.match(source, /\.select\('id, tenant_id, access_policy, deactivate_at'\)/);
  assert.match(source, /\.select\('id, slug, name, access_policy, deactivate_at'\)/);
  assert.match(source, /\.select\('access_policy, deactivate_at'\)/);
  assertOrdered(source, 'if (!isFormScheduleAvailable(form))', 'const access = await resolveFormAccess', 'draft create/update');
  assertOrdered(source, 'const access = await resolveFormAccess', '// Calculate expiry date', 'draft create/update');
  assertOrdered(source, '.select(\'id, slug, name, access_policy, deactivate_at\')', 'draft_data: draft.draft_data', 'draft read');
  const deleteSection = source.slice(source.indexOf('// DELETE: Abandon/delete a draft'));
  assertOrdered(deleteSection, '.select(\'access_policy, deactivate_at\')', '.delete()', 'draft delete');
});

test('payment quote and create actions require live access while proven return legs can finalize', () => {
  const source = read('../public/form-payment.js');
  assert.match(source, /async function authorizePaymentStart/);
  assert.equal((source.match(/await authorizePaymentStart\(req, res, supabase, tenantData, form\)/g) || []).length, 4);
  assert.match(source, /withFormPaymentAccessProof/);
  assert.match(source, /if \(!row\.payment_meta\?\.access_authorized_at\)/);
  assert.match(source, /Failed to persist live access authorization/);
  assertOrdered(source, 'if (!row.payment_meta?.access_authorized_at)', 'if (row.payment_status === \'paid\')', 'payment confirm');
});

test('generic FormSubmission writes cannot bypass access or forge payment proof', () => {
  const source = read('../entities/[entity]/index.js');
  const block = source.slice(
    source.indexOf("if (entityNorm === 'formsubmission') {", source.indexOf('let formSubmissionForm')),
    source.indexOf('// FormSubmission duplicate guard'),
  );
  assert.match(block, /resolveFormAccess\(\{/);
  assert.match(block, /sendFormAccessDenied\(res, formAccess\)/);
  assert.match(block, /\.eq\('tenant_id', sanitizedBody\.tenant_id\)/);
  assert.match(block, /\.eq\('is_active', true\)/);
  assert.match(block, /isFormScheduleAvailable\(accessForm\)/);
  assert.match(block, /'payment_meta'/);
  assertOrdered(source, 'const formAccess = await resolveFormAccess', 'let formSubmissionIdemKey = null', 'generic submission');
});

test('generic FormSubmission PATCH cannot alter server-owned payment authorization', () => {
  const source = read('../entities/[entity]/[id].js');
  const block = source.slice(
    source.indexOf("if (entityNormalized === 'formsubmission') {"),
    source.indexOf('// For Organization/Member/JobPosting'),
  );
  for (const field of [
    'payment_status',
    'payment_provider',
    'payment_reference',
    'payment_amount',
    'payment_currency',
    'payment_meta',
    'payment_paid_at',
  ]) {
    assert.match(block, new RegExp(`'${field}'`));
  }
  assert.match(block, /Form payment state can only be changed by the payment service/);
});

test('all asynchronous payment sweeps require trusted proof for restricted forms', () => {
  const reconciliation = read('./formPaymentReconciliation.js');
  assert.match(reconciliation, /import \{ hasFormPaymentAccessProof \}/);
  assert.ok(
    (reconciliation.match(/hasFormPaymentAccessProof\(row, form\)/g) || []).length >= 4,
    'pending, unfinalized, membership, and monthly-card sweeps must all check proof',
  );
  const monthlyFinalize = read('./formMonthlyCardFinalize.js');
  assertOrdered(
    monthlyFinalize,
    'if (!hasFormPaymentAccessProof(submission, form))',
    '// ── CAS pending → setup_complete',
    'monthly-card webhook finalizer',
  );
});

test('generic form creates and updates validate and canonicalize stored policies', () => {
  for (const relativePath of ['../entities/[entity]/index.js', '../entities/[entity]/[id].js']) {
    const source = read(relativePath);
    assert.match(source, /validateFormAccessPolicy\(\{/);
    assert.match(source, /INVALID_FORM_ACCESS_POLICY/);
    assert.match(source, /sanitizedBody\.access_policy = validation\.policy/);
  }
});