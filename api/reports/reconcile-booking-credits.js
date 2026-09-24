import Stripe from 'stripe';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { readXeroCreditNoteEvidence } from '../_lib/xero.js';
import { readQuickBooksCreditNoteEvidence } from '../_lib/quickbooks.js';
import { reconcileBookingCredits } from '../_lib/bookingCreditReconciliation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId || !ctx.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
    if (ctx.tenantMismatch) return res.status(409).json({ error: 'Tenant context changed. Reload this page.' });
    if (!(await hasAdminAccess(ctx)) || (ctx.roleId && !(await hasFeatureAccess(ctx.roleId, 'events.event-report', ctx.memberExcludedFeatures)))) {
      return res.status(403).json({ error: 'Event report access required' });
    }
    const { source, bookingIds, cursor } = req.body || {};
    const result = await reconcileBookingCredits({
      db: supabase, tenantId: ctx.tenantId, source, bookingIds, cursor,
      readRefunds: async (paymentIntent, after) => {
        const credentials = await getStripeCredentials(ctx.tenantId, 'events');
        if (!credentials?.secret_key || !credentials.is_enabled) throw new Error('Stripe is not enabled for this tenant');
        const stripe = new Stripe(credentials.secret_key);
        return stripe.refunds.list({ payment_intent: paymentIntent, limit: 100, ...(after ? { starting_after: after } : {}) });
      },
      readCreditNote: async (provider, id) => {
        if (provider === 'xero') return readXeroCreditNoteEvidence(ctx.tenantId, id);
        if (provider === 'quickbooks') return readQuickBooksCreditNoteEvidence(ctx.tenantId, id);
        throw new Error('Unsupported accounting provider');
      },
    });
    return res.json(result);
  } catch (error) {
    return res.status(422).json({ error: `Credit reconciliation incomplete: ${error.message}` });
  }
}