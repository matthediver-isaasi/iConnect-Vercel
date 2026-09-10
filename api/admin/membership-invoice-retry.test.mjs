import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./membership-invoice-retry.js', import.meta.url), 'utf8');

test('paid Stripe form memberships are identified from both payment and history linkage', () => {
  assert.match(source, /\.eq\('tenant_id', appTenantId\)/);
  assert.match(source, /\.eq\('payment_provider', 'stripe'\)/);
  assert.match(source, /\.eq\('payment_status', 'paid'\)/);
  assert.match(source, /\.eq\('payment_reference', row\.stripe_payment_intent_id\)/);
  assert.match(
    source,
    /\.filter\('payment_meta->membership_result->>history_id', 'eq', recordId\)/,
  );
});

test('form repairs require finance permission and route linked invoices to settlement', () => {
  const formBranch = source.indexOf('if (formSubmission) {');
  const genericInvoiceBranch = source.indexOf('// If the row already has an invoice id');
  const genericMint = source.indexOf('provider.createMembershipInvoice({');

  assert.ok(formBranch > -1);
  assert.ok(formBranch < genericInvoiceBranch);
  assert.ok(genericInvoiceBranch < genericMint);
  assert.match(
    source.slice(formBranch, genericInvoiceBranch),
    /hasFeatureAccess\(tenantContext\.roleId, 'commerce\.monthly-finance-report'\)/,
  );
  assert.match(
    source.slice(formBranch, genericInvoiceBranch),
    /req\.body = \{[\s\S]*\.\.\.\(req\.body \|\| \{\}\),[\s\S]*recordId,[\s\S]*table,[\s\S]*submissionId: formSubmission\.id[\s\S]*formInvoiceSettlementHandler\(req, res\)/,
  );
});

test('unlinked form memberships cannot fall through to generic invoice minting', () => {
  const formBranch = source.indexOf('if (formSubmission) {');
  const genericInvoiceBranch = source.indexOf('// If the row already has an invoice id');
  const guardedSource = source.slice(formBranch, genericInvoiceBranch);

  assert.match(guardedSource, /Generic invoice retry is disabled/);
  assert.match(guardedSource, /retryable: true/);
  assert.match(guardedSource, /recovery: 'form_membership_finalize'/);
  assert.doesNotMatch(guardedSource, /createMembershipInvoice/);
});