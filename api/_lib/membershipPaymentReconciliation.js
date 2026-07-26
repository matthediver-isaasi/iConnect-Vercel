// Task #1017 — Shared membership invoice payment reconciliation helper.
//
// Given a single membership history row (org-level or member-level) that
// has an accounting invoice attached, ask the row's accounting provider
// for the current invoice status, update the row's `payment_status` /
// `paid_at` columns on transition, and fire the workflow engine via a
// `field_change` event when an invoice newly settles as paid.
//
// Idempotent — a row whose `payment_status` is already `paid` / `partial`
// / `voided` is skipped (re-runs are no-ops), with one exception: if the
// remote state is `voided` the row is still flipped to `voided` so we
// don't keep polling it.
//
// IMPORTANT — workflows must NOT fire from the one-off historic backfill.
// The backfill script writes directly to the DB and never calls this
// helper; only newly-paid invoices from go-live onward trigger workflows.

import { supabase } from './database.js';
import { getAccountingProviderByName, PROVIDER_XERO } from './accountingProvider.js';
import { triggerWorkflows } from './workflows.js';

const ORG_TABLE = 'organisation_membership_history';
const MEMBER_TABLE = 'member_membership_history';

// `paid` and `voided` are terminal — no further polling. `partial` is
// NOT terminal because a partial invoice can still reach `paid` later,
// and the workflow MUST fire on that final transition.
const TERMINAL_STATUSES = new Set(['paid', 'voided']);

/**
 * Reconcile a single membership history row by id.
 *
 * @param {Object} args
 * @param {'organisation_membership_history' | 'member_membership_history'} args.table
 * @param {string} args.recordId
 * @param {string} [args.baseUrl] - base URL passed to triggerWorkflows for follow-up callbacks
 * @returns {Promise<{ table, recordId, transitioned, beforeStatus, afterStatus, skippedReason }>}
 */
export async function reconcileMembershipInvoicePayment({ table, recordId, baseUrl = '' }) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!table || (table !== ORG_TABLE && table !== MEMBER_TABLE)) {
    throw new Error(`Invalid table: ${table}`);
  }
  if (!recordId) throw new Error('recordId is required');

  const { data: row, error: rowErr } = await supabase
    .from(table)
    .select('*')
    .eq('id', recordId)
    .maybeSingle();

  if (rowErr) throw new Error(`Failed to load ${table} row ${recordId}: ${rowErr.message}`);
  if (!row) return skipped(table, recordId, 'row-not-found');

  return reconcileRow({ table, row, baseUrl });
}

/**
 * Reconcile a single row (when caller already has the row in hand).
 */
export async function reconcileRow({ table, row, baseUrl = '' }) {
  if (!row) return skipped(table, null, 'row-not-found');

  const recordId = row.id;
  const invoiceId = row.accounting_invoice_id || row.xero_invoice_id;
  if (!invoiceId) return skipped(table, recordId, 'no-invoice-id');

  const beforeStatus = row.payment_status || 'unpaid';

  // Skip rows that are already in a terminal state (paid/voided).
  // `partial` rows continue to be polled so they can transition to paid.
  if (TERMINAL_STATUSES.has(beforeStatus)) {
    return skipped(table, recordId, `already-${beforeStatus}`);
  }

  const providerName = row.accounting_provider || PROVIDER_XERO;
  const provider = getAccountingProviderByName(providerName);

  if (typeof provider.fetchInvoiceStatus !== 'function') {
    return skipped(table, recordId, `provider-${providerName}-no-status-support`);
  }

  let snapshot;
  try {
    snapshot = await provider.fetchInvoiceStatus(invoiceId, row.tenant_id);
  } catch (err) {
    console.error(`[membershipPaymentReconciliation] ${providerName} fetchInvoiceStatus failed for ${table}#${recordId} (invoice ${invoiceId}): ${err.message}`);
    throw err;
  }

  if (!snapshot) return skipped(table, recordId, 'invoice-not-found');

  const afterStatus = snapshot.status; // 'paid' | 'voided' | 'partial' | 'unpaid'
  if (afterStatus === beforeStatus) {
    return skipped(table, recordId, 'no-change');
  }

  // Persist the new state.
  const update = { payment_status: afterStatus };
  if (afterStatus === 'paid' && snapshot.paidAt) {
    update.paid_at = snapshot.paidAt;
  }

  const { error: updateErr } = await supabase
    .from(table)
    .update(update)
    .eq('id', recordId);

  if (updateErr) {
    throw new Error(`Failed to update ${table}#${recordId} payment_status: ${updateErr.message}`);
  }

  console.log(`[membershipPaymentReconciliation] ${table}#${recordId} ${beforeStatus} -> ${afterStatus} (provider=${providerName}, invoice=${invoiceId})`);

  // Workflow trigger — fire on any transition that reaches `paid`
  // (e.g. `unpaid -> paid` AND `partial -> paid`). Voided / partial
  // transitions are recorded but do NOT fire workflows.
  if (afterStatus === 'paid' && beforeStatus !== 'paid') {
    try {
      await fireWorkflowForPaidRow({ table, row, snapshot, baseUrl });
    } catch (wfErr) {
      // Non-fatal — the DB state is already correct. Log loudly.
      console.error(`[membershipPaymentReconciliation] Workflow trigger failed for ${table}#${recordId}: ${wfErr.message}`);
    }
  }

  return {
    table,
    recordId,
    transitioned: true,
    beforeStatus,
    afterStatus,
    skippedReason: null,
  };
}

