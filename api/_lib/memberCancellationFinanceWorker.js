import {createMemberCancellationRecovery} from './memberCancellationRecovery.js';
import {createMemberCancellationFinance} from './memberCancellationFinance.js';
import {createMemberCancellationNotifications} from './memberCancellationNotifications.js';

// This worker cannot admit cancellations, end access or stop subscriptions.
// Its database selector only returns already-applied, financially approved work.
export function runMemberCancellationFinanceRecovery({db,budgetMs=5000,
 finance=createMemberCancellationFinance({db}),
 notify=createMemberCancellationNotifications({db}),
}){
 if(!Number.isFinite(budgetMs)||budgetMs<=0)return Promise.resolve({available:true,outcomes:[],timedOut:true});
 return createMemberCancellationRecovery({db,finance,notify,
  claimRpc:'claim_member_cancellation_finance_jobs',allowedKinds:['finance','notify_finance'],
  requests:{recover(){throw Error('Lifecycle execution is not enabled in financial recovery');}},
 }).run({budgetMs:Math.min(budgetMs,5000),limit:2});
}

// The full worker is separate from the financial-only compatibility entry
// point. Admission, source-conflict and withdrawal guards must be installed
// before deploying this caller. One job per invocation bounds provider work.
export function runMemberCancellationRecovery({db,budgetMs=5000,requests,
 finance=createMemberCancellationFinance({db}),
 notify=createMemberCancellationNotifications({db}),
}){
 if(!Number.isFinite(budgetMs)||budgetMs<=0)return Promise.resolve({available:true,outcomes:[],timedOut:true});
 return createMemberCancellationRecovery({db,requests,notify,
  finance:{recover:(context,id)=>finance.recover(context,id,{budgetMs:Math.min(budgetMs,5000),maxSteps:1})},
  claimRpc:'claim_member_cancellation_jobs',
  allowedKinds:['lifecycle','finance','notify_access','notify_finance'],
 }).run({budgetMs:Math.min(budgetMs,5000),limit:1});
}
