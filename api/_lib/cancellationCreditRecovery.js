import crypto from 'node:crypto';
import { resolveAccountingQueueBinding } from './accountingQueueIntegration.js';
import { persistBookingCreditEvidence, currencyFactor } from './bookingCreditEvidence.js';

const TABLE = 'cancellation_credit_operation';
const checked = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
export async function createRecoverableCancellationCredit(context, provider, args) {
  if (provider.name !== 'xero') return provider.createCreditNote(args);
  const row=await enqueueCancellationCredit({...context,args});
  const {executeCancellationCredit}=await import('./xeroCancellationRecovery.js');
  const outcome=await processCancellationCredit({db:context.db,row,execute:r=>executeCancellationCredit(context.db,r)});
  if(outcome.state!=='complete')throw new Error(creditRecoveryMessage(outcome));
  return {...outcome.result,provider:'xero'};
}
export function creditRecoveryMessage(row) {
  if (row.state === 'complete') return row.result?.allocated
    ? 'Credit note created and applied to the invoice.'
    : 'Credit note created. Allocation needs accounting review.';
  if (row.state === 'retry') return 'Xero is temporarily unavailable. Credit-note recovery is queued.';
  if (row.state === 'pending') return 'Credit-note recovery is queued. Cancellation remains approved.';
  if (row.state === 'processing') return 'Credit-note recovery is in progress.';
  return 'Credit note needs accounting review. Do not create another credit note until checked.';
}

export async function enqueueCancellationCredit({ db, tenantId, source, bookings, operationKey, args, email }) {
  if (!['booking','complex_event_booking'].includes(source) || !bookings?.length
    || !args.reference || !Number.isFinite(Number(args.creditAmount)) || Number(args.creditAmount) <= 0) {
    throw new Error('Invalid cancellation credit intent');
  }
  const binding=await resolveAccountingQueueBinding({db,tenantId,provider:'xero'});
  checked(await db.from(TABLE).upsert({
    tenant_id: tenantId, operation_key: operationKey, booking_source: source,
    booking_ids: [...new Set(bookings.map(b => b.id))].sort(), invoice_id: args.invoiceId,
    company_id:binding.companyId,amount: Number(args.creditAmount), description: args.description, reference: args.reference,
    email_requested: email || null,
  }, { onConflict: 'tenant_id,operation_key', ignoreDuplicates: true }));
  const row = checked(await db.from(TABLE).select('*').eq('tenant_id',tenantId).eq('operation_key',operationKey).single());
  if (row.company_id !== binding.companyId || row.invoice_id !== args.invoiceId || Number(row.amount) !== Number(args.creditAmount)
    || row.reference !== args.reference || row.booking_source !== source
    || JSON.stringify(row.booking_ids) !== JSON.stringify([...new Set(bookings.map(b=>b.id))].sort())) {
    throw new Error('Saved credit intent differs; accounting review required');
  }
  return row;
}

