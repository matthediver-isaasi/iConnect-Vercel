import {monthlyStripeForTenant,monthlyGoCardlessForTenant} from './memberAmendmentMonthlyProviders.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';

const ref=value=>typeof value==='string'?value:value?.id;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_provider_conflict'});};

/**
 * Server-internal provider boundary. A durable, exclusively claimed operation
 * is required before submitting a stop. Recovery only reads provider state.
 * No mandate is cancelled and existing payment settlement is never inferred
 * from stopping future subscription collections.
 */
export function createMemberCancellationProvider({
 getStripe=monthlyStripeForTenant,getGc=monthlyGoCardlessForTenant,
}={}){
 function validate(a){
  if(!a||![a.tenantId,a.memberId,a.agreementId].every(v=>uuid.test(v||''))
   ||!a.subscriptionId||!a.payerId
   ||!['stripe','gocardless'].includes(a.provider)
   ||!(a.provider==='stripe'?['live','test']:['live','sandbox']).includes(a.environment)
   ||(a.provider==='stripe'&&!a.scheduleId)
   ||(a.provider==='gocardless'&&!a.mandateId)){
   fail('Owned subscription authority and its recorded environment are required.');
  }
 }
 async function inspect(a){
  validate(a);
  if(a.provider==='stripe'){
   const client=await getStripe(a.tenantId,a.environment);
   const subscription=await client.subscriptions.retrieve(a.subscriptionId);
   if(subscription.id!==a.subscriptionId||ref(subscription.customer)!==a.payerId
    ||subscription.livemode!==(a.environment==='live')
    ||subscription.metadata?.tenant_id!==a.tenantId
    ||subscription.metadata?.member_id!==a.memberId
    ||subscription.metadata?.kind!=='monthly_card'
    ||subscription.metadata?.agreement_id!==a.agreementId){
    fail('Stripe subscription ownership changed.');
   }
   const schedule=await client.subscriptionSchedules.retrieve(a.scheduleId);
   if(schedule.id!==a.scheduleId||ref(schedule.customer)!==a.payerId
    ||schedule.livemode!==(a.environment==='live')){
    fail('Stripe schedule ownership changed.');
   }
   if(subscription.status==='canceled'&&['canceled','completed'].includes(schedule.status)){
    return {state:'stopped',subscriptionId:a.subscriptionId,scheduleId:a.scheduleId,
     existingPaymentsRequireReconciliation:true};
   }
   if(subscription.status!=='active'||schedule.status!=='active'
    ||ref(subscription.schedule)!==a.scheduleId||ref(schedule.subscription)!==a.subscriptionId){
    fail('Stripe subscription and schedule require reconciliation before stopping.');
   }
   return {state:'active',subscriptionId:a.subscriptionId,scheduleId:a.scheduleId};
  }
  const client=await getGc(a.tenantId,a.environment);
  const subscription=await client.getSubscription(a.subscriptionId);
  const mandate=await client.getMandate(a.mandateId);
  if(subscription.id!==a.subscriptionId||subscription.links?.mandate!==a.mandateId
   ||mandate.id!==a.mandateId||mandate.links?.customer!==a.payerId){
   fail('Direct Debit subscription or payer changed.');
  }
  if(['cancelled','finished'].includes(subscription.status)){
   return {state:'stopped',subscriptionId:a.subscriptionId,
    existingPaymentsRequireReconciliation:true};
  }
  if(!['active','paused'].includes(subscription.status)||mandate.status!=='active'){
   fail('Direct Debit subscription state requires reconciliation.');
  }
  return {state:'active',subscriptionId:a.subscriptionId};
 }
 async function prepare(authority){
  const owned=structuredClone(authority);
  const observation=await inspect(owned);
  const body={version:1,authority:owned,kind:'stop_subscription_without_settlement'};
  return {...body,fingerprint:monthlyAmendmentFingerprint(body),observation};
 }
 async function prepareOwnedSubscription(authority){
  if(authority?.provider!=='stripe')return prepare(authority);
  if(![authority.tenantId,authority.memberId,authority.agreementId].every(v=>uuid.test(v||''))
   ||!['live','test'].includes(authority.environment)||!authority.subscriptionId||!authority.payerId){
   fail('Owned Stripe subscription and recorded environment are required.');
  }
  const client=await getStripe(authority.tenantId,authority.environment);
  const subscription=await client.subscriptions.retrieve(authority.subscriptionId);
  const scheduleId=ref(subscription.schedule);
  if(!scheduleId)fail('The purchased Stripe schedule is unavailable.');
  return prepare({...authority,scheduleId});
 }
 function verify(prepared){
  const {fingerprint,observation,...body}=prepared||{};
  if(body.version!==1||body.kind!=='stop_subscription_without_settlement'
   ||fingerprint!==monthlyAmendmentFingerprint(body))fail('Cancellation provider snapshot changed.');
  validate(body.authority);
  return body.authority;
 }
 async function reconcile(prepared){
  return inspect(verify(prepared));
 }
 async function submitReservedStop(prepared,claim){
  const authority=verify(prepared);
  if(!claim||claim.state!=='claimed'||!uuid.test(claim.id||'')||!uuid.test(claim.claim_token||'')
   ||claim.fingerprint!==prepared.fingerprint||claim.tenant_id!==authority.tenantId
   ||claim.member_id!==authority.memberId){
   fail('An exclusive, tenant-bound cancellation claim is required.');
  }
  // This read is before the mutation. Failure here is not an unknown write.
  const before=await inspect(authority);
  if(before.state==='stopped')return before;
  try{
   if(authority.provider==='stripe'){
    const client=await getStripe(authority.tenantId,authority.environment);
    await client.subscriptionSchedules.cancel(authority.scheduleId,
     {invoice_now:false,prorate:false},{idempotencyKey:`member-cancel:${claim.id}`});
   }else{
    const client=await getGc(authority.tenantId,authority.environment);
    await client.cancelSubscription(authority.subscriptionId);
   }
   return await reconcile(prepared);
  }catch(error){
   return {state:'uncertain',subscriptionId:authority.subscriptionId,
    code:typeof error?.code==='string'?error.code:'provider_stop_unconfirmed',
    existingPaymentsRequireReconciliation:true};
  }
 }
 return {prepare,prepareOwnedSubscription,reconcile,submitReservedStop};
}
