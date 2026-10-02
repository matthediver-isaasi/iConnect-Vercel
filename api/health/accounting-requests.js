import { supabase } from '../_lib/database.js';
import { validAccountingRequestCronSecret } from '../cron/reconcile-accounting-requests.js';

// Machine-authenticated, aggregate-only health. No adapter imports or provider reads.
export function accountingRequestHealthHandler({
  db = supabase, secret, enabled = () => process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED === 'true',
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ status: 'method_not_allowed' });
    if (!validAccountingRequestCronSecret(req, secret ?? process.env.CRON_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      if (!db?.rpc) throw new Error('Database unavailable');
      const query = db.rpc('accounting_request_health');
      const { data, error } = await (typeof query.abortSignal === 'function'
        ? query.abortSignal(AbortSignal.timeout(5000)) : query);
      if (error || !data || !['healthy', 'waiting_provider', 'attention'].includes(data.status)) {
        throw new Error('Health unavailable');
      }
      const counts = {};
      for (const key of ['total', 'pending', 'retry', 'running', 'unknown', 'review', 'complete', 'overdue', 'expired_leases', 'waiting_provider']) {
        if (!Number.isSafeInteger(data[key]) || data[key] < 0) throw new Error('Invalid health count');
        counts[key] = data[key];
      }
      return res.status(data.status === 'attention' ? 503 : 200)
        .json({ status: data.status, enabled: enabled() === true, counts });
    } catch {
      return res.status(503).json({ status: 'unavailable', enabled: enabled() === true });
    }
  };
}

export default accountingRequestHealthHandler();