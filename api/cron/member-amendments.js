import { supabase } from '../_lib/database.js';
import { runMemberAmendmentRecovery } from '../_lib/memberAmendmentSettlement.js';
import {runMemberChangeExecutionRecovery} from '../_lib/memberChangeExecution.js';

export function createMemberAmendmentRecoveryHandler({ db = supabase, run = runMemberAmendmentRecovery,
  runExecutions=runMemberChangeExecutionRecovery,
  secret = () => process.env.CRON_SECRET } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!secret() || req.headers.authorization !== `Bearer ${secret()}`) return res.status(401).json({ error: 'Unauthorized' });
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      // Share the invocation budget rather than adding a second full cron run.
      const start=Date.now();
      const result = await run({ db,budgetMs:25000 });
      const executionRecovery=Date.now()-start<40000
        ? await runExecutions({db,budgetMs:Math.max(0,40000-(Date.now()-start))})
        : {enabled:true,outcomes:[],timedOut:true};
      return res.json({...result,executionRecovery});
    } catch (error) {
      return res.status(error.status || 500).json({ error: 'Membership amendment recovery failed', code: error.code || 'recovery_failed' });
    }
  };
}
export default createMemberAmendmentRecoveryHandler();
