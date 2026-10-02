import { timingSafeEqual } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { reconcileAccountingRequests } from '../_lib/accountingRequestQueue.js';

export function validAccountingRequestCronSecret(req, secret = process.env.CRON_SECRET) {
  const supplied = req.headers?.authorization;
  const expected = Buffer.from(`Bearer ${secret || ''}`);
  const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
  return Boolean(secret) && expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function accountingRequestCronHandler({
  db = supabase, reconcile = reconcileAccountingRequests, secret,
  enabled = () => process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED === 'true',
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!validAccountingRequestCronSecret(req, secret ?? process.env.CRON_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (enabled() !== true) return res.status(200).json({ ok: true, enabled: false, processed: 0 });
    try {
      const results = await reconcile({ db });
      return res.status(200).json({ ok: true, processed: results.length });
    } catch {
      return res.status(503).json({ ok: false, error: 'Accounting request queue unavailable' });
    }
  };
}

export default accountingRequestCronHandler();