function skipped(table, recordId, reason) {
  return { table, recordId, transitioned: false, beforeStatus: null, afterStatus: null, skippedReason: reason };
}

/**
 * Fire the workflow engine for a row whose invoice transitioned to paid.
 * For org rows the workflow entity is the organisation; for member rows
 * the entity is the member.
 *
 * beforeData carries `{ payment_status: 'unpaid' }` and afterData carries
 * the new payment_status plus a few helper fields (invoice number, paid
 * timestamp, membership year, currency) so admin-authored workflows can
 * reference them in conditions and email templates.
 *
 * Exported so other "invoice settled as paid" paths (e.g. the individual
 * card-payment confirm endpoint, Task #3110) fire the exact same payload
 * shape and cannot drift from the reconciliation path.
 *
 * @param {Object} args
 * @param {string} args.table - history table name (org or member)
 * @param {Object} args.row - the membership history row
 * @param {Object} args.snapshot - `{ paidAt }` (paid timestamp, defaults to now)
 * @param {string} [args.baseUrl]
 * @param {string} [args.source] - context.source passed to triggerWorkflows
 * @param {Object} [deps] - test injection: `{ db, trigger }`
 * @returns {Promise<{ fired: boolean, skippedReason?: string }>}
 */
export async function fireWorkflowForPaidRow(
  { table, row, snapshot, baseUrl = '', source = 'membership_payment_reconciliation' },
  deps = {},
) {
  const db = deps.db || supabase;
  const trigger = deps.trigger || triggerWorkflows;

  const isOrg = table === ORG_TABLE;
  const entityType = isOrg ? 'organization' : 'member';
  const entityId = isOrg ? row.organization_id : row.member_id;
  if (!entityId) {
    console.warn(`[membershipPaymentReconciliation] ${table}#${row.id} has no ${isOrg ? 'organization_id' : 'member_id'}; skipping workflow trigger`);
    return { fired: false, skippedReason: 'no-entity-id' };
  }

  // Hydrate the entity record so workflow conditions referencing other
  // fields (status, name, etc.) evaluate correctly.
  const { data: entity } = await db
    .from(isOrg ? 'organization' : 'member')
    .select('*')
    .eq('id', entityId)
    .maybeSingle();

  if (!entity) {
    console.warn(`[membershipPaymentReconciliation] entity ${entityType}#${entityId} not found; skipping workflow trigger`);
    return { fired: false, skippedReason: 'entity-not-found' };
  }

  const invoiceNumber = row.accounting_invoice_number || row.xero_invoice_number || null;
  const paidAt = snapshot.paidAt || new Date().toISOString();

  const beforeData = {
    ...entity,
    payment_status: 'unpaid',
    paid_at: null,
    last_membership_invoice_number: null,
    last_membership_invoice_paid_at: null,
  };

  const afterData = {
    ...entity,
    payment_status: 'paid',
    paid_at: paidAt,
    last_membership_invoice_number: invoiceNumber,
    last_membership_invoice_paid_at: paidAt,
    // Convenience fields available to email templates:
    accounting_invoice_id: row.accounting_invoice_id || row.xero_invoice_id || null,
    accounting_invoice_number: invoiceNumber,
    accounting_provider: row.accounting_provider || PROVIDER_XERO,
    membership_year: row.membership_year,
    final_cost: row.final_cost,
    currency: row.currency,
  };

  console.log(`[membershipPaymentReconciliation] Firing workflow for ${entityType}#${entityId} (payment_status unpaid->paid, source=${source})`);
  await trigger(
    entityType,
    entityId,
    beforeData,
    afterData,
    'field_change',
    baseUrl,
    { source, historyTable: table, historyRecordId: row.id },
  );
  return { fired: true };
}
