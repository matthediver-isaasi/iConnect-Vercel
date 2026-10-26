import {MonthlyAmendmentError,monthlyAmendmentFingerprint,
  createMemberAmendmentMonthlyService} from './memberAmendmentMonthly.js';
import {monthlyStripeForTenant,monthlyGoCardlessForTenant} from './memberAmendmentMonthlyProviders.js';

const fail=message=>{throw new MonthlyAmendmentError('monthly_purchase_evidence_required',message);};
const ref=value=>typeof value==='string'?value:value?.id;
const checked=result=>{if(result.error)fail('Monthly purchase evidence could not be read.');return result.data;};
function calendar(anchor,count) {
  const first=new Date(anchor);
  if(!Number.isFinite(first.getTime()) || !Number.isInteger(count) || count<1 || count>120) fail('A finite original billing calendar is required.');
  const boundaries=Array.from({length:count+1},(_,offset)=>{
    const d=new Date(first);const originalDay=d.getUTCDate();
    d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+offset);
    d.setUTCDate(Math.min(originalDay,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));
    return d;
  });
  return {collectionDates:boundaries.slice(0,-1).map(d=>d.toISOString().slice(0,10)),
    finiteEnd:boundaries.at(-1).getTime()/1000};
}

// Read-only production adapter. Its target argument must come from a server
// pricing resolver, not a browser. No route exposes prepared provider authority.
export function createMemberMonthlyPurchaseAuthority({db,now=()=>new Date(),
  getStripe=monthlyStripeForTenant,getGc=monthlyGoCardlessForTenant,
  monthly=createMemberAmendmentMonthlyService({getStripe,getGc,now})}) {
  async function rows(table,tenantId,memberId,filters={}) {
    const found=[];
    for(let offset=0;;offset+=500) {
      let query=db.from(table).select('*').eq('tenant_id',tenantId).eq('member_id',memberId);
      for(const [key,value] of Object.entries(filters))query=query.eq(key,value);
      const page=checked(await query.order('id').range(offset,offset+499));
      if(!Array.isArray(page))fail('Invalid monthly evidence page.');
      found.push(...page);if(page.length<500)return found;
    }
  }
  async function load({tenantId,memberId,amendmentId,effectiveDate,target}) {
    if(!tenantId || !memberId)fail('Authenticated tenant and member identity are required.');
    const today=now().toISOString().slice(0,10);
    const histories=await rows('member_membership_history',tenantId,memberId);
    const active=histories.filter(p=>p.status==='active' && p.term_start_date<=today
      && (p.membership_renewal_date ? p.membership_renewal_date>today : p.term_end_date>=today));
    if(active.length!==1)fail('Exactly one current personal purchase is required.');
    const purchase=active[0];
    if(!purchase.billing_agreement_id || purchase.organization_id || purchase.membership_source==='organisation')fail('Personal monthly purchase linkage is required.');
    const agreements=await rows('membership_billing_agreements',tenantId,memberId,{id:purchase.billing_agreement_id});
    const plans=await rows('membership_payment_plans',tenantId,memberId,{billing_agreement_id:purchase.billing_agreement_id});
    if(agreements.length!==1 || plans.length!==1)fail('Exactly one owned agreement and payment plan are required.');
    const agreement=agreements[0],plan=plans[0];
    if([purchase,agreement,plan].some(r=>r.tenant_id!==tenantId || r.member_id!==memberId)
      || agreement.organization_id || plan.organization_id || agreement.agreement_type!=='member'
      || plan.billing_agreement_id!==agreement.id || agreement.id!==purchase.billing_agreement_id
      || plan.provider!==agreement.provider || plan.environment!==agreement.environment)fail('Monthly evidence ownership or provider linkage differs.');
    const provider=agreement.provider,terms=agreement.metadata?.[provider==='stripe'?'card':'dd'];
    if(!['stripe','gocardless'].includes(provider)
      || !(provider==='stripe'?['live','test']:['live','sandbox']).includes(agreement.environment)
      || !terms?.accepted_at
      || terms.kind!==(provider==='stripe'?'monthly_card':'monthly_direct_debit')
      || !purchase.term_key || terms.commitment?.term_key!==purchase.term_key
      || terms.commitment?.term_start_date!==purchase.term_start_date
      || terms.commitment?.membership_renewal_date!==purchase.membership_renewal_date
      || !Number.isInteger(terms.instalment_count) || terms.instalment_count!==plan.instalments_total
      || terms.currency?.toUpperCase()!==plan.currency?.toUpperCase()
      || terms.currency?.toUpperCase()!==purchase.currency?.toUpperCase())fail('Purchased term, consent, currency or instalment count differs.');
    if(purchase.status!=='active' || !['active','first_payment_pending'].includes(plan.status)
      || !['active','first_payment_pending'].includes(agreement.status)
      || plan.auto_retry_claim_token || plan.collection_stopped_at)fail('Monthly plan is not available for amendment.');
    const dynamic=provider==='gocardless' && terms.collection_policy?.pricing_policy==='dynamic';
    if(!dynamic && (!Number.isSafeInteger(terms.monthly_amount_minor)
      || terms.monthly_amount_minor<=0
      || Math.round(Number(terms.plan_total)*100)!==terms.monthly_amount_minor*terms.instalment_count))fail('Finite purchased payment obligation is inconsistent.');
    let dates,payerId;
    if(provider==='stripe') {
      if(!agreement.stripe_customer_id || agreement.stripe_customer_id!==plan.stripe_customer_id
        || !agreement.stripe_subscription_id || agreement.stripe_subscription_id!==plan.stripe_subscription_id)fail('Original Stripe linkage is missing.');
      const stripe=await getStripe(tenantId,agreement.environment);
      const sub=await stripe.subscriptions.retrieve(plan.stripe_subscription_id);
      const scheduleId=ref(sub.schedule);
      if(sub.id!==plan.stripe_subscription_id || ref(sub.customer)!==agreement.stripe_customer_id
        || sub.livemode!==(agreement.environment==='live') || !scheduleId)fail('Provider subscription differs from purchased linkage.');
      const schedule=await stripe.subscriptionSchedules.retrieve(scheduleId);
      if(schedule.phases?.length!==1 || schedule.end_behavior!=='cancel'
        || ref(schedule.subscription)!==sub.id || schedule.phases[0].start_date!==sub.billing_cycle_anchor)fail('Original finite one-phase schedule is required.');
      dates=calendar(sub.billing_cycle_anchor*1000,terms.instalment_count);
      if(dates.finiteEnd!==schedule.phases[0].end_date)fail('Provider end differs from the purchased instalment count.');
      payerId=agreement.stripe_customer_id;
    } else {
      const gc=await getGc(tenantId,agreement.environment);
      if(!agreement.gocardless_mandate_id || agreement.gocardless_mandate_id!==plan.gocardless_mandate_id)fail('Original mandate linkage is missing.');
      const mandate=await gc.getMandate(agreement.gocardless_mandate_id);
      if(mandate.id!==agreement.gocardless_mandate_id || mandate.status!=='active'
        || !agreement.gocardless_customer_id || mandate.links?.customer!==agreement.gocardless_customer_id)fail('Mandate payer differs from the purchased agreement.');
      payerId=agreement.gocardless_customer_id;
      let firstDate;
      if(dynamic) {
        if(terms.collection_policy?.version!==1 || plan.metadata?.collection_mode!=='dynamic'
          || plan.gocardless_subscription_id)fail('Explicit dynamic consent and plan are required.');
        firstDate=plan.metadata.dynamic_first_date;
      } else {
        if(!plan.gocardless_subscription_id)fail('Original fixed subscription is required.');
        const subscription=await gc.getSubscription(plan.gocardless_subscription_id);
        const initial=agreement.metadata?.gocardless_initial_payment;
        if(subscription.id!==plan.gocardless_subscription_id || subscription.links?.mandate!==mandate.id
          || subscription.count+(initial?.id?1:0)!==terms.instalment_count)fail('Fixed subscription count or mandate differs.');
        firstDate=subscription.start_date;
        if(initial?.id) {
          // The initial collection need not share the recurring subscription's
          // day. Preserve both provider dates; never subtract a nominal month.
          const payment=await gc.getPayment(initial.id);
          if(payment.id!==initial.id || payment.links?.mandate!==mandate.id || payment.links?.subscription
            || !['confirmed','paid_out'].includes(payment.status) || Number(payment.amount_refunded||0)!==0
            || payment.currency!==terms.currency.toUpperCase() || payment.amount!==terms.monthly_amount_minor
            || (initial.charge_date && initial.charge_date!==payment.charge_date)
            || !/^\d{4}-\d{2}-\d{2}$/.test(payment.charge_date||'')
            || payment.charge_date>=firstDate)fail('Initial payment date, ownership or settlement could not be reconciled.');
          dates=calendar(`${firstDate}T00:00:00Z`,subscription.count);
          dates.collectionDates.unshift(payment.charge_date);
        }
      }
      if(!/^\d{4}-\d{2}-\d{2}$/.test(firstDate||'')
        || new Date(`${firstDate}T00:00:00Z`).toISOString().slice(0,10)!==firstDate)fail('Exact original collection start date is required.');
      dates ||= calendar(`${firstDate}T00:00:00Z`,terms.instalment_count);
      if(dynamic && Number(plan.metadata?.collection_schedule_version||0)!==0) {
        // Reuse the collector's SQL authority for the complete immutable
        // collection-day revision chain instead of regenerating past dates.
        const resolved=[];
        for(let start=1;start<=terms.instalment_count;start+=12) {
          const batch=Array.from({length:Math.min(12,terms.instalment_count-start+1)},(_,i)=>start+i);
          resolved.push(...await Promise.all(batch.map(async ordinal=>checked(await db.rpc(
            'gocardless_dynamic_collection_due_date',{p_plan_id:plan.id,p_collection_number:ordinal})))));
        }
        if(resolved.some((date,i)=>typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
          || (i>0 && date<=resolved[i-1])))fail('Collection-day history is incomplete or unordered.');
        dates.collectionDates=resolved;
        const current=await rows('membership_payment_plans',tenantId,memberId,{id:plan.id});
        if(current.length!==1 || monthlyAmendmentFingerprint(current[0])!==monthlyAmendmentFingerprint(plan)) {
          fail('Collection schedule changed during evidence resolution; load it again.');
        }
      }
    }
    if(dates.collectionDates.some((date,i)=>!Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date
      || date<purchase.term_start_date || date>=purchase.membership_renewal_date
      || (i>0 && date<=dates.collectionDates[i-1]))) {
      fail('Collection dates must belong to the purchased term in strict chronological order.');
    }
    return {tenantId,memberId,amendmentId,effectiveDate,target,purchase,agreement,plan,authority:{
      tenantId,memberId,purchaseId:purchase.id,agreementId:agreement.id,planId:plan.id,
      provider,environment:agreement.environment,payerId,termKey:purchase.term_key,
      termsHash:monthlyAmendmentFingerprint(terms),pricingBasis:dynamic?'monthly_price':'annual_instalments',
      currency:terms.currency.toUpperCase(),...dates,
    }};
  }
  // Existing provider inspection independently verifies every generated payment,
  // notice date, schedule item and target price before producing prepared data.
  return {load,prepare:async request=>monthly.prepare(await load(request))};
}
