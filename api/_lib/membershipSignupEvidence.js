import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';

// The caller must have loaded the agreement through the history row's ID and
// checked its tenant and exclusive personal/organisation owner first.
export function signupMonthlyPriceFromAgreement(agreement) {
  if (agreement?.provider !== 'gocardless') return null;
  const dd = agreement.metadata?.dd;
  if (!dd || typeof dd !== 'object' || Array.isArray(dd)) return null;
  const minor = dd.monthly_amount_minor;
  const currency = dd.currency;
  if (!Number.isSafeInteger(minor) || minor <= 0
      || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const policy = resolveSavedCollectionPolicy(dd);
  if (policy.needs_review) return null;
  // A contradictory major-unit value means the retained snapshot is ambiguous.
  if (dd.monthly_amount != null
      && (!Number.isFinite(Number(dd.monthly_amount))
        || Math.round(Number(dd.monthly_amount) * 100) !== minor)) return null;
  return { amount: minor / 100, currency, variable: policy.pricing_policy === 'dynamic' };
}

// Completed authorisation is not an active mandate or a promised collection.
// Only a processed, exact billing-request fulfillment tied to this agreement's
// mandate establishes that the payer completed the flow.
export async function completedPendingBankActivation(db, tenantId, agreement) {
  if (agreement?.provider !== 'gocardless' || agreement.status !== 'mandate_pending'
      || !agreement.gocardless_billing_request_id || !agreement.gocardless_mandate_id) return false;
  const { data: mandate, error: mandateError } = await db.from('gocardless_mandates')
    .select('tenant_id, gocardless_mandate_id, environment, status')
    .eq('tenant_id', tenantId)
    .eq('gocardless_mandate_id', agreement.gocardless_mandate_id)
    .maybeSingle();
  if (mandateError || mandate?.tenant_id !== tenantId
      || mandate.gocardless_mandate_id !== agreement.gocardless_mandate_id
      || mandate.environment !== agreement.environment
      || !['created', 'pending_submission', 'submitted'].includes(mandate.status)) return false;
  const { data: events, error } = await db.from('payment_webhook_events')
    .select('tenant_id, provider, event_id, resource_type, action, resource_id, payload, processing_status, processing_error')
    .eq('tenant_id', tenantId)
    .eq('provider', 'gocardless')
    .eq('resource_type', 'billing_requests')
    .eq('action', 'fulfilled')
    .eq('resource_id', agreement.gocardless_billing_request_id)
    .eq('processing_status', 'processed')
    .limit(20);
  if (error || !Array.isArray(events)) return false;
  return events.some((event) => event.tenant_id === tenantId
    && event.provider === 'gocardless'
    && event.resource_type === 'billing_requests'
    && event.action === 'fulfilled'
    && event.resource_id === agreement.gocardless_billing_request_id
    && event.processing_status === 'processed'
    && !event.processing_error
    && event.event_id === event.payload?.id
    && event.payload?.resource_type === 'billing_requests'
    && event.payload?.action === 'fulfilled'
    && event.payload?.links?.billing_request === agreement.gocardless_billing_request_id
    && event.payload?.links?.mandate_request_mandate === agreement.gocardless_mandate_id);
}