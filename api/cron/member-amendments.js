import { supabase } from '../_lib/database.js';
import { runMemberAmendmentRecovery } from '../_lib/memberAmendmentSettlement.js';

export function createMemberAmendmentRecoveryHandler({ db = supabase, run = runMemberAmendmentRecovery,
  secret = () => process.env.CRON_SECRET } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!secret() || req.headers.authorization !== `Bearer ${secret()}`) return res.status(401).json({ error: 'Unauthorized' });
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const result = await run({ db });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ error: 'Membership amendment recovery failed', code: error.code || 'recovery_failed' });
    }
  };
}
export default createMemberAmendmentRecoveryHandler();
