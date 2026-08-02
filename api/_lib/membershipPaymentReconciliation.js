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
export async function reconcileRow({ table, row, baseUrl = '' }, deps = {}) {
  const db = deps.db || supabase;
  const fireWorkflow = deps.fireWorkflow || fireWorkflowForPaidRow;
  const fetchStatus = deps.fetchStatus || null;
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
  const provider = fetchStatus ? null : getAccountingProviderByName(providerName);

  if (!fetchStatus && typeof provider.fetchInvoiceStatus !== 'function') {
    return skipped(table, recordId, `provider-${providerName}-no-status-support`);
  }

  let snapshot;
  try {
    snapshot = fetchStatus
      ? await fetchStatus(invoiceId, row.tenant_id)
      : await provider.fetchInvoiceStatus(invoiceId, row.tenant_id);
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

  // Atomic, guarded transition: our in-memory `row` may be a STALE
  // snapshot — the Stripe webhook/recorder safety net (or a concurrent
  // reconcile) can have marked this row paid between our read and this
  // write. Only update when the DB row is not already in the target
  // state, and fire the workflow ONLY if this update actually changed a
  // row — this is what guarantees the paid workflow fires exactly once
  // across confirm, webhook, and cron.
  const { data: updatedRows, error: updateErr } = await db
    .from(table)
    .update(update)
    .eq('id', recordId)
    .neq('payment_status', afterStatus)
    .select('id');

  if (updateErr) {
    throw new Error(`Failed to update ${table}#${recordId} payment_status: ${updateErr.message}`);
  }
  if (!updatedRows || updatedRows.length === 0) {
    // Another process already applied this (or a newer) transition.
    return skipped(table, recordId, 'transition-raced');
  }

  console.log(`[membershipPaymentReconciliation] ${table}#${recordId} ${beforeStatus} -> ${afterStatus} (provider=${providerName}, invoice=${invoiceId})`);

  // Workflow trigger — fire on any transition that reaches `paid`
  // (e.g. `unpaid -> paid` AND `partial -> paid`). Voided / partial
  // transitions are recorded but do NOT fire workflows.
  if (afterStatus === 'paid' && beforeStatus !== 'paid') {
    try {
      await fireWorkflow({ table, row, snapshot, baseUrl });
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

/**
 * Task #3278 — Idempotent safety-net recorder for a SUCCEEDED Stripe
 * membership PaymentIntent that may never have been recorded by the
 * client-driven confirm step (webhook / admin-triggered reconcile path).
 *
 * Given a succeeded PI carrying membership metadata (tenant_id +
 * membership_year + member_id|organization_id, optionally token_id), this:
 *   1. No-ops if a history row already references the PI (dedupe — safe to
 *      run alongside a successful client confirm).
 *   2. Locates the existing history row (via the fee token's
 *      history_record_id, then by entity + year) and marks it paid,
 *      stamping the PI — atomically guarded so a concurrent confirm can't
 *      double-fire the workflow.
 *   3. Applies the Stripe payment to the attached accounting invoice when
 *      one exists (best-effort, failure flagged not swallowed).
 *   4. Fires the shared membership-paid workflow exactly once (only when
 *      THIS call transitioned the row to paid).
 *   5. Flips the fee token to paid and writes an audit note.
 *
 * It deliberately does NOT insert a brand-new history row: every Stripe
 * membership PI is minted against either a fee token (whose history row is
 * created by workflow/cron or adopted at confirm) or the form flow. If no
 * row can be found the payment is surfaced as `unmatched` for an admin —
 * guessing a row shape here could corrupt fee data.
 *
 * @returns {Promise<{status: 'already-recorded'|'recorded'|'raced'|'unmatched'|'invalid',
 *                    table?, recordId?, workflowFired?, accountingApplied?, detail?}>}
 */
export async function recordSucceededMembershipPaymentIntent(
  { tenantId, paymentIntent, baseUrl = '', source = 'stripe_membership_reconcile' },
  deps = {},
) {
  const db = deps.db || supabase;
  const fireWorkflow = deps.fireWorkflow || fireWorkflowForPaidRow;
  if (!db) throw new Error('Supabase not configured');

  const pi = paymentIntent;
  const md = pi?.metadata || {};
  if (!pi?.id || pi.status !== 'succeeded') {
    return { status: 'invalid', detail: `PaymentIntent missing or not succeeded (status=${pi?.status})` };
  }
  if (!md.tenant_id || md.tenant_id !== tenantId) {
    return { status: 'invalid', detail: `metadata.tenant_id (${md.tenant_id || 'none'}) does not match tenant ${tenantId}` };
  }
  if (!md.membership_year || (!md.member_id && !md.organization_id)) {
    return { status: 'invalid', detail: 'PaymentIntent metadata is not a membership payment (needs membership_year + member_id|organization_id)' };
  }

  // Fee-token payments carry token_id; the token decides member vs org
  // scope. Form-flow payments are member-scoped unless organization_id set.
  let feeToken = null;
  if (md.token_id) {
    const { data } = await db
      .from('membership_fee_token')
      .select('*')
      .eq('id', md.token_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    feeToken = data || null;
    if (feeToken) {
      // Strict token↔PI binding: the token's tenant/entity/year must all
      // match the PI metadata. A signed webhook only proves the PI is
      // real on the tenant's Stripe account — a crafted/mismatched
      // token_id must never redirect attribution to the token's scope.
      const tokenEntityMatches = feeToken.member_id
        ? feeToken.member_id === md.member_id && !md.organization_id
        : feeToken.organization_id === md.organization_id && !md.member_id;
      const tokenYearMatches = feeToken.membership_year === md.membership_year;
      if (!tokenEntityMatches || !tokenYearMatches) {
        console.error(`[MEMBERSHIP-RECONCILE] TOKEN/PI BINDING MISMATCH for PI ${pi.id}: token ${feeToken.id} scope (member=${feeToken.member_id || 'none'}, org=${feeToken.organization_id || 'none'}, year=${feeToken.membership_year}) does not match PI metadata (member=${md.member_id || 'none'}, org=${md.organization_id || 'none'}, year=${md.membership_year}) — refusing to record, admin attention required`);
        return { status: 'conflict', detail: `Fee token ${feeToken.id} scope does not match PI ${pi.id} metadata` };
      }
    }
  }
  // Org-scoped when an organization_id is present (fee tokens are strictly
  // member OR org scoped; the form flow writes to the org table whenever it
  // charged on behalf of an organisation).
  const isMember = feeToken ? !!feeToken.member_id : !md.organization_id;
  const entityCol = isMember ? 'member_id' : 'organization_id';
  const entityId = feeToken ? (feeToken.member_id || feeToken.organization_id) : (isMember ? md.member_id : md.organization_id);
  const table = isMember ? MEMBER_TABLE : ORG_TABLE;

  // 1. Dedupe by PI. Only a SETTLED row is terminal: the confirm handlers
  //    stamp the PI onto the row BEFORE marking it paid, so a crash in that
  //    window leaves an unpaid row already referencing the PI — that row
  //    must be repaired here, not skipped.
  const { data: existingByPI } = await db
    .from(table)
    .select('*')
    .eq('stripe_payment_intent_id', pi.id)
    .maybeSingle();
  if (existingByPI && (existingByPI.payment_status === 'paid' || existingByPI.payment_status === 'voided')) {
    return { status: 'already-recorded', table, recordId: existingByPI.id, workflowFired: false, detail: `history row ${existingByPI.id} already references PI ${pi.id} (payment_status=${existingByPI.payment_status})` };
  }

  // 2. Locate the target history row (a stamped-but-unpaid row wins).
  let row = existingByPI || null;
  if (!row && feeToken?.history_record_id) {
    const { data } = await db.from(table).select('*').eq('id', feeToken.history_record_id).maybeSingle();
    row = data || null;
  }
  if (!row) {
    const { data } = await db
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId)
      .eq(entityCol, entityId)
      .eq('membership_year', md.membership_year)
      .maybeSingle();
    row = data || null;
  }
  let reconstructed = false;
  if (!row) {
    // No history row exists — the confirm flow failed BEFORE inserting it
    // (e.g. form-flow confirm died between charge and insert). Reconstruct
    // a validated minimal row from the fee token / PI metadata rather than
    // stranding a captured payment. The entity is verified to exist in the
    // tenant first; a 23505 (concurrent confirm inserted the row) falls
    // back to adopting that row.
    const entityTable = isMember ? 'member' : 'organization';
    const { data: entity } = await db
      .from(entityTable)
      .select('id')
      .eq('id', entityId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!entity) {
      console.error(`[MEMBERSHIP-RECONCILE] UNMATCHED succeeded PI ${pi.id} (tenant ${tenantId}, ${entityCol}=${entityId}, year=${md.membership_year}): entity not found — admin attention required`);
      return { status: 'unmatched', table, detail: `${entityTable} ${entityId} not found in tenant ${tenantId}; payment ${pi.id} is charged but unrecorded` };
    }

    const chargedAmount = pi.amount / 100;
    const cb = feeToken?.cost_breakdown || {};
    const nowIso = new Date().toISOString();
    const { data: insertedRow, error: insertErr } = await db
      .from(table)
      .insert({
        tenant_id: tenantId,
        [entityCol]: entityId,
        // Token year is validated equal to metadata year above — always
        // use the metadata year (same key the lookup used).
        membership_year: md.membership_year,
        final_cost: feeToken?.final_cost != null ? parseFloat(feeToken.final_cost) : chargedAmount,
        currency: feeToken?.currency || (pi.currency || 'gbp').toUpperCase(),
        vat_amount: cb.vatAmount || 0,
        total_with_vat: cb.totalWithVat || chargedAmount,
        purchase_order_number: feeToken?.po_number || null,
        payment_method: 'stripe',
        stripe_payment_intent_id: pi.id,
        status: 'active',
        payment_status: 'paid',
        paid_at: nowIso,
        notes: `[Stripe Reconciliation] Record reconstructed from succeeded Stripe payment ${pi.id} because the checkout confirmation step failed before creating it. Amount charged: ${(pi.currency || 'gbp').toUpperCase()} ${chargedAmount.toFixed(2)}. Tier/discount breakdown unavailable — admin review recommended.`,
      })
      .select()
      .maybeSingle();

    if (insertErr) {
      if (insertErr.code === '23505') {
        // A concurrent confirm created the row between our probe and
        // insert — adopt it.
        const { data: raced } = await db
          .from(table)
          .select('*')
          .eq('tenant_id', tenantId)
          .eq(entityCol, entityId)
          .eq('membership_year', md.membership_year)
          .maybeSingle();
        if (raced?.payment_status === 'paid') {
          return { status: 'already-recorded', table, recordId: raced.id, workflowFired: false, detail: 'concurrent confirm recorded this payment' };
        }
        row = raced || null;
        if (!row) {
          return { status: 'unmatched', table, detail: `23505 on reconstruction but row not re-findable for PI ${pi.id}` };
        }
        if (row.stripe_payment_intent_id && row.stripe_payment_intent_id !== pi.id) {
          return { status: 'conflict', table, recordId: row.id, detail: `Row references PI ${row.stripe_payment_intent_id}, not ${pi.id}` };
        }
      } else {
        console.error(`[MEMBERSHIP-RECONCILE] Failed to reconstruct ${table} row for succeeded PI ${pi.id}: ${insertErr.message} — will retry / needs admin attention`);
        return { status: 'unmatched', table, detail: `Reconstruction insert failed: ${insertErr.message}` };
      }
    } else {
      row = insertedRow;
      reconstructed = true;
      // Link the reconstructed row back onto the fee token so future
      // token-based lookups (confirm retries, admin views) find it.
      if (feeToken && row?.id) {
        try {
          await db.from('membership_fee_token')
            .update({ history_record_id: row.id, updated_at: nowIso })
            .eq('id', feeToken.id);
        } catch {}
      }
    }
  }
  if (row.stripe_payment_intent_id && row.stripe_payment_intent_id !== pi.id) {
    console.error(`[MEMBERSHIP-RECONCILE] CONFLICT: ${table}#${row.id} already references a DIFFERENT PI (${row.stripe_payment_intent_id}) than succeeded ${pi.id} — refusing to overwrite, admin attention required`);
    return { status: 'conflict', table, recordId: row.id, detail: `Row references PI ${row.stripe_payment_intent_id}, not ${pi.id}` };
  }

  const amountMismatch = Number.isFinite(pi.amount) && row.total_with_vat != null
    && Math.round(Number(row.total_with_vat) * 100) !== pi.amount;
  if (amountMismatch) {
    console.error(`[MEMBERSHIP-RECONCILE] Amount mismatch while reconciling PI ${pi.id}: row ${row.id} expects ${Math.round(Number(row.total_with_vat) * 100)}, PI charged ${pi.amount}. Recording anyway (money already captured) — flagged in note.`);
  }

  const paidAtIso = new Date().toISOString();
  // A reconstructed row was inserted paid by US — treat it as a fresh
  // transition (workflow must fire) and skip the update guard.
  const wasPaid = !reconstructed && row.payment_status === 'paid';
  let workflowFired = false;

  if (!wasPaid && !reconstructed) {
    // Atomic transition guard: only one caller (webhook vs client confirm
    // vs admin script) wins the not-yet-paid -> paid update.
    const { data: updated, error: updErr } = await db
      .from(table)
      .update({
        payment_status: 'paid',
        paid_at: row.paid_at || paidAtIso,
        payment_method: 'stripe',
        stripe_payment_intent_id: pi.id,
      })
      .eq('id', row.id)
      .neq('payment_status', 'paid')
      .or(`stripe_payment_intent_id.is.null,stripe_payment_intent_id.eq.${pi.id}`)
      .select('id');
    if (updErr) throw new Error(`Failed to mark ${table}#${row.id} paid: ${updErr.message}`);
    if (!updated || updated.length === 0) {
      return { status: 'raced', table, recordId: row.id, workflowFired: false, detail: 'Another process recorded this payment concurrently' };
    }
  } else if (!row.stripe_payment_intent_id) {
    await db.from(table).update({ payment_method: 'stripe', stripe_payment_intent_id: pi.id }).eq('id', row.id);
  }

  // 3. Apply the payment to the attached accounting invoice (best-effort).
  let accountingApplied = false;
  const invoiceId = row.accounting_invoice_id || row.xero_invoice_id || feeToken?.xero_invoice_id || null;
  if (invoiceId) {
    try {
      const applyPayment = deps.applyPayment || (async () => {
        const { getAccountingProvider } = await import('./accountingProvider.js');
        const provider = await getAccountingProvider(tenantId);
        return provider.applyStripePaymentToInvoice({
          appTenantId: tenantId,
          invoiceId,
          xeroInvoiceId: invoiceId,
          stripePaymentIntentId: pi.id,
        });
      });
      await applyPayment();
      accountingApplied = true;
    } catch (accErr) {
      console.error(`[MEMBERSHIP-RECONCILE] Failed to apply Stripe payment ${pi.id} to accounting invoice ${invoiceId} (non-fatal, row already marked paid): ${accErr.message}`);
      try {
        await db.from(table).update({
          accounting_sync_status: 'failed',
          accounting_sync_error: `Reconcile: could not apply Stripe payment to invoice: ${String(accErr.message || accErr).slice(0, 900)}`,
        }).eq('id', row.id);
      } catch {}
    }
  }

  // 4. Fire the shared membership-paid workflow exactly once.
  if (!wasPaid) {
    try {
      const result = await fireWorkflow({ table, row, snapshot: { paidAt: paidAtIso }, baseUrl, source });
      workflowFired = !!result?.fired;
    } catch (wfErr) {
      console.error(`[MEMBERSHIP-RECONCILE] Workflow trigger failed for ${table}#${row.id} (non-fatal): ${wfErr.message}`);
    }
  }

  // 5. Token + audit note (best-effort).
  if (feeToken && feeToken.status !== 'paid') {
    try {
      await db.from('membership_fee_token').update({
        status: 'paid',
        paid_at: paidAtIso,
        stripe_payment_intent_id: pi.id,
        updated_at: paidAtIso,
      }).eq('id', feeToken.id);
    } catch {}
  }
  try {
    const noteTable = isMember ? 'member_note' : 'organization_note';
    const noteIdCol = isMember ? 'member_id' : 'organization_id';
    await db.from(noteTable).insert({
      [noteIdCol]: entityId,
      content: `[Membership Fee - Stripe Reconciliation] Succeeded Stripe payment recorded via ${source}. PI: ${pi.id}. Amount: ${(pi.currency || 'gbp').toUpperCase()} ${(pi.amount / 100).toFixed(2)}.${amountMismatch ? ` WARNING: amount differs from the recorded fee total (${row.total_with_vat}).` : ''}${invoiceId && !accountingApplied ? ' Accounting invoice payment could NOT be applied automatically — flagged for admin retry.' : ''}`,
      ...(isMember ? {} : {}),
    });
  } catch {}

  console.log(`[MEMBERSHIP-RECONCILE] Recorded succeeded PI ${pi.id} onto ${table}#${row.id} (workflowFired=${workflowFired}, accountingApplied=${accountingApplied}, source=${source})`);
  return { status: 'recorded', table, recordId: row.id, workflowFired, accountingApplied, detail: amountMismatch ? 'amount-mismatch-flagged' : null };
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
