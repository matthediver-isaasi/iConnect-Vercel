import {createHash} from 'node:crypto';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {matchingStructures} from './bnms-dd-beta-review.mjs';
import {buildAgreementSnapshot} from '../api/_lib/gocardlessDirectDebit.js';
import {buildIdempotencyKey} from '../api/_lib/gocardless.js';
import {MANUAL_TENANT as TENANT,MANUAL_WORKBOOK,MANUAL_GATE,MANUAL_RECOGNITION_FROM} from '../api/_lib/bnmsManualCohort.js';
export const SCOPE_SHA='b3c63bee0485ba106b0df6c2339821a48dcf4b6d4f0cc2066268a0237978c7f4';
export const MIGRATION='supabase/migrations/20261121_bnms_dd_manual_95.sql';
export const INVOICE_MIGRATION='supabase/migrations/20261122_bnms_manual_invoice_operations.sql';
const norm=v=>String(v||'').trim().toLowerCase();
const fail=m=>{throw Error(m);};
export const stableId=(type,id)=>{
 const h=createHash('sha256').update(`bnms-manual-95:${MANUAL_WORKBOOK}:${type}:${id}`).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
export const scopeHash=members=>createHash('sha256').update(members.map(m=>
 `${m.memberId}|${m.customerId}|${m.mandateId}`).sort().join('\n')).digest('hex');

export function prepareManualManifest({sheet,snapshot:s,provider,xero,cachedAccounting=null,now=new Date()}){
 if(sheet.sha256!==MANUAL_WORKBOOK||sheet.rows.length!==109||new Set(sheet.rows.map(r=>r.memberId)).size!==105)fail('Exact workbook scope required');
 if(provider.requests>20||!provider.discovery||!provider.completedAt)fail('Complete bounded GoCardless evidence required');
 const p=provider.discovery, members=[],noOps=[],blockers=[];
 const bank=xero.accounts?.find(a=>a.AccountID==='d115eacc-1fa7-476d-844e-d3d7f07f5db5');
 if(!xero.complete||!xero.bankVerified||bank?.Status!=='ACTIVE'||bank?.Type!=='BANK'||bank?.CurrencyCode!=='GBP')blockers.push('CURRENT_XERO_CONTACT_ACCOUNT_DISCOVERY_INCOMPLETE');
 for(const memberId of [...new Set(sheet.rows.map(r=>r.memberId))].sort()){
  const rows=sheet.rows.filter(r=>r.memberId===memberId),customers=[...new Set(rows.map(r=>r.customerId))];
  if(customers.length!==1)fail('Workbook customer mapping ambiguous');
  const customerId=customers[0],adopted=s.bnms_dd_alpha_adoption.filter(a=>a.member_id===memberId||a.customer_id===customerId);
  if(adopted.length){
   if(adopted.length!==1||adopted[0].member_id!==memberId||adopted[0].customer_id!==customerId)fail('Existing Alpha ownership collision');
   noOps.push({memberId,customerId,adoptionId:adopted[0].id});continue;
  }
  const owner=s.members.find(m=>m.id===memberId&&m.tenant_id===TENANT);
  if(!owner||owner.membership_paused||owner.status!=='active')fail('Current member ownership/status conflict');
  const customer=p.customers.find(c=>c.id===customerId);
  const mandates=p.mandates.filter(m=>m.links?.customer===customerId&&m.status==='active');
  if(!customer||mandates.length!==1||mandates[0].links?.creditor!=='CR0000B50W1Y2R'||mandates[0].scheme!=='bacs'||!mandates[0].links?.customer_bank_account)fail('Unique pinned active BACS mandate required');
  const mandate=mandates[0],mandateId=mandate.id;
  if(['agreements','plans','history'].some(k=>s[k].some(r=>r.member_id===memberId||r.gocardless_mandate_id===mandateId||r.gocardless_customer_id===customerId)))fail('New canonical identity already exists');
  if(s.beta.some(r=>r.member_id===memberId||r.customer_id===customerId)||s.bnms_dd_pilot_adoption.some(r=>r.member_id===memberId||r.customer_id===customerId))fail('Prior cohort collision');
  const payments=p.payments.filter(r=>r.links?.mandate===mandateId);
  if(payments.some(r=>['pending_submission','submitted'].includes(r.status)||r.charge_date>='2026-10-01')
    ||p.subscriptions.some(r=>r.links?.mandate===mandateId&&!['cancelled','finished'].includes(r.status)))fail('Future/pending provider collection collision');
  // September confirmed INV-8904 remains private historical evidence; never import/retry/settle it.
  const preferences=s.preferences.filter(r=>r.member_id===memberId);
  const structures=matchingStructures(s.structures,preferences.filter(r=>r.name==='member_class'),'2026-10-01');
  if(structures.length!==1)fail('Applicable monthly pricing scope not unique');
  const structure=structures[0],monthlyQuoteMinor=Math.round(Number(structure.dd_monthly_amount)*100);
  if(structure.currency!=='GBP'||structure.pricing_model!=='flat'||structure.start_mode!=='immediate'
    ||structure.dd_invoicing_mode!=='per_instalment'||!Number.isSafeInteger(monthlyQuoteMinor)||monthlyQuoteMinor<=0
    ||!structure.dd_terms_version)fail('Unsupported price/terms scope');
  let revenueCode=structure.nominal_code,revenueEvidence=null;
  // Existing private invoices only; no retrieval or financial-state validation.
  // Associate has no configured nominal. All three retained Associate series
  // explicitly use 202; preserve the purchased config and record this provenance.
  if(!revenueCode&&structure.structure_match_value==='Associate'&&cachedAccounting){
   const allowedEmails=[norm(owner.email),norm(customer.email)].filter(Boolean);
   const oldContacts=cachedAccounting.contacts.filter(c=>allowedEmails.includes(norm(c.EmailAddress)));
   if(oldContacts.length===1){
    const invoices=cachedAccounting.invoices.filter(i=>i.Contact?.ContactID===oldContacts[0].ContactID);
    const membershipLines=invoices.flatMap(i=>(i.LineItems||[]).filter(l=>/\b(membership|associate)\b/i.test(l.Description||''))
     .map(l=>({invoiceId:i.InvoiceID,accountCode:l.AccountCode})));
    if(membershipLines.length&&membershipLines.every(l=>l.accountCode==='202')){
     revenueCode='202';revenueEvidence={source:'cached_original_explicit_associate_nominal',code:'202',
      contactId:oldContacts[0].ContactID,class:'Associate',cachedAccountingSha256:hash(cachedAccounting),membershipLines,
      invoiceFreshness:'explicit_user_waived_no_invoice_retrieval',historicalAmountsNotUsed:true};
    }
   }
  }
  if(!/^\d+$/.test(revenueCode||''))blockers.push(`REVENUE_CODE_MISSING:${memberId}`);
  if(xero.complete&&(xero.accounts||[]).filter(a=>a.Code===revenueCode&&a.Status==='ACTIVE'&&a.Type==='REVENUE').length!==1)
   blockers.push(`REVENUE_ACCOUNT_UNVERIFIED:${memberId}`);
  const binding=xero.bindings?.find(b=>b.memberId===memberId);
  let bindingEvidence=null;
  if(binding?.status==='bound'&&binding.provenance?.kind==='exact_existing_provider_payment_reference'){
   const proof=binding.provenance;
   if(!cachedAccounting||proof.cachedAccountingSha256!==hash(cachedAccounting)||!proof.links?.length)fail('Pinned cached contact identity proof missing');
   for(const link of proof.links){
    const pay=payments.find(v=>v.id===link.providerPaymentId);
    const inv=cachedAccounting.invoices.find(v=>v.InvoiceID===link.cachedInvoiceId);
    if(!pay||pay.status!=='paid_out'||pay.amount_refunded||!inv
      ||inv.Contact?.ContactID!==binding.contactId||link.contactId!==binding.contactId
      ||inv.InvoiceNumber!==pay.metadata?.['Invoice number']||inv.CurrencyCode!==pay.currency
      ||!inv.Payments?.some(v=>v.Reference===pay.id&&v.PaymentID===link.xeroPaymentId&&Math.round(Number(v.Amount)*100)===pay.amount))
     fail('Cached exact payment/contact identity proof changed');
   }
   bindingEvidence=proof;
  }
  const contacts=(xero.contacts||[]).filter(c=>c.ContactStatus==='ACTIVE'
    &&(bindingEvidence?c.ContactID===binding.contactId:[norm(owner.email),norm(customer.email)].filter(Boolean).includes(norm(c.EmailAddress))));
  const unique=[...new Map(contacts.map(c=>[c.ContactID,c])).values()];
  if(unique.length!==1)blockers.push(`CONTACT_${!xero.complete?'UNOBSERVED':unique.length?'AMBIGUOUS':'MISSING'}:${memberId}`);
  const contact=unique.length===1?unique[0]:null;
  if(binding&&(!contact||binding.status!=='bound'||binding.contactId!==contact.ContactID
   ||binding.contactEmail!==norm(contact.EmailAddress)))blockers.push(`CURRENT_CONTACT_BINDING_CHANGED:${memberId}`);
  if(contact&&revenueEvidence&&contact.ContactID!==revenueEvidence.contactId)blockers.push(`REVENUE_CONTACT_BINDING_CHANGED:${memberId}`);
  const dd=buildAgreementSnapshot({acceptedAt:null,billingRequestMode:'migration_existing_mandate',
   offer:{collectionPolicy:{version:1,end_policy:'continue',pricing_policy:'dynamic'},monthlyAmount:monthlyQuoteMinor/100,
    monthlyAmountMinor:monthlyQuoteMinor,instalmentCount:12,planTotal:null,currency:'GBP',firstCollectionRule:'nominated_day',
    collectionDay:1,activationRule:'first_payment',graceDays:structure.dd_grace_days,termsVersion:structure.dd_terms_version,
    invoicingMode:'per_instalment',monthlyPostGraceCollectionPolicy:structure.monthly_post_grace_collection_policy},
   simResult:{config:structure,membershipYear:{start:'2026-10-01',end:'2027-09-30',label:'rolling:2026-10-01'},
    annualCost:Number(structure.flat_cost),finalCost:null,vatRatePercent:0,tierLabel:'Flat Rate'}});
  members.push({memberId,customerId,mandateId,sourceRows:rows.map(r=>r.row),owner,customer,mandate,preferences,structure,monthlyQuoteMinor,dd,revenueCode,revenueEvidence,
   ids:Object.fromEntries(['adoption','agreement','plan','history','release'].map(k=>[k,stableId(k,memberId)])),
   accounting:contact?{contactId:contact.ContactID,contactEmail:norm(contact.EmailAddress),
    xeroTenantId:'3d57dce6-2205-462f-abf6-9c7cbf00be23',bankAccountId:bank?.AccountID,revenueCode,revenueEvidence,
    bindingEvidence:bindingEvidence||{kind:'unique_current_member_or_attested_gc_email'},
    contactEvidence:contact,bankEvidence:bank}:null});
 }
 if(members.length!==95||noOps.length!==10||scopeHash(members)!==SCOPE_SHA)fail('Exact separate 95/10 scope mismatch');
 if(members.reduce((n,m)=>n+m.monthlyQuoteMinor,0)!==87174)fail('Approved £871.74 monthly economics changed');
 for(const m of members)if(m.accounting&&members.some(o=>o.memberId!==m.memberId&&o.accounting?.contactId===m.accounting.contactId))blockers.push(`CONTACT_CROSS_OWNER:${m.memberId}`);
 if(s.membership_tier_vat_override?.length)blockers.push('VAT_OVERRIDES_REQUIRE_EXPLICIT_REVIEW');
 return {version:1,tenantId:TENANT,workbookSha256:MANUAL_WORKBOOK,scopeSha256:SCOPE_SHA,preparedAt:now.toISOString(),
  providerObservedAt:provider.observedAt,providerCompletedAt:provider.completedAt,providerSha256:hash(provider),xeroSha256:hash(xero),
  xeroObservedAt:xero.observedAt,xeroCompletedAt:xero.completedAt||null,
  approval:{kind:'explicit_operator_existing_mandate_migration',acceptedAt:null,monthlyTotalMinor:87174,currency:'GBP',
   legacyCollectorHandover:'user_confirmed_all_95_disabled_no_other_collections',recognitionFrom:MANUAL_RECOGNITION_FROM,
   recognitionUntil:'2027-10-01',termStart:'2026-10-01',termEnd:'2027-09-30',
   processingNotBefore:MANUAL_GATE,invoicePreflight:'explicit_user_no_invoice_retrieval',prior260Unchanged:true},
  members,noOps,blockers:[...new Set(blockers)]};
}

export function assertExecutableManifest(manifest,now=new Date()){
 if(manifest.blockers.length)fail('Manual cohort has unresolved contact/accounting blockers');
 if(manifest.members.length!==95||manifest.noOps.length!==10||scopeHash(manifest.members)!==SCOPE_SHA
  ||manifest.workbookSha256!==MANUAL_WORKBOOK||manifest.tenantId!==TENANT
  ||manifest.members.reduce((n,m)=>n+m.monthlyQuoteMinor,0)!==87174)fail('Manual manifest scope/economics mismatch');
 for(const timestamp of [manifest.providerObservedAt,manifest.providerCompletedAt,manifest.xeroObservedAt,manifest.xeroCompletedAt]){
  const age=now.getTime()-Date.parse(timestamp);
  if(!Number.isFinite(age)||age<0||age>15*60*1000)fail('Fresh GET evidence required before release; no timestamps may be renewed');
 }
 if(manifest.approval.processingNotBefore!==MANUAL_GATE||manifest.approval.recognitionFrom!==MANUAL_RECOGNITION_FROM
  ||manifest.approval.recognitionUntil!=='2027-10-01'||manifest.approval.acceptedAt!==null)fail('Approved recognition/authority drift');
}

export function assertFreshManualProvider(manifest,provider){
 if(!provider.completedAt||provider.requests>20)fail('Complete bounded provider snapshot required');
 const p=provider.discovery;
 for(const m of manifest.members){
  const customer=p.customers.find(c=>c.id===m.customerId);
  const active=p.mandates.filter(r=>r.links?.customer===m.customerId&&r.status==='active');
  if(!customer||norm(customer.email)!==norm(m.customer.email)||active.length!==1||active[0].id!==m.mandateId
   ||active[0].links?.creditor!=='CR0000B50W1Y2R'||active[0].scheme!=='bacs'
   ||active[0].links?.customer_bank_account!==m.mandate.links?.customer_bank_account)fail('Fresh provider identity/mandate drift');
  if(p.payments.some(r=>r.links?.mandate===m.mandateId
    &&(['pending_submission','submitted'].includes(r.status)||r.charge_date>='2026-10-01'))
   ||p.subscriptions.some(r=>r.links?.mandate===m.mandateId&&!['cancelled','finished'].includes(r.status)))fail('Fresh future collection collision');
 }
}

export function canonicalRows(m,manifestSha256){
 const term=m.dd.commitment;
 return {
  membership_billing_agreements:{...term,id:m.ids.agreement,tenant_id:TENANT,member_id:m.memberId,
   agreement_type:'member',provider:'gocardless',gocardless_customer_id:m.customerId,gocardless_mandate_id:m.mandateId,
   status:'first_payment_pending',environment:'live',needs_attention:false,
   idempotency_key:buildIdempotencyKey('bnms-manual-adoption',TENANT,m.memberId,'2026-10-01'),
   metadata:{dd:m.dd,commitment:term,bnms_manual_cohort:MANUAL_WORKBOOK}},
  membership_payment_plans:{id:m.ids.plan,tenant_id:TENANT,member_id:m.memberId,billing_agreement_id:m.ids.agreement,
   provider:'gocardless',gocardless_mandate_id:m.mandateId,amount_minor:m.monthlyQuoteMinor,currency:'GBP',interval_unit:'monthly',
   day_of_month:1,status:'first_payment_pending',membership_year:m.dd.membership_year,start_date:'2026-10-01',
   instalments_total:12,environment:'live',dynamic_next_collection_date:'2026-10-01',dynamic_next_check_at:MANUAL_GATE,
   collection_stopped_at:null,idempotency_key:buildIdempotencyKey('dd-dynamic-plan',TENANT,m.ids.agreement,term.term_key),
   metadata:{collection_mode:'dynamic',dynamic_first_date:'2026-10-01',agreement_id:m.ids.agreement,bnms_manual_cohort:MANUAL_WORKBOOK}},
  member_membership_history:{...term,id:m.ids.history,tenant_id:TENANT,member_id:m.memberId,membership_year:m.dd.membership_year,
   config_id:m.structure.id,tier_label:'Flat Rate',currency:'GBP',annual_cost:term.commitment_snapshot.amounts.annual_cost,
   final_cost:null,vat_amount:null,total_with_vat:null,billing_period:'monthly_direct_debit',payment_method:'direct_debit',
   status:'pending_payment_setup',payment_status:'unpaid',billing_agreement_id:m.ids.agreement,
   notes:'Operator-recognized existing membership; recognition is not payment settlement or historical joining-date evidence.'},
  bnms_dd_manual_adoption:{id:m.ids.adoption,tenant_id:TENANT,member_id:m.memberId,agreement_id:m.ids.agreement,
   plan_id:m.ids.plan,history_id:m.ids.history,customer_id:m.customerId,mandate_id:m.mandateId,
   workbook_sha256:MANUAL_WORKBOOK,manifest_sha256:manifestSha256,evidence_sha256:hash(m),evidence:m},
  bnms_dd_manual_release:{id:m.ids.release,tenant_id:TENANT,member_id:m.memberId,adoption_id:m.ids.adoption,
   plan_id:m.ids.plan,manifest_sha256:manifestSha256,processing_not_before:MANUAL_GATE},
 };
}