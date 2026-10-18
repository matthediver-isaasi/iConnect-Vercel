import { supabase } from '../_lib/database.js';
import { validAccountingRequestCronSecret } from './reconcile-accounting-requests.js';
import { runSalesInvoiceSchedule } from '../_lib/salesInvoiceSchedule.js';

export function salesInvoiceScheduleHandler({ db = supabase, run = runSalesInvoiceSchedule, secret } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!validAccountingRequestCronSecret(req, secret ?? process.env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
    try { return res.status(200).json({ ok: true, ...await run({ db }) }); }
    catch { return res.status(503).json({ ok: false, error: 'Sales invoice schedule unavailable' }); }
  };
}
export default salesInvoiceScheduleHandler();
