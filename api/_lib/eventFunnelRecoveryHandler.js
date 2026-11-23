import { timingSafeEqual } from 'node:crypto';
import { recoverEventFunnelOrders } from './eventFunnelRecovery.js';

export function createEventFunnelRecoveryHandler({db,getSecret,paymentFor,recover=recoverEventFunnelOrders,deliverInvoices,deliverConfirmations,pruneConfirmations,deliverIntegrations}) {
  return async function handler(req,res) {
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('CDN-Cache-Control','no-store');
    const secret=getSecret();
    const provided=req.headers?.authorization;
    const expected=typeof secret==='string' && secret.length ? `Bearer ${secret}` : null;
    if(!expected || typeof provided!=='string' || Buffer.byteLength(provided)!==Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(provided),Buffer.from(expected))) {
      return res.status(401).json({error:'Unauthorized'});
    }
    if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
    if(!db) return res.status(503).json({error:'Recovery is not configured'});
    const deadlineAt=Date.now()+55000;
    try {
      // Recovery must continue when new purchasing is disabled. Its readiness
      // is the installed schema, not the customer-facing activation flag.
      const maintenance=await db.rpc('event_funnel_maintenance');
      if(maintenance.error || !maintenance.data) throw new Error('Maintenance unavailable');
      // Privacy maintenance is independent of financial recovery. Its failure
      // must be visible without preventing reconciliation of uncertain payments.
      let confirmationRetention;
      if(pruneConfirmations) {
        try {confirmationRetention=await pruneConfirmations();}
        catch {confirmationRetention={status:'retry'};}
      }
      const recovery=Date.now()<deadlineAt-2000
        ?await recover({db,paymentFor,limit:8,budgetMs:Math.min(20000,deadlineAt-Date.now()-2000)})
        :{status:'retry'};
      // Independent of payment recovery: accounting failure must never report a
      // confirmed payment as failed or invite the customer to submit it again.
      let invoices;
      if(deliverInvoices) {
        try { invoices=Date.now()<deadlineAt-2000?await deliverInvoices({deadlineAt}):{status:'retry'}; }
        catch { invoices={status:'retry'}; }
      }
      let confirmations;
      let integrations;
      if(deliverIntegrations) {
        try {integrations=Date.now()<deadlineAt-2000?await deliverIntegrations({deadlineAt}):{status:'retry'};}
        catch {integrations={status:'retry'};}
      }
      if(deliverConfirmations) {
        try {confirmations=Date.now()<deadlineAt-8000?await deliverConfirmations({deadlineAt}):{status:'retry'};}
        catch {confirmations={status:'retry'};}
      }
      return res.status(200).json({maintenance:maintenance.data,recovery,...(invoices?{invoices}:{}),
        ...(confirmations?{confirmations}:{}),...(confirmationRetention?{confirmationRetention}:{}),
        ...(integrations?{integrations}:{})});
    } catch {
      return res.status(503).json({error:'Recovery requires retry; existing financial authority has been retained'});
    }
  };
}
