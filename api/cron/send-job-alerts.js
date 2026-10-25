import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';
import { processJobAlert } from '../_lib/jobAlertDelivery.js';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });
  const deadlineAt = Date.now() + 50000;
  const results = {};
  try {
    const drain = async () => { while (Date.now() < deadlineAt - 15000) {
      const { data, error } = await supabase.rpc('claim_job_alert_delivery');
      if (error) throw error;
      if (!data?.length) break;
      const outcome = await processJobAlert(supabase, data[0], { req, send: sendEmail, deadlineAt });
      results[outcome] = (results[outcome] || 0) + 1;
    } };
    // Small bounded concurrency; each delivery has a separate durable lease.
    const settled = await Promise.allSettled(Array.from({ length: 5 }, drain));
    if (settled.some(result => result.status === 'rejected')) throw new Error('A queue drain failed');
    return res.json({ success: true, results });
  } catch (error) {
    console.error('[Job alerts] Worker failed', error.code || error.message);
    return res.status(503).json({ error: 'Job alert processing temporarily unavailable', results });
  }
}
