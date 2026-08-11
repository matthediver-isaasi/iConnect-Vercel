// Regression tests for Task #3536: a workflow "Create Membership" action
// targeting an ORGANISATION must raise the accounting invoice after
// inserting the membership record. The org path previously stopped right
// after the insert (only the member-driven path invoiced), so workflow-
// created org memberships were silently invoice-less.
//
// Source-contract style (same pattern as formMembershipSweep.test.mjs):
// assert the org action body wires the shared invoicing pieces in the
// right order, keeps the mode/approval guards ahead of any insert, and
// surfaces invoice failure as a partial (not clean success) result.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./workflows.js', import.meta.url), 'utf8');

const orgFnAt = src.indexOf('async function executeCreateMembershipAction');
assert.ok(orgFnAt > -1, 'executeCreateMembershipAction must exist');
const orgFnEnd = src.indexOf('async function executeCreateMemberMembership', orgFnAt);
assert.ok(orgFnEnd > orgFnAt, 'member-driven executor must follow the org executor');
const orgFn = src.slice(orgFnAt, orgFnEnd);

const insertAt = orgFn.indexOf(".from('organisation_membership_history')\n      .insert(record)");
assert.ok(insertAt > -1, 'org membership insert must exist');

test('org path raises the accounting invoice after inserting the record', () => {
  const invoiceAt = orgFn.indexOf('provider.createMembershipInvoice', insertAt);
  assert.ok(invoiceAt > insertAt, 'createMembershipInvoice must be called after the org insert');
  const invoiceBlock = orgFn.slice(insertAt, orgFn.length);
  // Shared pieces used by the manual "Renew & Invoice Now" and cron paths.
  assert.match(invoiceBlock, /getAccountingProvider\(tenantId\)/);
  assert.match(invoiceBlock, /resolveInvoiceAddress\(supabase, simResult\.config, organizationId, 'organization'\)/);
  assert.match(invoiceBlock, /resolveMembershipNominalCode\(supabase, tenantId, simResult\)/);
  // Dual provider id columns (Xero + QBO) linked back onto the record.
  assert.match(invoiceBlock, /buildInvoiceColumnUpdate\(invoice\)/);
  const linkAt = invoiceBlock.indexOf('buildInvoiceColumnUpdate(invoice)');
  const linkScope = invoiceBlock.slice(linkAt - 300, linkAt);
  assert.match(linkScope, /organisation_membership_history/);
});

test('org invoice carries fee-approval add-on lines and runs training-fund processing', () => {
  const invoiceBlock = orgFn.slice(insertAt);
  assert.match(orgFn, /loadAddonLines\(tenantId, organizationId, targetYearLabel\)/);
  assert.match(invoiceBlock, /extraLineItems: buildExtraLineItems\(addonLines\)/);
  // Training fund processing only after a real invoice, idempotent helper.
  const tfAt = invoiceBlock.indexOf('processTrainingFundAddons({');
  const invAt = invoiceBlock.indexOf('provider.createMembershipInvoice');
  assert.ok(tfAt > invAt, 'training fund processing must follow invoice creation');
  // The PO number rides on the invoice reference, like manual/cron paths.
  assert.match(invoiceBlock, /Membership \$\{targetYearLabel\} - PO: \$\{poNumber\}/);
});

test('manual and scheduled invoicing modes still skip BEFORE any record is inserted', () => {
  const manualSkipAt = orgFn.indexOf("effectiveInvoicingMode === 'manual'");
  const scheduledSkipAt = orgFn.indexOf("effectiveInvoicingMode === 'scheduled'");
  assert.ok(manualSkipAt > -1 && scheduledSkipAt > -1, 'both mode guards must exist');
  assert.ok(manualSkipAt < insertAt && scheduledSkipAt < insertAt,
    'mode guards must run before the insert');
  // Both guards return a skipped result (no fall-through into invoicing).
  const manualBlock = orgFn.slice(manualSkipAt, scheduledSkipAt);
  assert.match(manualBlock, /status: 'skipped'/);
  const scheduledBlock = orgFn.slice(scheduledSkipAt, orgFn.indexOf('membership_require_approval'));
  assert.match(scheduledBlock, /status: 'skipped'/);
});

test('fee-approval and duplicate-year guards remain ahead of the insert', () => {
  const approvalAt = orgFn.indexOf('membership_require_approval');
  const dupAt = orgFn.indexOf('simResult.existingRecord');
  assert.ok(approvalAt > -1 && approvalAt < insertAt, 'fee approval guard before insert');
  assert.ok(dupAt > -1 && dupAt < insertAt, 'existing-record guard before insert');
});

test('invoice failure keeps the membership record and surfaces a partial result', () => {
  const invoiceBlock = orgFn.slice(insertAt);
  // Failure is captured, never rethrown to fail the action wholesale…
  assert.match(invoiceBlock, /invoiceError = invErr\.message/);
  // …and the record is never rolled back.
  assert.ok(!/\.delete\(\)/.test(invoiceBlock), 'no rollback of the membership record on invoice failure');
  // Result status distinguishes full success from record-without-invoice.
  assert.match(invoiceBlock, /status: invoice \? 'success' : 'partial'/);
  assert.match(invoiceBlock, /invoice_error/);
  // The membership id is returned either way.
  assert.match(invoiceBlock, /membership_id: inserted\.id/);
});

test('invoice failure flags the row for the admin Retry affordance', () => {
  const invoiceBlock = orgFn.slice(insertAt);
  // Task #1112 retry UI keys off accounting_sync_status='failed'; without
  // this flag a failed mint leaves the record permanently invoice-less
  // (duplicate-year guard blocks a workflow re-run).
  const flagAt = invoiceBlock.indexOf("accounting_sync_status: 'failed'");
  assert.ok(flagAt > -1, 'failure must persist accounting_sync_status=failed');
  const flagScope = invoiceBlock.slice(Math.max(0, flagAt - 800), flagAt + 400);
  assert.match(flagScope, /if \(!invoice\)/);
  assert.match(flagScope, /organisation_membership_history/);
  // Error message is bounded (column hygiene, same as other writers).
  assert.match(flagScope, /accounting_sync_error: String\([^)]*\)\.slice\(0, 500\)/);
  assert.match(flagScope, /\.eq\('id', inserted\.id\)/);
});

test('dry runs never reach insert or invoicing', () => {
  const dryRunAt = orgFn.indexOf("status: 'dry_run'");
  assert.ok(dryRunAt > -1 && dryRunAt < insertAt, 'dry-run return must precede the insert');
});

test('workflow log surfaces partial action results as problems', () => {
  const logFnAt = src.indexOf('async function logWorkflowExecution');
  const logFn = src.slice(logFnAt, src.indexOf('export async function triggerWorkflows', logFnAt));
  // A partial action marks the run partial…
  assert.match(logFn, /statuses\.includes\('skipped'\) \|\| statuses\.includes\('partial'\)/);
  // …and its message lands in error_message alongside skipped/failed.
  assert.match(logFn, /r\?\.status === 'skipped' \|\| r\?\.status === 'failed' \|\| r\?\.status === 'partial'/);
});

test('member-driven path is untouched: still invoices and links member history', () => {
  const memberFn = src.slice(orgFnEnd);
  const memberScope = memberFn.slice(0, memberFn.indexOf('async function', 100) > -1 ? memberFn.indexOf('\nasync function ', 100) : memberFn.length);
  assert.match(memberScope, /provider\.createMembershipInvoice/);
  assert.match(memberScope, /member_membership_history/);
});
