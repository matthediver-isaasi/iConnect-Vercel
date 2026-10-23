import { membershipIsBlocked } from './formMembershipIntegrity.js';
import { FORM_STRIPE_SETTLEMENT_CLAIM_TTL_MS } from './formStripeInvoiceSettlement.js';
import { WORKFLOW_CLAIM_TTL_MS } from './formMembershipFinalize.js';

// Presentation only: never call finalization, settlement, or a provider here.
export function accountingProgressSummary(progress, now = Date.now()) {
  if (membershipIsBlocked(progress) || progress.invoice_state === 'failed'
      || progress.settlement_state === 'failed') return { state: 'attention', retryAt: null };
  const pending = ['pending', 'retry', 'processing'];
  if (!pending.includes(progress.invoice_state) && !pending.includes(progress.settlement_state)) {
    return { state: progress.invoice_state === 'done'
      && ['done', 'skipped'].includes(progress.settlement_state) ? 'complete' : 'unavailable', retryAt: null };
  }
  const times = [Date.parse(progress.accounting_retry_after)];
  if (progress.invoice_state === 'processing') {
    times.push(Date.parse(progress.invoice_claimed_at) + WORKFLOW_CLAIM_TTL_MS);
  }
  if (progress.settlement_state === 'processing') {
    times.push(Date.parse(progress.settlement_claimed_at) + FORM_STRIPE_SETTLEMENT_CLAIM_TTL_MS);
  }
  const retryTime = Math.max(...times.filter(Number.isFinite));
  return {
    state: retryTime > now ? 'waiting' : 'pending',
    retryAt: Number.isFinite(retryTime) ? new Date(retryTime).toISOString() : null,
  };
}

export async function attachMembershipAccountingProgress(db, { tenantId, history, now = Date.now() }) {
  // Inspect paid Stripe rows even before an error diagnostic is written.
  // maybeSingle fails closed on ambiguity.
  for (const row of history) {
    if (row.payment_status !== 'paid' || !row.stripe_payment_intent_id) continue;
    try {
      const { data, error } = await db.from('form_submission')
        .select('payment_reference,payment_meta')
        .eq('tenant_id', tenantId).eq('payment_provider', 'stripe').eq('payment_status', 'paid')
        .eq('payment_reference', row.stripe_payment_intent_id)
        .filter('payment_meta->membership_result->>history_id', 'eq', row.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) continue; // Preserve the existing non-form recovery action.
      const progress = data.payment_meta?.membership_result;
      const target = data.payment_meta?.membership?.quote?.target;
      const table = row.membership_source === 'organisation'
        ? 'organisation_membership_history' : 'member_membership_history';
      const expectedTarget = table === 'member_membership_history' ? 'member' : 'organization';
      if (!progress || progress.history_id !== row.id || target !== expectedTarget
          || (progress.table && progress.table !== table)
          || progress.entity_id !== (expectedTarget === 'member' ? row.member_id : row.organization_id)) {
        row.accounting_progress = { state: 'attention', retryAt: null };
      } else {
        row.accounting_progress = accountingProgressSummary(progress, now);
      }
    } catch {
      row.accounting_progress = { state: 'unavailable', retryAt: null };
    }
  }
}
