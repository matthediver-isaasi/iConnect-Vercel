import { supabase } from '../_lib/database.js';
import { createEventFunnelRecoveryHandler } from '../_lib/eventFunnelRecoveryHandler.js';
import { createFunnelRecoveryPaymentAdapter, deliverEventFunnelOrders } from '../_lib/eventFunnelRecovery.js';
import { deliverFunnelInvoices } from '../_lib/eventFunnelInvoiceDelivery.js';
import { deliverFunnelConfirmations } from '../_lib/eventFunnelConfirmations.js';
import { pruneFunnelConfirmations } from '../_lib/eventFunnelConfirmationRetention.js';
import { deliverFunnelIntegrations } from '../_lib/eventFunnelIntegrations.js';
import { withFunnelWorkerActivation } from '../_lib/eventFunnelActivation.js';

export const config={maxDuration:60};
// Scheduling alone cannot start provider work; admission is service-only,
// production-only and pinned to the operator-verified release.
const handler = createEventFunnelRecoveryHandler({
  db:supabase,
  getSecret:()=>process.env.CRON_SECRET,
  paymentFor:tenantId=>createFunnelRecoveryPaymentAdapter({db:supabase,tenantId}),
  pruneConfirmations:()=>pruneFunnelConfirmations({db:supabase}),
  deliverInvoices:({deadlineAt:overall})=>deliverEventFunnelOrders({db:supabase,kind:'invoices',limit:4,
    budgetMs:Math.min(15000,overall-Date.now()-1000),
    deliver:(job,{deadlineAt})=>deliverFunnelInvoices({db:supabase,job,deadlineAt:Math.min(deadlineAt,overall)})}),
  deliverIntegrations:({deadlineAt:overall})=>deliverEventFunnelOrders({db:supabase,kind:'integrations',limit:1,
    budgetMs:Math.min(10000,overall-Date.now()-1000),
    deliver:(job,{deadlineAt})=>deliverFunnelIntegrations({db:supabase,job,deadlineAt:Math.min(deadlineAt,overall)})}),
  deliverConfirmations:({deadlineAt:overall})=>deliverEventFunnelOrders({db:supabase,kind:'confirmations',limit:1,
    budgetMs:Math.min(10000,overall-Date.now()-1000),
    deliver:(job,{deadlineAt})=>deliverFunnelConfirmations({db:supabase,job,deadlineAt:Math.min(deadlineAt,overall)})}),
});
export default withFunnelWorkerActivation({ db:supabase, worker:'recovery', handler });
