import Stripe from 'stripe';
import { supabase } from '../_lib/database.js';
import { getStripeCredentials } from '../_lib/stripeCredentials.js';
import { readXeroCreditNoteEvidence } from '../_lib/xero.js';
import { readQuickBooksCreditNoteEvidence } from '../_lib/quickbooks.js';
import { currencyFactor, persistBookingCreditEvidence } from '../_lib/bookingCreditEvidence.js';

export async function refreshPendingCredits({ db, readEvidence, limit = 10 }) {
  const started = Date.now();
  const batchLimit = Number.isFinite(Number(limit)) ? Math.min(10, Math.max(1, Math.floor(Number(limit)))) : 10;
  const { data, error } = await db.from('booking_reversal_evidence').select('*')
    .eq('status', 'pending').order('updated_at').order('id').limit(batchLimit);
  if (error) throw new Error(error.message);
  const results = [];
  for (const row of data || []) {
    // Unvisited rows retain their older timestamp and lead the next scheduled
    // batch. Updated timestamps are the durable queue continuation cursor.
    if (Date.now() - started >= 40000) break;
    try {
      if (!row.provider_id) throw new Error('Pending evidence is missing its provider identity');
      let timeout;
      const evidence = await Promise.race([
        Promise.resolve().then(() => readEvidence(row)),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Provider evidence read timed out')), 15000); }),
      ]).finally(() => clearTimeout(timeout));
      if (evidence.providerId !== row.provider_id) throw new Error('Provider identity mismatch');
      const status = ['succeeded', 'AUTHORISED', 'PAID'].includes(evidence.status) ? 'confirmed'
        : ['failed', 'canceled', 'VOIDED', 'DELETED'].includes(evidence.status) ? 'failed'
          : ['pending', 'requires_action', 'DRAFT', 'SUBMITTED'].includes(evidence.status) ? 'pending' : 'unavailable';
      await persistBookingCreditEvidence({
        db, tenantId: row.tenant_id, source: row.booking_source,
        operationKey: row.operation_key, evidenceKey: row.evidence_key,
        bookings: row.booking_ids.map(id => ({ id, booking_group_reference: row.group_reference })),
        leg: row.leg, provider: row.provider, providerId: row.provider_id,
        amountMinor: evidence.amountMinor ?? (Number.isFinite(evidence.amount) && evidence.currency ? Math.round(evidence.amount * currencyFactor(evidence.currency)) : null),
        currency: evidence.currency, status, paymentReference: row.payment_reference,
        detail: { ...row.detail, providerStatus: evidence.status },
      });
      results.push({ id: row.id, status });
    } catch (failure) {
      // Rotate failed lookups so a bad provider record cannot starve the queue.
      const { error: persistenceError } = await db.from('booking_reversal_evidence')
        .update({ updated_at: new Date().toISOString(), detail: { ...row.detail, reconciliationError: failure.message } })
        .eq('tenant_id', row.tenant_id).eq('booking_source', row.booking_source).eq('id', row.id);
      if (persistenceError) throw new Error(`Failed to retain reconciliation error: ${persistenceError.message}`);
      results.push({ id: row.id, error: failure.message });
    }
  }
  return results;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const results = await refreshPendingCredits({
      db: supabase,
      readEvidence: async row => {
        if (row.provider === 'stripe') {
          const credentials = await getStripeCredentials(row.tenant_id, 'events');
          if (!credentials?.secret_key || !credentials.is_enabled) throw new Error('Stripe not enabled');
          const refund = await new Stripe(credentials.secret_key).refunds.retrieve(row.provider_id);
          if (refund.payment_intent !== row.payment_reference) throw new Error('Refund payment identity mismatch');
          return { providerId: refund.id, amountMinor: refund.amount, currency: refund.currency, status: refund.status };
        }
        if (row.provider === 'xero') return readXeroCreditNoteEvidence(row.tenant_id, row.provider_id);
        if (row.provider === 'quickbooks') return readQuickBooksCreditNoteEvidence(row.tenant_id, row.provider_id);
        throw new Error('Unsupported provider');
      },
    });
    return res.json({ results });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}