import { supabase } from '../_lib/database.js';
import { continueBookingCreditInvoice } from '../_lib/bookingCreditAttempt.js';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'Cron secret not configured' });
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const { data, error } = await supabase.from('booking_credit_attempt').select('tenant_id,purchase_key')
    .eq('state','committed').eq('invoice_state','pending').order('created_at').limit(25);
  if (error) return res.status(503).json({ error: 'Booking invoice recovery unavailable' });
  const results = [];
  const started = Date.now();
  for (const row of data || []) {
    if (Date.now() - started > 40000) break;
    try {
      const response = await continueBookingCreditInvoice(supabase,row.tenant_id,row.purchase_key);
      results.push({ purchase_key: row.purchase_key, invoice: response.invoice_recovery });
    } catch (error) {
      results.push({ purchase_key: row.purchase_key, error: error.message });
    }
  }
  return res.json({ results });
}
