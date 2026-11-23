import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { getStripeCredentials } from './stripeCredentials.js';
import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';

/** Reuse the tenant's existing events integration; never switch provider/mode. */
export function createFunnelStripeProvider({ tenantId, loadCredentials = getStripeCredentials, StripeClient = Stripe, deadlineAt }) {
  return async frozen => {
    const credentials = await loadCredentials(tenantId,'events');
    const identity = credentials?.secret_key ? {
      accountFingerprint: createHash('sha256').update(credentials.secret_key).digest('hex'),
      mode: credentials.mode,
    } : null;
    if (!identity || !credentials.publishable_key || !['live','test'].includes(identity.mode)
      || identity.accountFingerprint !== frozen?.accountFingerprint || identity.mode !== frozen.mode) {
      throw new FunnelJourneyError('The original payment account could not be verified. Do not pay again.','PAYMENT_ACCOUNT_UNAVAILABLE',503);
    }
    const stripe = new StripeClient(credentials.secret_key,{ timeout:10000,maxNetworkRetries:1 });
    const refundOptions=()=>{
      const remaining=deadlineAt===undefined?10000:deadlineAt-Date.now();
      if(remaining<250)throw new Error('Refund recovery time budget exhausted');
      return {timeout:Math.min(10000,remaining),maxNetworkRetries:0};
    };
    return {
      identity,canCreate: credentials.is_enabled !== false,publishableKey: credentials.publishable_key,
      // SDK retries retain the identical key. Do not persist or return credentials.
      create: (parameters,options) => stripe.paymentIntents.create(parameters,options),
      retrieve: id => stripe.paymentIntents.retrieve(id,{ expand:['latest_charge'] }),
      cancel: id => stripe.paymentIntents.cancel(id,{}, { idempotencyKey: `event-funnel-cancel-${id}` }),
      authority:async()=>identity,
      canWrite:()=>deadlineAt===undefined||deadlineAt-Date.now()>1500,
      retrieveCharge:id=>stripe.charges.retrieve(id,{},refundOptions()),
      createRefund:(parameters,options)=>stripe.refunds.create(parameters,{...options,...refundOptions()}),
      listAllRefunds:async charge=>{
        const refunds=[];let cursor;
        for(let page=0;page<100;page++){
          const result=await stripe.refunds.list({charge,limit:100,...(cursor?{starting_after:cursor}:{})},refundOptions());
          if(!Array.isArray(result?.data)||typeof result.has_more!=='boolean')return {complete:false,refunds:[]};
          refunds.push(...result.data);
          if(!result.has_more)return {complete:true,refunds};
          const next=result.data.at(-1)?.id;
          if(!next||next===cursor)return {complete:false,refunds:[]};
          cursor=next;
        }
        return {complete:false,refunds:[]};
      },
    };
  };
}
