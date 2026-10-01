import { timingSafeEqual } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { reconcileEventInvoices } from '../_lib/eventInvoiceRecovery.js';

export function validEventRecoveryCronSecret(req, secret = process.env.CRON_SECRET) {
  const provided = req.headers?.authorization;
  if (!secret || typeof provided !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function eventRecoveryCronHandler({ db = supabase, reconcile = reconcileEventInvoices, secret } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!validEventRecoveryCronSecret(req, secret ?? process.env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      await reconcile({ db });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(503).json({ ok: false, error: 'Event invoice recovery unavailable' });
    }
  };
}
export default eventRecoveryCronHandler();