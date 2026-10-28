import { supabase } from '../_lib/database.js';
import { runMemberAmendmentRecovery } from '../_lib/memberAmendmentSettlement.js';
import {runMemberChangeExecutionRecovery} from '../_lib/memberChangeExecution.js';
import {runMemberMonthlyRecovery} from '../_lib/memberMonthlyFinalizationRecovery.js';
import {runMemberCancellationFinanceRecovery} from '../_lib/memberCancellationFinanceWorker.js';

export function createMemberAmendmentRecoveryHandler({ db = supabase, run = runMemberAmendmentRecovery,
  runExecutions=runMemberChangeExecutionRecovery,
  runMonthly=runMemberMonthlyRecovery,
  runCancellations=runMemberCancellationFinanceRecovery,
  secret = () => process.env.CRON_SECRET } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const configuredSecret=secret();
    if (typeof configuredSecret!=='string'||!configuredSecret.trim()
      ||req.headers?.authorization!==`Bearer ${configuredSecret}`) return res.status(401).json({ error: 'Unauthorized' });
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      // Share the invocation budget rather than adding a second full cron run.
      const start=Date.now();
      const result = await run({ db,budgetMs:25000 });
      const executionRecovery=Date.now()-start<32500
        ? await runExecutions({db,budgetMs:Math.max(0,32500-(Date.now()-start))})
        : {enabled:true,outcomes:[],timedOut:true};
      let monthlyRecovery;
      try {
        monthlyRecovery=Date.now()-start<40000
          ? await runMonthly({db,budgetMs:Math.max(0,40000-(Date.now()-start))})
          : {enabled:true,outcomes:[],timedOut:true};
      } catch (error) {
        // An unavailable new queue must not hide completed legacy recovery.
        monthlyRecovery={enabled:true,outcomes:[],error:error.code||'monthly_recovery_failed'};
      }
      let cancellationFinanceRecovery;
      try{
        cancellationFinanceRecovery=Date.now()-start<45000
          ?await runCancellations({db,budgetMs:Math.min(5000,45000-(Date.now()-start))})
          :{available:true,outcomes:[],timedOut:true};
      }catch(error){
        cancellationFinanceRecovery={available:true,outcomes:[],error:error.code||'cancellation_finance_recovery_failed'};
      }
      return res.json({...result,executionRecovery,monthlyRecovery,cancellationFinanceRecovery});
    } catch (error) {
      return res.status(error.status || 500).json({ error: 'Membership amendment recovery failed', code: error.code || 'recovery_failed' });
    }
  };
}
export default createMemberAmendmentRecoveryHandler();
