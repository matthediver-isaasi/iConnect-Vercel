/**
 * Membership creation for form payments (Task #3489).
 *
 * When a form's conditional logic matched a `membership_structure` action at
 * payment-create time, the server-derived quote was stored in
 * payment_meta.membership. After the payment succeeds and the entity
 * pipelines have created/resolved the member or organisation, this module
 * creates the membership history row, raises the accounting-provider
 * invoice, marks the membership paid, and fires the membership-paid workflow
 * — mirroring api/forms/membership-payment.js confirm.
 *
 * Idempotency & retry model (staged, resumable):
 *  - Runs inside finalizeFormSubmission's `finalized` CAS claim, plus a
 *    dedicated cron sweep (formPaymentReconciliation.js third sweep) that
 *    retries paid rows whose membership work is incomplete.
 *  - payment_meta.membership_result records progress durably:
 *      { status: 'created', history_id, invoice_state, workflow_state }
 *    is stamped IMMEDIATELY after the history insert, BEFORE any side
 *    effects, with both states 'pending'; each side effect flips its state
 *    when done. A crash at any point leaves a resumable stamp (or none),
 *    and the retry resumes exactly the missing side effects.
 *  - A retry that finds OUR history row without a stamp (crash between
 *    insert and stamp — detected via the Stripe payment-intent column or
 *    the submission id embedded in the row's notes) re-adopts the row and
 *    resumes; side effects cannot have run yet because they always follow
 *    the stamp.
 *  - Genuinely foreign rows for the same (entity, year) stamp terminal
 *    'year_exists' (payment stands, no duplicate membership, admin note).
 *  - Entity resolution contract: payment-create already validated that the
 *    form's pipelines can produce the target entity, and this module
 *    re-reads the submission row fresh (created_member_id /
 *    organization_id are written by the pipelines) before concluding no
 *    entity exists. An unresolved entity stamps 'awaiting_entity' with an
 *    attempt counter — the cron re-runs the form's entity pipelines and
 *    retries indefinitely (an admin re-running processing also sets the
 *    ids); after MAX_ENTITY_ATTEMPTS an admin note is escalated once.
 *    A paid row is never terminally abandoned.
 *  - The workflow uses a durable atomic claim before dispatch: a CAS update
 *    (conditional on the current workflow_state via a PostgREST filter)
 *    flips 'pending' → 'claimed' with a timestamp; only the winner
 *    dispatches, then marks 'done'. Recovery policy for a claimed-but-
 *    undelivered event (crash between claim and dispatch): a claim older
 *    than WORKFLOW_CLAIM_TTL_MS may be re-claimed by the cron via the same
 *    CAS (matching both state AND the stale claim timestamp), so delivery
 *    resumes without concurrent double-fire.
 *    DELIVERY CONTRACT: the workflow engine (triggerWorkflows) accepts no
 *    idempotency key, so strict exactly-once external delivery is not
 *    implementable here. The guarantee is: never zero (pending/orphaned
 *    claims are always recovered), at most one concurrent dispatcher, and
 *    a duplicate only in the narrow case of a process crash AFTER the
 *    engine accepted the event but BEFORE the 'done' stamp, surfacing no
 *    earlier than one claim TTL later — i.e. at-least-once with a
 *    single-crash-window duplicate, the same contract as the platform's
 *    other paid-workflow reconciliation paths. The membership retry sweep
 *    has NO lookback bound and serves oldest-first, so delivery is
 *    eventual (subject to cron availability), however old the submission.
 *  - The invoice attempt is once, with failures flagged on the history row
 *    (accounting_sync_status='failed') for the existing admin retry
 *    surface.
 *
 * Failures are logged and recorded in processing_notes — never thrown, and
 * never roll back a paid submission.
 */

import { getConfigByIdDirect } from './membershipConfigResolver.js';
import { resolveInvoiceAddress } from './invoiceAddressResolver.js';
import { stripeInvoiceAddressFromSnapshot } from './stripeInvoiceAddress.js';

