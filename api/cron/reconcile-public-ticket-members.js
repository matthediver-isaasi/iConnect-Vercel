import { supabase } from '../_lib/database.js';
import { validEventRecoveryCronSecret } from './reconcile-event-invoices.js';
import { recoverPublicTicketPurchases } from '../_lib/publicTicketMemberRecovery.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!validEventRecoveryCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.status(200).json(await recoverPublicTicketPurchases(supabase));
  } catch {
    return res.status(503).json({ error: 'Ticket member recovery unavailable' });
  }
}
