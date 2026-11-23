import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
import { requireFunnelOwner,requireSameOriginJson } from './eventFunnelJourneyHandler.js';
import { createFunnelCheckoutService } from './eventFunnelCheckout.js';
import { createFunnelRecoveryPaymentAdapter } from './eventFunnelRecovery.js';

const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fail=(message,code,status=400)=>{throw new FunnelJourneyError(message,code,status);};
export const publicFunnelOrder=order=>({
  id:order.id,state:order.state,paymentMethod:order.payment_method,currency:order.currency,
  payableMinor:order.payable_minor,invoiceMode:order.snapshot.invoiceMode,
  trainingFundMinor:order.snapshot.trainingFundMinor || 0,voucherMinor:order.snapshot.voucherMinor || 0,
});
export function createEventFunnelCheckoutHandler({db,resolveTenant,loadViewer,resolveSelection,
  checkout=createFunnelCheckoutService({db,resolveSelection}),
  paymentFor=tenantId=>createFunnelRecoveryPaymentAdapter({db,tenantId})}) {
  return async function handler(req,res) {
    for(const [key,value] of Object.entries({'Cache-Control':'private, no-store, max-age=0',
      'CDN-Cache-Control':'no-store','Vercel-CDN-Cache-Control':'no-store','Referrer-Policy':'no-referrer',
      'X-Robots-Tag':'noindex, nofollow, noarchive',Vary:'Cookie'})) res.setHeader(key,value);
    try {
      if(req.method!=='POST') {res.setHeader('Allow','POST');fail('Method not allowed.','METHOD_NOT_ALLOWED',405);}
      requireSameOriginJson(req);
      const body=req.body;
      if(!body || typeof body!=='object' || Array.isArray(body) || JSON.stringify(body).length>80000
        || !uuid(body.sessionId) || !['summary','quote','prepare','payment','status','cancel'].includes(body.action)) {
        fail('Invalid checkout request.','INVALID_REQUEST');
      }
      const fields=['sessionId','action',...(['quote','prepare'].includes(body.action)?['command']:['payment','status','cancel'].includes(body.action)?['orderId']:[])];
      if(Object.keys(body).some(key=>!fields.includes(key))) fail('Unexpected checkout details.','INVALID_REQUEST');
      const owner=await requireFunnelOwner({req,res,db,resolveTenant,loadViewer,sessionId:body.sessionId});
      if(body.action==='summary') return res.status(200).json(await checkout.summary(owner));
      if(body.action==='quote') return res.status(200).json(await checkout.quote(owner,body.command));
      if(body.action==='prepare') {
        if(!Number.isSafeInteger(body.command?.expectedPayableMinor) || body.command.expectedPayableMinor<0) {
          fail('Review a current checkout quote before confirming.','QUOTE_REQUIRED');
        }
        // New purchasing may be switched off without stranding an already
        // frozen order or a response lost after successful preparation.
        const existing=await checkout.readOrder(owner);
        if(!existing) {
          const ready=await db.rpc('event_funnel_readiness');
          if(ready.error || ready.data?.version!==1 || ready.data.purchasing!==true) {
            fail('Checkout is not available yet.','CHECKOUT_NOT_READY',409);
          }
        }
        return res.status(200).json({order:publicFunnelOrder(await checkout.prepare(owner,body.command))});
      }
      if(!uuid(body.orderId)) fail('Invalid order.','INVALID_REQUEST');
      const {store,service}=await paymentFor(owner.tenantId);
      const order=await store.readOwned(owner,body.orderId);
      const outcome=body.action==='payment' ? await service.ensurePayment(order)
        :body.action==='cancel' ? await service.cancel(order):await service.reconcile(order);
      // Payment provider payloads and immutable private accounting bindings
      // never pass through to the browser.
      const result={orderId:order.id,state:outcome.state};
      if(body.action==='payment' && !['succeeded','confirmed','cancelled','failed','processing'].includes(outcome.state)) {
        if(typeof outcome.clientSecret==='string') result.clientSecret=outcome.clientSecret;
        if(typeof outcome.publishableKey==='string') result.publishableKey=outcome.publishableKey;
      }
      return res.status(200).json(result);
    } catch(error) {
      const known=error instanceof FunnelJourneyError;
      return res.status(known?error.status || 400:503).json({
        error:known?error.message:'Checkout could not be verified. Resume this reservation rather than paying again.',
        code:known?error.code:'CHECKOUT_UNAVAILABLE',
      });
    }
  };
}
