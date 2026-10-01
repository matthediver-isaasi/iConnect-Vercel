import { supabase } from '../_lib/database.js';
import { recoveryRpc } from '../_lib/eventInvoiceRecovery.js';

export function eventInvoiceRecoveryHealthHandler({ db = supabase } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ status: 'method_not_allowed' });
    try {
      const result = await recoveryRpc(db, 'health');
      const allowed = ['healthy', 'waiting_provider', 'never_succeeded', 'stale', 'stuck', 'overdue'];
      if (!result || !allowed.includes(result.status)) throw new Error('Invalid health response');
      return res.status(result.healthy === true && ['healthy', 'waiting_provider'].includes(result.status) ? 200 : 503)
        .json({ status: result.status });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  };
}
export default eventInvoiceRecoveryHealthHandler();