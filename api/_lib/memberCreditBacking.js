const fail=message=>{throw Object.assign(new Error(message),{status:422,code:'credit_backing_evidence_required'});};
function minor(value){
  if(value===null||value===undefined||value===''||typeof value==='boolean')fail('Missing exact credit amount.');
  const n=Number(value)*100;
  if(!Number.isFinite(n)||!Number.isSafeInteger(Math.round(n))||Math.abs(n-Math.round(n))>1e-6)fail('Invalid credit amount.');
  return Math.round(n);
}
function binding(context){
  const b=context.memberCreditLiabilityBinding;
  if(b?.provider!=='xero'||b.kind!=='iconnect_member_credit_liability'
    ||b.providerTenantId!==context.xeroTenantId||b.currency!==context.currency
    ||!b.accountId||!b.accountCode||!Number.isSafeInteger(context.amounts?.grossMinor)
    ||context.amounts.grossMinor<=0||!context.reference)fail('Frozen member credit backing is required.');
  return b;
}
// Called only after the caller verifies the exact credit-note tax/revenue/
// payer contract. This adds the separate non-cash liability-transfer proof.
export async function inspectMemberCreditBacking({context,document,request}){
  const b=binding(context);
  if(!document?.CreditNoteID||document.Type!=='ACCRECCREDIT'
    ||!['AUTHORISED','PAID'].includes(document.Status)
    ||document.Contact?.ContactID!==context.contactId||document.CurrencyCode!==context.currency
    ||document.Reference!==context.reference||minor(document.Total)!==context.amounts.grossMinor
    ||!Array.isArray(document.Payments)||!Array.isArray(document.Allocations)
    ||document.Allocations.length)fail('Credit note is not an unallocated exact member-credit document.');
  const base={verified:true,provider:'xero',documentId:document.CreditNoteID,
    reference:context.reference,amounts:context.amounts,liabilityAccountId:b.accountId};
  if(minor(document.RemainingCredit)===context.amounts.grossMinor&&document.Payments.length===0){
    return {state:'awaiting_payment',evidence:{...base,kind:'awaiting_member_credit_backing'}};
  }
  if(minor(document.RemainingCredit)!==0||document.Payments.length!==1
    ||!document.Payments[0].PaymentID)fail('Partial, duplicate or ambiguous member-credit backing requires review.');
  const paymentId=document.Payments[0].PaymentID;
  const rows=(await request(`Payments/${encodeURIComponent(paymentId)}`))?.Payments;
  const p=rows?.[0];
  if(!Array.isArray(rows)||rows.length!==1||p.PaymentID!==paymentId||p.Status!=='AUTHORISED'
    ||p.CreditNote?.CreditNoteID!==document.CreditNoteID||p.Invoice||p.Prepayment||p.Overpayment
    ||p.Account?.AccountID!==b.accountId||p.Reference!==`${context.reference}:member-credit`
    ||minor(p.Amount)!==context.amounts.grossMinor
    ||(p.CurrencyRate!=null&&Number(p.CurrencyRate)!==1)){
    fail('The accounting entry does not exactly back this member credit.');
  }
  return {state:'settled',evidence:{...base,kind:'member_credit_backed',paymentId,retainedCreditMinor:0}};
}

export function memberCreditBackingPayload(context,creditNoteId){
  const b=binding(context);
  if(!creditNoteId||!/^\d{4}-\d{2}-\d{2}$/.test(context.issueDate||''))fail('Backing document and accounting date are required.');
  return {Payments:[{CreditNote:{CreditNoteID:creditNoteId},Account:{AccountID:b.accountId},
    Amount:context.amounts.grossMinor/100,Date:context.issueDate,Reference:`${context.reference}:member-credit`}]};
}

// A durable claim is consumed before the external write. Existing claims never
// authorize another write, including after process death or a lost response.
export async function executeMemberCreditBacking({db,tenantId,amendmentId,actorId,inspect,request}){
  const before=await inspect();
  if(before.state==='settled')return before;
  if(before.evidence?.kind!=='awaiting_member_credit_backing')fail('Credit note is not ready for backing.');
  const claim=await db.rpc('claim_member_credit_backing',{
    p_tenant_id:tenantId,p_amendment_id:amendmentId,p_actor_id:actorId,
    p_document_id:before.evidence.documentId,
  });
  if(claim.error)throw Object.assign(new Error('Member credit backing could not be reserved.'),{status:503,code:'credit_backing_reservation_failed'});
  if(claim.data?.claimed!==true)return inspect();
  // Only the immutable context returned by the claim can choose the account,
  // amount or reference; never use caller-supplied financial fields.
  const context=claim.data.context;
  const payload=memberCreditBackingPayload(context,claim.data.documentId);
  // Xero documents PUT for creating payments. No bank fallback and no
  // IsReconciled assertion: this is a liability entry, not a cash refund.
  await request('Payments',{method:'PUT',key:`${context.reference}:member-credit`,body:payload});
  return inspect();
}
