import {
 monthlyStripeForTenant,monthlyGoCardlessForTenant,allStripeInvoices,allStripeInvoicePayments,allGoCardlessPayments,
} from './memberAmendmentMonthlyProviders.js';
import {createMemberCancellationProvider} from './memberCancellationProvider.js';
import {amendmentDay} from './memberAmendmentMoney.js';

const ref=value=>typeof value==='string'?value:value?.id;
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_cash_unverified'});};
const minor=value=>Number.isSafeInteger(value)&&value>=0;
const day=seconds=>new Date(seconds*1000).toISOString().slice(0,10);

/**
 * Read-only cash evidence after access has ended. Failed/unpaid collections
 * are not cash; they also do not prove that no service debt exists.
 * This deliberately does not use the monthly price-amendment engine, whose
 * active-subscription/billing-boundary requirements no longer apply here.
 */
export function createMemberCancellationCashReader({
 db,getStripe=monthlyStripeForTenant,getGc=monthlyGoCardlessForTenant,
 provider=createMemberCancellationProvider({getStripe,getGc}),
}){
 async function read(record){
  const a=record?.authority,agreement=a?.agreementSnapshot,plan=a?.planSnapshot,source=a?.sourceSnapshot;
  if(!record.access_ended_at||!source||source.id!==record.source_record_id
   ||a.tenantId!==record.tenant_id||a.memberId!==record.member_id
   ||!agreement||!plan||source.billing_agreement_id!==agreement.id
   ||plan.billing_agreement_id!==agreement.id
   ||agreement.agreement_type!=='member'||source.membership_source==='organisation'
   ||[agreement,plan,source].some(row=>row.organization_id||row.tenant_id!==record.tenant_id||row.member_id!==record.member_id)
   ||agreement.provider!==plan.provider||agreement.environment!==plan.environment){
   fail('Applied cancellation and original owned billing plan are required.');
  }
  const currency=source.currency;
  if(!/^[A-Z]{3}$/.test(currency||''))fail('Purchased currency is unavailable.');
  amendmentDay(source.term_start_date);amendmentDay(source.membership_renewal_date);
  if(source.term_start_date>=source.membership_renewal_date)fail('Purchased service dates are unavailable.');
  const result={sourceRecordId:source.id,agreementId:agreement.id,planId:plan.id,
   currency,provider:plan.provider,payments:[],unresolved:[],failed:[],complete:true};
  if(a.providerPrepared){
   const owned=a.providerPrepared.authority;
   if(!owned||owned.tenantId!==record.tenant_id||owned.memberId!==record.member_id
    ||owned.agreementId!==agreement.id||owned.provider!==plan.provider||owned.environment!==plan.environment
    ||owned.subscriptionId!==(plan.provider==='stripe'?plan.stripe_subscription_id:plan.gocardless_subscription_id)
    ||owned.payerId!==(plan.provider==='stripe'?agreement.stripe_customer_id:agreement.gocardless_customer_id)){
    fail('Provider stop belongs to another purchase.');
   }
   const stopped=await provider.reconcile(a.providerPrepared);
   if(stopped.state!=='stopped')fail('Original provider collections have not been confirmed stopped.');
  }else{
   if(plan.provider!=='gocardless'||plan.metadata?.collection_mode!=='dynamic'
    ||plan.gocardless_subscription_id)fail('Missing provider stop authority.');
   const {data,error}=await db.from('membership_payment_plans').select('collection_stopped_at')
    .eq('tenant_id',record.tenant_id).eq('member_id',record.member_id).eq('id',plan.id).maybeSingle();
   if(error||!data?.collection_stopped_at)fail('Dynamic collections have not been stopped.');
  }
  const seen=new Set(),add=payment=>{
   if(!payment.id||seen.has(payment.id)||!minor(payment.amountMinor))fail('Duplicate or invalid provider receipt.');
   seen.add(payment.id);result.payments.push({...payment,settled:true});
  };
  if(plan.provider==='stripe'){
   const stripe=await getStripe(record.tenant_id,plan.environment);
   const payer=agreement.stripe_customer_id;
   if(payer!==plan.stripe_customer_id||plan.stripe_subscription_id!==agreement.stripe_subscription_id){
    fail('Original Stripe payer or subscription changed.');
   }
   const customer=await stripe.customers.retrieve(payer);
   if(customer.deleted||customer.metadata?.tenant_id!==record.tenant_id
    ||customer.metadata?.member_id!==record.member_id)fail('Original personal payer could not be verified.');
   const invoices=await allStripeInvoices(stripe,plan.stripe_subscription_id);
   const invoiceIds=new Set(),intentIds=new Set();
   for(const invoice of invoices){
    if(!invoice.id||invoiceIds.has(invoice.id)||ref(invoice.customer)!==payer
     ||ref(invoice.subscription||invoice.parent?.subscription_details?.subscription)!==plan.stripe_subscription_id
     ||invoice.currency?.toUpperCase()!==currency||invoice.livemode!==(plan.environment==='live')
     ||!minor(invoice.total)||!minor(invoice.amount_paid)||!minor(invoice.amount_remaining)
     ||invoice.lines?.has_more||invoice.lines?.data?.length!==1){
     fail('Foreign, duplicate or incomplete Stripe invoice evidence.');
    }
    invoiceIds.add(invoice.id);
    const line=invoice.lines.data[0];
    if(line.amount!==invoice.total||line.proration||line.parent?.subscription_item_details?.proration
     ||!Number.isInteger(line.period?.start)||!Number.isInteger(line.period?.end)
     ||line.period.start>=line.period.end||invoice.pre_payment_credit_notes_amount
     ||invoice.post_payment_credit_notes_amount||invoice.total_discount_amounts?.length){
     fail('Adjusted or non-membership Stripe amounts require reconciliation.');
    }
    const serviceStart=day(line.period.start),serviceEnd=day(line.period.end);
    if(serviceEnd<=source.term_start_date)continue;
    if(serviceStart>=source.membership_renewal_date){
     if(invoice.status!=='void')result.unresolved.push({id:invoice.id,status:invoice.status,reason:'future_term_collection'});
     continue;
    }
    if(serviceStart<source.term_start_date||serviceEnd>source.membership_renewal_date){
     fail('An invoice spans different purchased terms.');
    }
    if(invoice.status==='void'){
     if(invoice.amount_paid!==0)fail('Voided invoice has cash or returned-credit evidence.');
     continue;
    }
    if(invoice.status!=='paid'){
     result.unresolved.push({id:invoice.id,status:invoice.status,amountMinor:invoice.total,
      paidMinor:invoice.amount_paid,serviceStartDate:day(line.period.start)});
     continue;
    }
    if(!invoice.total||invoice.amount_paid!==invoice.total||invoice.amount_remaining!==0){
     fail('Zero, split or non-cash invoice funding requires its original funding ledger.');
    }
    const payments=await allStripeInvoicePayments(stripe,invoice.id);
    if(payments.length!==1||payments[0].amount_paid!==invoice.total
     ||payments[0].payment?.type!=='payment_intent')fail('Exactly attributed card funding is required.');
    const intentId=ref(payments[0].payment.payment_intent);
    if(!intentId||intentIds.has(intentId))fail('Duplicate or missing card payment identity.');
    intentIds.add(intentId);
    const intent=await stripe.paymentIntents.retrieve(intentId);
    const charge=ref(intent.latest_charge)?await stripe.charges.retrieve(ref(intent.latest_charge)):null;
    if(intent.id!==intentId||intent.status!=='succeeded'||intent.amount_received!==invoice.total
     ||ref(intent.customer)!==payer||intent.currency?.toUpperCase()!==currency
     ||intent.livemode!==invoice.livemode||!charge||!charge.paid||!charge.captured
     ||!charge.id||ref(intent.latest_charge)!==charge.id||!Number.isInteger(charge.created)
     ||charge.currency?.toUpperCase()!==currency||charge.amount!==invoice.total||charge.amount_refunded!==0||charge.disputed
     ||ref(charge.payment_intent)!==intentId||ref(charge.customer)!==payer||charge.livemode!==invoice.livemode){
     fail('Refunded, disputed, uncaptured or foreign card payment.');
    }
    add({id:invoice.id,paymentIntentId:intentId,chargeId:charge.id,date:day(line.period.start),
     serviceEndDate:day(line.period.end),paidAt:new Date(charge.created*1000).toISOString(),amountMinor:invoice.total});
   }
  }else if(plan.provider==='gocardless'){
   const gc=await getGc(record.tenant_id,plan.environment);
   if(gc.getGocardlessEnvironment()!==plan.environment)fail('GoCardless environment changed.');
   const mandate=await gc.getMandate(agreement.gocardless_mandate_id);
   if(mandate.id!==plan.gocardless_mandate_id||mandate.links?.customer!==agreement.gocardless_customer_id){
    fail('Original Direct Debit payer is unavailable.');
   }
   const dynamic=plan.metadata?.collection_mode==='dynamic',paymentIds=new Set();
   for(const payment of await allGoCardlessPayments(gc,mandate.id)){
    const owned=dynamic?payment.metadata?.plan_id===plan.id:
     payment.links?.subscription===plan.gocardless_subscription_id||payment.id===agreement.metadata?.gocardless_initial_payment?.id;
    if(!owned)continue;
    if(!payment.id||paymentIds.has(payment.id))fail('Duplicate or missing Direct Debit payment identity.');
    paymentIds.add(payment.id);
    if(payment.links?.mandate!==mandate.id||payment.currency!==currency
     ||!minor(payment.amount)||Number(payment.amount_refunded||0)!==0
     ||(payment.metadata?.tenant_id&&payment.metadata.tenant_id!==record.tenant_id)
     ||(payment.metadata?.member_id&&payment.metadata.member_id!==record.member_id)){
     fail('Foreign or refunded Direct Debit payment.');
    }
    amendmentDay(payment.charge_date);
    if(payment.charge_date<source.term_start_date)continue;
    if(payment.charge_date>=source.membership_renewal_date){
     if(!['failed','cancelled'].includes(payment.status)){
      result.unresolved.push({id:payment.id,status:payment.status,reason:'future_term_collection'});
     }
     continue;
    }
    if(['confirmed','paid_out'].includes(payment.status)){
     add({id:payment.id,date:payment.charge_date,amountMinor:payment.amount});
    }else if(['failed','cancelled'].includes(payment.status)){
     result.failed.push({id:payment.id,status:payment.status,date:payment.charge_date,amountMinor:payment.amount});
    }else{
     result.unresolved.push({id:payment.id,status:payment.status,date:payment.charge_date,amountMinor:payment.amount});
    }
   }
  }else fail('Unsupported original payment provider.');
  result.settledGrossMinor=result.payments.reduce((sum,p)=>sum+p.amountMinor,0);
  if(!minor(result.settledGrossMinor))fail('Receipt total exceeds exact minor-unit bounds.');
  return result;
 }
 return {read};
}