// A workflow claim older than this is considered orphaned (crash between
// claim and dispatch) and may be re-claimed by the cron sweep.
export const WORKFLOW_CLAIM_TTL_MS = 15 * 60 * 1000;

// After this many entity-resolution retries an admin note is escalated
// onto the submission (retries continue — never terminal).
export const MAX_ENTITY_ATTEMPTS = 8;

export async function finalizeFormMembership({ supabase, submission, baseUrl, memberId = null, organizationId = null }) {
  const meta = (submission?.payment_meta && typeof submission.payment_meta === 'object')
    ? submission.payment_meta : {};
  const membership = meta.membership;
  const quote = membership?.quote;
  if (!quote || !quote.config_id || !quote.membership_year) return { created: false, skipped: true };

  const tenantId = submission.tenant_id;
  const isMemberScoped = quote.target === 'member';
  const historyTable = isMemberScoped ? 'member_membership_history' : 'organisation_membership_history';
  const historyIdCol = isMemberScoped ? 'member_id' : 'organization_id';
  let entityId = isMemberScoped
    ? (memberId || submission.created_member_id || null)
    : (organizationId || submission.organization_id || meta.prefill_organization_id || null);
  // Entity-resolution contract: the pipelines write created_member_id /
  // organization_id onto the submission row; the caller's snapshot may be
  // stale (browser confirm captured the row before the pipeline update, or
  // an admin re-ran processing since). Always re-read fresh before
  // concluding the entity is missing.
  if (!entityId) {
    try {
      const { data: freshSub } = await supabase
        .from('form_submission')
        .select('created_member_id, organization_id')
        .eq('id', submission.id)
        .maybeSingle();
      entityId = isMemberScoped
        ? (freshSub?.created_member_id || null)
        : (freshSub?.organization_id || null);
    } catch { /* fall through */ }
  }
  const paymentRef = submission.payment_reference || null;
  const isStripe = submission.payment_provider === 'stripe';
  // Deterministic ownership marker embedded in the history row's notes so a
  // retry can recognise a row this submission created even without a stamp.
  const ownershipMarker = `Submission: ${submission.id}`;

  const noteFailure = async (reason) => {
    console.error(`[formMembershipFinalize] ${reason} (submission ${submission.id})`);
    try {
      await supabase.from('form_submission').update({
        processing_notes: `Payment succeeded but the membership could not be created automatically: ${reason}. Please create it manually — do NOT ask the applicant to pay again.`,
      }).eq('id', submission.id);
    } catch { /* best effort */ }
  };

  // Durable progress stamp. Terminal states stop the cron retry sweep;
  // 'created' with pending invoice/workflow states keeps it retrying.
  const stampResult = async (result) => {
    try {
      const { data: fresh } = await supabase
        .from('form_submission')
        .select('payment_meta')
        .eq('id', submission.id)
        .maybeSingle();
      const freshMeta = (fresh?.payment_meta && typeof fresh.payment_meta === 'object') ? fresh.payment_meta : meta;
      const prev = (freshMeta.membership_result && typeof freshMeta.membership_result === 'object')
        ? freshMeta.membership_result : {};
      await supabase.from('form_submission').update({
        payment_meta: { ...freshMeta, membership_result: { ...prev, ...result, updated_at: new Date().toISOString() } },
      }).eq('id', submission.id);
    } catch { /* best effort */ }
  };

  // Durable atomic workflow-dispatch claim. The UPDATE is conditional on
  // the CURRENT workflow_state (and, for stale re-claims, the exact stale
  // claim timestamp) via PostgREST filters, so of N concurrent actors
  // exactly one sees an affected row and dispatches.
  const claimWorkflow = async (expectedState, expectedClaimedAt) => {
    try {
      const { data: fresh } = await supabase
        .from('form_submission')
        .select('payment_meta')
        .eq('id', submission.id)
        .maybeSingle();
      const freshMeta = (fresh?.payment_meta && typeof fresh.payment_meta === 'object') ? fresh.payment_meta : meta;
      const prev = (freshMeta.membership_result && typeof freshMeta.membership_result === 'object')
        ? freshMeta.membership_result : {};
      const currentState = prev.workflow_state || 'pending';
      if (currentState !== expectedState) return { claimed: false, currentState };
      const claimedAt = new Date().toISOString();
      let query = supabase
        .from('form_submission')
        .update({
          payment_meta: {
            ...freshMeta,
            membership_result: { ...prev, workflow_state: 'claimed', workflow_claimed_at: claimedAt },
          },
        })
        .eq('id', submission.id)
        .filter('payment_meta->membership_result->>workflow_state', 'eq', expectedState);
      if (expectedState === 'claimed') {
        // Stale re-claim: must also match the exact stale timestamp so two
        // sweepers cannot both re-claim the same orphaned claim.
        query = expectedClaimedAt
          ? query.filter('payment_meta->membership_result->>workflow_claimed_at', 'eq', expectedClaimedAt)
          : query.filter('payment_meta->membership_result->>workflow_claimed_at', 'is', null);
      }
      const { data: updated, error } = await query.select('id');
      if (error) return { claimed: false, currentState };
      return { claimed: (updated || []).length > 0, currentState: 'claimed' };
    } catch {
      return { claimed: false, currentState: expectedState };
    }
  };

  // ── Side-effect runner (resumable) ────────────────────────────────────
  // Runs whatever is still pending against a known-ours history row.
  const runSideEffects = async (historyRow, states, { newlyCreated }) => {
    let invoiceState = states.invoice_state || 'pending';
    let workflowState = states.workflow_state || 'pending';
    let invoiceResult = null;
    let accountingSyncError = null;

    // Invoice already on the row (e.g. crash after invoice update but
    // before the stamp flip)?
    if (invoiceState === 'pending' && (historyRow.accounting_invoice_id || historyRow.xero_invoice_id)) {
      invoiceState = 'done';
      await stampResult({ invoice_state: 'done', invoice_number: historyRow.accounting_invoice_number || historyRow.xero_invoice_number || null });
    }
    // Prior attempt flagged failed on the row → leave to admin retry surface.
    if (invoiceState === 'pending' && historyRow.accounting_sync_status === 'failed') {
      invoiceState = 'failed';
      await stampResult({ invoice_state: 'failed' });
    }

    if (invoiceState === 'pending') {
      try {
        const config = await getConfigByIdDirect(tenantId, quote.config_id);
        let invoiceName;
        let invoicingEmail;
        let invoicingAddress;
        if (isMemberScoped) {
          const { data: member } = await supabase
            .from('member')
            .select('first_name, last_name, email')
            .eq('id', historyRow.member_id)
            .maybeSingle();
          invoiceName = [member?.first_name, member?.last_name].filter(Boolean).join(' ') || 'Member';
          invoicingEmail = member?.email || submission.submitted_by_email || null;
          invoicingAddress = isStripe
            ? stripeInvoiceAddressFromSnapshot(meta.stripe_billing_address)
            : await resolveInvoiceAddress(supabase, config, historyRow.member_id, 'member');
        } else {
          const { data: org } = await supabase
            .from('organization')
            .select('name, invoicing_email')
            .eq('id', historyRow.organization_id)
            .maybeSingle();
          invoiceName = org?.name || 'Organisation';
          invoicingEmail = org?.invoicing_email || submission.submitted_by_email || null;
          invoicingAddress = isStripe
            ? stripeInvoiceAddressFromSnapshot(meta.stripe_billing_address)
            : await resolveInvoiceAddress(supabase, config, historyRow.organization_id, 'organization');
        }

        const { getAccountingProvider, buildInvoiceColumnUpdate } = await import('./accountingProvider.js');
        const provider = await getAccountingProvider(tenantId);
        invoiceResult = await provider.createMembershipInvoice({
          appTenantId: tenantId,
          organizationName: invoiceName,
          invoicingEmail,
          invoicingAddress: invoicingAddress || undefined,
          membershipYear: quote.membership_year,
          tierLabel: quote.tier_label,
          finalCost: quote.final_cost,
          currency: quote.currency || 'GBP',
          reference: `Membership ${quote.membership_year}`,
          vatRate: quote.tax_type || null,
          nominalCode: quote.nominal_code || null,
          markAsPaid: true,
          ...(isStripe && paymentRef ? { stripePaymentIntentId: paymentRef } : {}),
          invoiceDescription: quote.invoice_description || null,
        });
        if (invoiceResult?.invoice_id) {
          await supabase
            .from(historyTable)
            .update(buildInvoiceColumnUpdate(invoiceResult))
            .eq('id', historyRow.id)
            .eq('tenant_id', tenantId);
        }
        invoiceState = 'done';
        await stampResult({ invoice_state: 'done', invoice_number: invoiceResult?.invoice_number || null });
      } catch (invoiceErr) {
        accountingSyncError = invoiceErr?.message || String(invoiceErr) || 'Unknown accounting provider error';
        console.error(`[formMembershipFinalize] Accounting invoice failed for submission ${submission.id}:`, invoiceErr);
        try {
          await supabase
            .from(historyTable)
            .update({
              accounting_sync_status: 'failed',
              accounting_sync_error: accountingSyncError.slice(0, 1000),
            })
            .eq('id', historyRow.id)
            .eq('tenant_id', tenantId);
        } catch (flagErr) {
          console.error('[formMembershipFinalize] Failed to flag accounting_sync_status:', flagErr.message);
        }
        // Terminal for the cron (admin retries via accounting sync surface).
        invoiceState = 'failed';
        await stampResult({ invoice_state: 'failed', accounting_error: accountingSyncError.slice(0, 500) });
      }
    }

    // Membership-paid workflow — durable atomic claim BEFORE dispatch:
    // CAS 'pending' → 'claimed' (or re-claim a stale claim, matching both
    // state and the exact stale timestamp) so exactly one actor dispatches.
    // A dispatch error reverts the claim to 'pending' for the cron to
    // retry; a crash between claim and dispatch is recovered when the
    // claim exceeds WORKFLOW_CLAIM_TTL_MS.
    const isStaleClaim = workflowState === 'claimed'
      && (!states.workflow_claimed_at
        || (Date.now() - new Date(states.workflow_claimed_at).getTime()) > WORKFLOW_CLAIM_TTL_MS);
    if (workflowState === 'pending' || isStaleClaim) {
      const claim = await claimWorkflow(workflowState === 'pending' ? 'pending' : 'claimed', states.workflow_claimed_at || null);
      if (claim.claimed) {
        try {
          const { fireWorkflowForPaidRow } = await import('./membershipPaymentReconciliation.js');
          await fireWorkflowForPaidRow({
            table: historyTable,
            row: historyRow,
            snapshot: { paidAt: historyRow.paid_at || new Date().toISOString() },
            baseUrl: baseUrl || '',
            source: 'form_membership_action',
          });
          workflowState = 'done';
          await stampResult({ workflow_state: 'done' });
        } catch (wfErr) {
          console.error(`[formMembershipFinalize] Membership-paid workflow dispatch failed for submission ${submission.id} (will retry):`, wfErr.message);
          // Known-failed dispatch: release the claim so the cron retries.
          await stampResult({ workflow_state: 'pending', workflow_claimed_at: null });
          workflowState = 'pending';
        }
      } else {
        workflowState = claim.currentState || workflowState;
      }
    }

    // Entity note — best effort, only on the run that created the row.
    if (newlyCreated) {
      try {
        const noteTable = isMemberScoped ? 'member_note' : 'organization_note';
        const noteIdCol = isMemberScoped ? 'member_id' : 'organization_id';
        const chargeTotal = quote.total_with_vat || quote.final_cost;
        await supabase.from(noteTable).insert({
          [noteIdCol]: historyRow[historyIdCol],
          content: `[Membership Fee - Form Payment] Membership for ${quote.membership_year} created from form submission. Amount: ${quote.currency || 'GBP'} ${Number(chargeTotal).toFixed(2)}${quote.vat_amount > 0 ? ` (incl. VAT ${Number(quote.vat_amount).toFixed(2)})` : ''}.${paymentRef ? ` Payment ref: ${paymentRef}.` : ''}${invoiceResult?.invoice_number ? ` Invoice ${invoiceResult.invoice_number} created.` : accountingSyncError ? ' Accounting invoice failed; flagged for admin retry.' : ''}`,
          attachments: [],
        });
      } catch { /* best effort */ }
    }

    return {
      created: newlyCreated,
      historyId: historyRow.id,
      invoiceState,
      workflowState,
      invoiceNumber: invoiceResult?.invoice_number || null,
    };
  };

  try {
    // ── Resume path: a prior run already created/adopted the row. ───────
    const prior = meta.membership_result;
    if (prior?.status === 'created' && prior.history_id) {
      const workflowIncomplete = prior.workflow_state === 'pending' || prior.workflow_state === 'claimed';
      if (prior.invoice_state !== 'pending' && !workflowIncomplete) {
        return { created: false, alreadyProcessed: true, historyId: prior.history_id };
      }
      const { data: historyRow } = await supabase
        .from(historyTable)
        .select('*')
        .eq('id', prior.history_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!historyRow) {
        await noteFailure('the previously created membership record can no longer be found');
        await stampResult({ status: 'row_missing' });
        return { created: false };
      }
      return await runSideEffects(historyRow, prior, { newlyCreated: false });
    }

    if (!entityId) {
      // Not yet resolvable. NEVER terminal: the reconciliation cron
      // re-runs the form's entity pipelines before each retry, and an
      // admin re-running processing also writes the ids onto the
      // submission — a paid row stays actionable until the membership is
      // created. After MAX_ENTITY_ATTEMPTS we escalate once via an admin
      // note but keep retrying.
      const attempts = (prior?.status === 'awaiting_entity' ? (prior.attempts || 0) : 0) + 1;
      if (attempts === MAX_ENTITY_ATTEMPTS) {
        await noteFailure(`no ${isMemberScoped ? 'member' : 'organisation'} has been resolved by the form's processing pipelines after ${attempts} attempts — re-run processing from the submissions list; the membership will then be created automatically`);
      }
      console.warn(`[formMembershipFinalize] Entity not yet resolved for submission ${submission.id} (attempt ${attempts}); will retry`);
      await stampResult({ status: 'awaiting_entity', attempts });
      return { created: false, awaitingEntity: true };
    }

    // ── Existing-row checks (retry safety, one row per (entity, year)). ──
    const adoptRow = async (row) => {
      // Row created by a prior run of THIS submission that crashed before
      // stamping — adopt it and resume every side effect (side effects
      // always run after the stamp, so none can have run yet).
      await stampResult({
        status: 'created',
        history_id: row.id,
        table: historyTable,
        entity_id: row[historyIdCol],
        invoice_state: 'pending',
        workflow_state: 'pending',
      });
      return await runSideEffects(row, { invoice_state: 'pending', workflow_state: 'pending' }, { newlyCreated: false });
    };

    if (isStripe && paymentRef) {
      const { data: existingByPI } = await supabase
        .from(historyTable)
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('stripe_payment_intent_id', paymentRef)
        .maybeSingle();
      if (existingByPI) return await adoptRow(existingByPI);
    }

    const fetchYearRow = async () => {
      const { data } = await supabase
        .from(historyTable)
        .select('*')
        .eq('tenant_id', tenantId)
        .eq(historyIdCol, entityId)
        .eq('membership_year', quote.membership_year)
        .maybeSingle();
      return data || null;
    };
    let existingYearRow = await fetchYearRow();
    if (existingYearRow) {
      if (typeof existingYearRow.notes === 'string' && existingYearRow.notes.includes(ownershipMarker)) {
        return await adoptRow(existingYearRow);
      }
      // Genuinely pre-existing membership: payment stands, no duplicate.
      await noteFailure(`a membership record for ${quote.membership_year} already exists`);
      await stampResult({ status: 'year_exists', history_id: existingYearRow.id, table: historyTable });
      return { created: false, alreadyProcessed: true, historyId: existingYearRow.id };
    }

    // ── Insert the paid history row. ─────────────────────────────────────
    const paidAtIso = new Date().toISOString();
    const insertData = {
      tenant_id: tenantId,
      [historyIdCol]: entityId,
      membership_year: quote.membership_year,
      config_id: quote.config_id,
      band_id: quote.band_id || null,
      tier_label: quote.tier_label || null,
      field_value: quote.field_value ?? null,
      annual_cost: quote.annual_cost,
      prorata_cost: quote.prorata_cost,
      free_period_discount: quote.free_period_discount || 0,
      rollover_discount: 0,
      custom_discount_total: quote.custom_discount_total || 0,
      custom_discount_details: quote.custom_discount_details || null,
      final_cost: quote.final_cost,
      currency: quote.currency || 'GBP',
      billing_period: quote.billing_period || 'annual',
      vat_rate_percent: quote.vat_rate_percent || null,
      vat_amount: quote.vat_amount || 0,
      total_with_vat: quote.total_with_vat || quote.final_cost,
      year_number: quote.year_number || null,
      prorata_days: quote.prorata_days || null,
      free_period_days_applied: quote.free_period_days_applied || 0,
      payment_method: submission.payment_provider || null,
      ...(isStripe && paymentRef ? { stripe_payment_intent_id: paymentRef } : {}),
      status: 'active',
      // Settled at creation so reconciliation never re-processes it (and
      // never double-fires the membership-paid workflow).
      payment_status: 'paid',
      paid_at: paidAtIso,
      notes: `Payment received via form "${submission.form_name || submission.form_id}" (conditional membership action). ${ownershipMarker}.${paymentRef ? ` Payment ref: ${paymentRef}.` : ''}`,
    };

    const { data: insertedRow, error: insertError } = await supabase
      .from(historyTable)
      .insert(insertData)
      .select()
      .maybeSingle();

    if (insertError?.code === '23505') {
      // Concurrent insert for the same (entity, year) — re-read and either
      // adopt (ours) or stamp terminal (foreign).
      existingYearRow = await fetchYearRow();
      if (existingYearRow && typeof existingYearRow.notes === 'string' && existingYearRow.notes.includes(ownershipMarker)) {
        return await adoptRow(existingYearRow);
      }
      await stampResult({ status: 'year_exists', history_id: existingYearRow?.id || null, table: historyTable });
      return { created: false, alreadyProcessed: true, historyId: existingYearRow?.id || null };
    }
    if (insertError || !insertedRow) {
      // Transient: no stamp → the cron membership sweep retries.
      await noteFailure(`the membership record could not be saved (${insertError?.message || 'unknown error'})`);
      return { created: false };
    }

    // Stamp progress BEFORE side effects so a crash mid-way is resumable.
    await stampResult({
      status: 'created',
      history_id: insertedRow.id,
      table: historyTable,
      entity_id: entityId,
      invoice_state: 'pending',
      workflow_state: 'pending',
    });

    return await runSideEffects(insertedRow, { invoice_state: 'pending', workflow_state: 'pending' }, { newlyCreated: true });
  } catch (err) {
    // Transient/unexpected: no terminal stamp → retried by the cron sweep.
    await noteFailure(err?.message || 'unexpected error');
    return { created: false };
  }
}