export async function processCancellationCredit({ db, row, execute, now = () => new Date() }) {
  if (row.state === 'complete') return row;
  if (!['pending','retry'].includes(row.state) || new Date(row.next_attempt_at) > now()) return row;
  const token = crypto.randomUUID();
  const claimed = checked(await db.from(TABLE).update({
    state:'processing', lease_token:token, lease_until:new Date(+now()+180000).toISOString(),
    attempts:row.attempts+1, updated_at:now().toISOString(),
  }).eq('id',row.id).eq('tenant_id',row.tenant_id).eq('state',row.state)
    .eq('updated_at',row.updated_at).select('*'));
  if (!claimed.length) return row;
  row=claimed[0];
  let patch;
  try {
    const bookings = checked(await db.from(row.booking_source).select('id,tenant_id,xero_invoice_id,accounting_invoice_id,booking_group_reference')
      .eq('tenant_id',row.tenant_id).in('id',row.booking_ids));
    if (bookings.length!==row.booking_ids.length || bookings.some(b=>(b.accounting_invoice_id||b.xero_invoice_id)!==row.invoice_id)) {
      throw new Error('Booking invoice association changed');
    }
    const result = row.result || await execute(row);
    if (!result?.creditNoteId || !result.currency || !Number.isFinite(Number(result.amount))) {
      throw new Error('Credit-note result requires review');
    }
    // Retain provider identity before any local linkage can fail.
    checked(await db.from(TABLE).update({result}).eq('id',row.id).eq('lease_token',token));
    checked(await db.from(row.booking_source).update({
      xero_credit_note_id:result.creditNoteId, xero_credit_note_number:result.creditNoteNumber,
    }).eq('tenant_id',row.tenant_id).in('id',row.booking_ids));
    await persistBookingCreditEvidence({
      db, tenantId:row.tenant_id, source:row.booking_source, operationKey:row.operation_key, bookings,
      leg:'credit_note',provider:'xero',providerId:result.creditNoteId,amountMinor:Math.round(Number(result.amount)*currencyFactor(result.currency)),
      currency:result.currency,status:'confirmed',paymentReference:row.invoice_id,
      detail:{providerStatus:result.status,allocated:result.allocated, recovery:true},
    });
    patch={state:'complete',result,last_error:null};
  } catch(error) {
    const retry=error.safeRetry===true;
    patch={state:retry?'retry':'review',last_error:error.message.slice(0,1000),
      next_attempt_at:new Date(+now()+Math.max(60,error.retryAfter||300)*1000).toISOString()};
  }
  return checked(await db.from(TABLE).update({...patch,lease_token:null,lease_until:null,updated_at:now().toISOString()})
    .eq('id',row.id).eq('tenant_id',row.tenant_id).eq('lease_token',token).select('*').single());
}

export async function recoverCancellationCredits(db, execute) {
  // An interrupted worker is uncertain, never a licence to repeat a write.
  checked(await db.from(TABLE).update({state:'review',last_error:'Interrupted credit-note operation requires provider verification.'})
    .eq('state','processing').lt('lease_until',new Date().toISOString()));
  const rows=checked(await db.from(TABLE).select('*').in('state',['pending','retry'])
    .lte('next_attempt_at',new Date().toISOString()).order('next_attempt_at').limit(10));
  const results=[]; const deadline=Date.now()+40000;
  for(const row of rows){if(Date.now()>deadline)break; const result=await processCancellationCredit({db,row,execute});results.push({id:result.id,state:result.state});}
  return results;
}

export async function cancellationCreditStatus(db,tenantId,requests) {
  if(!requests.length)return requests;
  const ids=[...new Set(requests.map(r=>r.booking_id).filter(Boolean))];
  const {data:operations,error}=await db.from(TABLE).select('*').eq('tenant_id',tenantId).overlaps('booking_ids',ids);
  const evidence=checked(await db.from('booking_reversal_evidence').select('booking_source,booking_ids,status,provider_id,detail,updated_at')
    .eq('tenant_id',tenantId).eq('leg','credit_note').overlaps('booking_ids',ids));
  return requests.map(request=>{
    if(error)return {...request,credit_note_recovery:null};
    const rows=operations.filter(o=>o.booking_source===(request.booking_source||'booking') && o.booking_ids.includes(request.booking_id));
    const old=evidence.filter(e=>e.booking_source===(request.booking_source||'booking') && e.booking_ids.includes(request.booking_id));
    return {...request,credit_note_recovery:rows.length?rows.map(o=>({
      state:o.state,message:creditRecoveryMessage(o)+(o.email_requested&&o.state==='complete'?' Email delivery should be checked separately.':''),
      next_attempt_at:['pending','retry'].includes(o.state)?o.next_attempt_at:null,
      credit_note_number:o.result?.creditNoteNumber||null,updated_at:o.updated_at,
    })):old.map(e=>({state:e.status==='confirmed'?'complete':'review',
      message:e.status==='confirmed'?'Credit note recorded.': /429/.test(e.detail?.error||'')
        ?'Xero rate limit prevented the credit note. Accounting recovery is required.'
        :'Credit note needs accounting review. Cancellation remains approved.',
      next_attempt_at:null,credit_note_number:null,updated_at:e.updated_at}))};
  });
}
