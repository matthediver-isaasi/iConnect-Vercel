import Stripe from 'stripe';
import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { getStripeIntegrationCredentials } from '../../_lib/stripeCredentials.js';
import { payoutSummary, readPayoutPage, readEvidencePage } from '../../_lib/stripePayoutReads.js';
import { PAYOUT_SOURCES } from '../../../shared/stripePayoutReport.mjs';
import { signPayoutScope, verifyPayoutScope } from '../../_lib/stripePayoutScope.js';
import { enrichPayoutContacts } from '../../_lib/stripePayoutContacts.js';

export function createStripePayoutReportHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Read-only report; GET required.' });
    try {
      const ctx = await (deps.getContext || getTenantContext)(req);
      if (!ctx?.isAuthenticated || !ctx.tenantId) return res.status(401).json({ error: 'Authentication required.' });
      if (ctx.tenantMismatch) return res.status(409).json({ error: 'Tenant changed. Reload the page.' });
      if (!await (deps.checkAdmin || hasAdminAccess)(ctx)
        || (!ctx.tenantUserId && (!ctx.roleId || !await (deps.checkFeature || hasFeatureAccess)(
          ctx.roleId, 'commerce.stripe-payout-report', ctx.memberExcludedFeatures)))) {
        return res.status(403).json({ error: 'Stripe Payout Reconciliation permission required.' });
      }
      const q = req.query || {};
      if (!['live', 'test'].includes(q.mode)) return res.status(400).json({ error: 'Select Live or Test.' });
      const credentials = await (deps.credentials || getStripeIntegrationCredentials)(ctx.tenantId);
      const key = q.mode === 'test' ? credentials?.test_secret_key : credentials?.secret_key;
      if (!key || !credentials?.is_enabled) return res.status(503).json({
        error: 'Stripe account history is unavailable. Ask an administrator to check this tenant’s selected environment credentials.' });
      if (q.action === 'evidence') {
        const { ids } = verifyPayoutScope(key, q.scope, ctx.tenantId, q.mode);
        const offset = Number(q.offset || 0);
        if (!PAYOUT_SOURCES.includes(q.source) || !ids.length || ids.length > 20
          || ids.some(v => !/^(pi|in)_[A-Za-z0-9]{1,200}$/.test(v))
          || !Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: 'Invalid evidence request.' });
        const page = await readEvidencePage(deps.db || supabase, ctx.tenantId, q.source, ids, offset, q.mode);
        return res.json({ ...page, rows: await enrichPayoutContacts(page.rows, ctx.tenantId, deps.xero) });
      }
      const stripe = deps.stripe || new Stripe(key, { timeout: 2500, maxNetworkRetries: 0 });
      if (q.payout) {
        if (!/^po_[A-Za-z0-9]{1,200}$/.test(q.payout)
          || (q.cursor && !/^txn_[A-Za-z0-9]{1,200}$/.test(q.cursor))) return res.status(400).json({ error: 'Invalid payout or cursor.' });
        const page = await readPayoutPage(stripe, q.payout, q.cursor, q.mode);
        const ids = [...new Set(page.rows.flatMap(r => [r.paymentIntentId, r.stripeInvoiceId]).filter(Boolean))];
        return res.json({ ...page, evidenceToken: signPayoutScope(key, {
          tenantId: ctx.tenantId, mode: q.mode, payout: q.payout, ids,
        }) });
      }
      const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!validDate(q.from) || !validDate(q.to) || q.from > q.to
        || (q.cursor && !/^po_[A-Za-z0-9]{1,200}$/.test(q.cursor))) return res.status(400).json({ error: 'Choose a valid arrival-date range.' });
      const result = await stripe.payouts.list({ limit: 50,
        arrival_date: { gte: Date.parse(q.from) / 1000, lt: Date.parse(q.to) / 1000 + 86400 },
        ...(q.cursor ? { starting_after: q.cursor } : {}) });
      if (!Array.isArray(result.data) || (result.has_more && !result.data.length)
        || result.data.some(p => p.livemode !== (q.mode === 'live'))) throw new Error('Invalid provider page.');
      return res.json({ payouts: result.data.map(payoutSummary), next: result.has_more ? result.data.at(-1).id : null });
    } catch (error) {
      return res.status(502).json({ error: error.message?.startsWith('Stored linkage unavailable')
        ? error.message : 'Report retrieval failed or account history is unavailable. Nothing was changed. Retry or contact your administrator.' });
    }
  };
}
export default createStripePayoutReportHandler();
