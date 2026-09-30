import Stripe from 'stripe';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { readXeroCreditNoteEvidence } from '../_lib/xero.js';
import { readQuickBooksCreditNoteEvidence } from '../_lib/quickbooks.js';
import { reconcileBookingCredits } from '../_lib/bookingCreditReconciliation.js';

function safeReconciliationError(error) {
  const message = String(error?.message || '');
  if (/Provide 1–25|Invalid .*cursor/.test(message)) {
    return { status: 400, code: 'INVALID_RECONCILIATION_REQUEST', error: message };
  }
  if (/Booking not found/.test(message)) {
    return { status: 404, code: 'CREDIT_BOOKING_NOT_FOUND', error: 'The selected booking was not found in this tenant. Reload the report and retry.' };
  }
  if (/Stripe is not enabled|Unsupported accounting provider/.test(message)) {
    return { status: 422, code: 'CREDIT_PROVIDER_UNAVAILABLE', error: 'The required payment or accounting provider is not enabled for this tenant. Check the provider connection and retry.' };
  }
  if (/evidence|database|write|persist|relation|column/i.test(message)) {
    return { status: 503, code: 'CREDIT_STORAGE_FAILURE', error: 'Credit evidence could not be stored safely. Retry; contact support if the problem continues.' };
  }
  return { status: 422, code: 'CREDIT_LOOKUP_FAILURE', error: 'Credit evidence could not be verified with the provider. Check the provider connection and retry.' };
}

export async function handleReconcileBookingCredits(req, res, {
  db = supabase,
  loadTenantContext = getTenantContext,
  checkAdminAccess = hasAdminAccess,
  checkFeatureAccess = hasFeatureAccess,
  loadStripeCredentials = getStripeCredentials,
  createStripe = secretKey => new Stripe(secretKey),
  loadXeroCreditNote = readXeroCreditNoteEvidence,
  loadQuickBooksCreditNote = readQuickBooksCreditNoteEvidence,
  reconcile = reconcileBookingCredits,
} = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!db) return res.status(503).json({ error: 'Database not configured', code: 'CREDIT_STORAGE_FAILURE' });
  try {
    const ctx = await loadTenantContext(req);
    if (!ctx?.tenantId || !ctx.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
    if (ctx.tenantMismatch) return res.status(409).json({ error: 'Tenant context changed. Reload this page.' });
    if (!(await checkAdminAccess(ctx)) || (ctx.roleId && !(await checkFeatureAccess(ctx.roleId, 'events.event-report', ctx.memberExcludedFeatures)))) {
      return res.status(403).json({ error: 'Event report access required' });
    }
    const { source, bookingIds, cursor, expectedTenantId } = req.body || {};
    if (typeof expectedTenantId !== 'string' || !expectedTenantId) {
      return res.status(400).json({
        error: 'expectedTenantId from the report response is required. Reload the report and retry.',
        code: 'EXPECTED_TENANT_REQUIRED',
      });
    }
    if (expectedTenantId !== ctx.tenantId) {
      return res.status(409).json({
        error: 'Tenant context changed since this report was loaded. Reload the report before refreshing credits.',
        code: 'EXPECTED_TENANT_MISMATCH',
      });
    }
    const result = await reconcile({
      db, tenantId: ctx.tenantId, source, bookingIds, cursor,
      readRefunds: async (paymentIntent, after) => {
        const credentials = await loadStripeCredentials(ctx.tenantId, 'events');
        if (!credentials?.secret_key || !credentials.is_enabled) throw new Error('Stripe is not enabled for this tenant');
        const stripe = createStripe(credentials.secret_key);
        return stripe.refunds.list({ payment_intent: paymentIntent, limit: 100, ...(after ? { starting_after: after } : {}) });
      },
      readCreditNote: async (provider, id) => {
        if (provider === 'xero') return loadXeroCreditNote(ctx.tenantId, id);
        if (provider === 'quickbooks') return loadQuickBooksCreditNote(ctx.tenantId, id);
        throw new Error('Unsupported accounting provider');
      },
    });
    return res.json({ ...result, tenantId: ctx.tenantId });
  } catch (error) {
    console.error('[Credit Reconciliation] Refresh failed:', error);
    const safe = safeReconciliationError(error);
    return res.status(safe.status).json({ error: safe.error, code: safe.code });
  }
}

export default async function handler(req, res) {
  return handleReconcileBookingCredits(req, res);
}