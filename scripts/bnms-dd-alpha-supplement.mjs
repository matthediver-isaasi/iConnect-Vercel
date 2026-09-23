// Task 4628: pure, review-only preparation for a separately versioned alpha
// supplement. There is intentionally no filesystem, connector, SQL or apply path.
import { createHash } from 'node:crypto';
import {
  XERO_TENANT_ID,assertHistoricalInvoicesComplete,hash,reconcileHistoricalInvoices,
} from './bnms-dd-beta-invoices.mjs';
import { TENANT_ID } from './bnms-dd-pilot.mjs';

export const SUPPLEMENT_VERSION=2;
export const SUPPLEMENT_GRID_SHA256='74449a23785dd738fc91be696c030e062c2322d09e7afa2c8dfe690889fb98d8';
export const ORIGINAL_ALPHA_MANIFEST_SHA256='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a';
export const ORIGINAL_ALPHA_MEMBER_COUNT=249;
export const ORIGINAL_ALPHA_LINK_COUNT=2137;
export const EVIDENCE_MAX_AGE_MS=15*60*1000;
export const TERM_START='2026-10-01',TERM_END='2027-09-30';

const fail=message=>{throw Error(message);};
const norm=value=>String(value??'').trim().toLowerCase();
const stableId=(kind,value)=>{
  const digest=createHash('sha256').update(`bnms-alpha-supplement-v2:${kind}:${value}`).digest('hex');
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
};
const duplicates=(rows,key)=>new Set(rows.map(row=>row[key])).size!==rows.length;
const genericInvoiceConflict=exception=>exception.reasons?.length===1
  &&exception.reasons[0]==='INVOICE_RECONCILIATION: Invoice financial/period evidence conflict';

function gridMapping(grid,expectedHash){
  if(!Array.isArray(grid)||grid.length!==21||grid.some(row=>!Array.isArray(row)||row.length!==3
    ||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row[0])
    ||!norm(row[1])||!/^MD[A-Z0-9]+$/.test(row[2]))
    ||duplicates(grid.map(([memberId,email,mandateId])=>({memberId,email:norm(email),mandateId})),'memberId')
    ||duplicates(grid.map(([memberId,email,mandateId])=>({memberId,email:norm(email),mandateId})),'email')
    ||duplicates(grid.map(([memberId,email,mandateId])=>({memberId,email:norm(email),mandateId})),'mandateId')
    ||hash(grid)!==expectedHash)fail('Pinned 21-row supplemental grid hash/shape mismatch');
  return grid.map(([memberId,email,mandateId],index)=>({sourceRow:index+1,memberId,email:norm(email),mandateId}));
}

function originalScope(originalManifest,expectedHash,mapping){
  if(hash(originalManifest)!==expectedHash||originalManifest?.members?.length!==ORIGINAL_ALPHA_MEMBER_COUNT)
    fail('Actual original 249-member alpha manifest hash changed');
  const history=originalManifest.members.flatMap(member=>member.history||[]);
  const links=originalManifest.members.flatMap(member=>member.links||[]);
  if(links.length!==ORIGINAL_ALPHA_LINK_COUNT)fail('Actual original 2137-link alpha coverage changed');
  assertHistoricalInvoicesComplete(history,links);
  const conflicts=(originalManifest.exceptions||[]).filter(genericInvoiceConflict);
  if(conflicts.length!==mapping.length||mapping.some(row=>conflicts.filter(exception=>
    exception.identity?.memberId===row.memberId&&exception.mandateId===row.mandateId).length!==1))
    fail('Supplemental grid does not exactly match original generic invoice-conflict exceptions');
  const scope={
    memberIds:new Set(),mandateIds:new Set(),customerIds:new Set(),
    paymentIds:new Set(),invoiceIds:new Set(),
  };
  for(const member of originalManifest.members){
    if(member.identity?.memberId)scope.memberIds.add(member.identity.memberId);
    if(member.identity?.mandateId)scope.mandateIds.add(member.identity.mandateId);
    if(member.identity?.customerId)scope.customerIds.add(member.identity.customerId);
    for(const row of member.history||[])if(row.provider_payment_id)scope.paymentIds.add(row.provider_payment_id);
    for(const link of member.links||[])if(link.xero_invoice_id)scope.invoiceIds.add(link.xero_invoice_id);
  }
  return scope;
}

function externalScope(scope,name){
  if(scope?.complete!==true)fail(`Complete ${name} collision scope required`);
  const result={};
  for(const key of ['memberIds','mandateIds','customerIds','paymentIds','invoiceIds']){
    if(!Array.isArray(scope[key])||new Set(scope[key]).size!==scope[key].length)
      fail(`Complete unique ${name} ${key} scope required`);
    result[key]=new Set(scope[key]);
  }
  return result;
}

function assertEvidence(evidence,now){
  if(evidence?.tenantId!==TENANT_ID||evidence.xeroTenantId!==XERO_TENANT_ID)
    fail('Pinned supplemental tenants required');
  if(evidence.completeAccountDiscovery!==true||evidence.provider?.complete!==true
    ||evidence.accounting?.complete!==true||evidence.rateLimited!==false)
    fail('Incomplete or rate limited supplemental evidence');
  const timestamps=[evidence.observedAt,evidence.provider.observedAt,evidence.accounting.observedAt];
  const clock=Date.parse(now);
  if(!Number.isFinite(clock)||timestamps.some(value=>{
    const time=Date.parse(value);return !Number.isFinite(time)||time>clock||clock-time>EVIDENCE_MAX_AGE_MS;
  }))fail('Fresh complete supplemental timestamps within 15 minutes required');
  for(const [rows,key,label] of [
    [evidence.members,'id','member'],[evidence.provider.mandates,'id','mandate'],
    [evidence.provider.customers,'id','customer'],[evidence.provider.payments,'id','payment'],
    [evidence.provider.subscriptions,'id','subscription'],
    [evidence.accounting.invoices,'InvoiceID','invoice'],
    [evidence.accounting.contacts,'ContactID','contact'],
  ])if(!Array.isArray(rows)||rows.some(row=>!row?.[key])||duplicates(rows,key))
    fail(`Duplicate, missing, or incomplete supplemental ${label} identity`);
  const xeroPayments=evidence.accounting.invoices.flatMap(invoice=>invoice.Payments||[]);
  if(xeroPayments.some(payment=>!payment.PaymentID)||duplicates(xeroPayments,'PaymentID'))
    fail('Duplicate or missing supplemental accounting payment identity');
}

function collides(scopes,key,value){
  return scopes.find(([,scope])=>scope[key].has(value))?.[0];
}

function coreBuild(input,{now,pins}){
  const mapping=gridMapping(input?.grid,pins.gridSha256);
  const original=originalScope(input.originalManifest,pins.originalManifestSha256,mapping);
  assertEvidence(input.evidence,now);
  const scopes=[['original',original],['pilot',externalScope(input.scopes?.pilot,'pilot')],
    ['beta',externalScope(input.scopes?.beta,'beta')]];
  const {evidence}=input,members=[],blocked=[];
  for(const row of mapping){
    const member=evidence.members.filter(value=>value.id===row.memberId&&norm(value.email)===row.email);
    const mandate=evidence.provider.mandates.filter(value=>value.id===row.mandateId);
    if(member.length!==1||mandate.length!==1)fail(`Exact private-grid mapping mismatch at row ${row.sourceRow}`);
    const customer=evidence.provider.customers.filter(value=>value.id===mandate[0].links?.customer);
    if(customer.length!==1||norm(customer[0].email)!==row.email||mandate[0].links?.creditor!=='CR0000B50W1Y2R')
      fail(`Exact provider ownership mismatch at row ${row.sourceRow}`);
    const owner={member:member[0],mandate:mandate[0],customer:customer[0]};
    for(const [key,value] of [['memberIds',row.memberId],['mandateIds',row.mandateId],['customerIds',owner.customer.id]]){
      const scope=collides(scopes,key,value);if(scope)fail(`Supplemental ${key} collision with ${scope} scope`);
    }
    const payments=evidence.provider.payments.filter(value=>value.links?.mandate===row.mandateId);
    const subscriptions=evidence.provider.subscriptions.filter(value=>value.links?.mandate===row.mandateId);
    const reasons=[];
    if(owner.member.tenant_id!==TENANT_ID||owner.member.status!=='active'||owner.member.membership_paused
      ||owner.member.is_deleted||owner.member.deleted_at)reasons.push('MEMBER_STATE_NOT_ACTIVE');
    if(!owner.member.classification||owner.member.pricing?.complete!==true
      ||owner.member.pricing.mode!=='dynamic'||owner.member.pricing.effectiveOn!==TERM_START)
      reasons.push('CLASSIFICATION_OR_DYNAMIC_PRICING_INCOMPLETE');
    if(owner.mandate.status!=='active')reasons.push('MANDATE_NOT_ACTIVE');
    if(subscriptions.length)reasons.push('PROVIDER_SUBSCRIPTION_REQUIRES_HANDOVER');
    if(payments.some(payment=>['pending_submission','submitted','confirmed'].includes(payment.status)
      ||payment.charge_date>=TERM_START))reasons.push('PENDING_OR_FUTURE_PAYMENT_REQUIRES_REVIEW');
    const historical=payments.filter(payment=>payment.status==='paid_out'&&payment.charge_date<TERM_START);
    if(!historical.length)reasons.push('NO_SETTLED_HISTORY_FOR_STRONG_RECONCILIATION');
    if(reasons.length){blocked.push({...row,customerId:owner.customer.id,reasons});continue;}
    const history=historical.map(payment=>({
      id:stableId('payment',payment.id),tenant_id:TENANT_ID,member_id:row.memberId,
      mandate_id:row.mandateId,customer_id:owner.customer.id,email:owner.member.email,
      provider_payment_id:payment.id,charge_date:payment.charge_date,amount_minor:payment.amount,
      currency:payment.currency,evidence:payment,
    }));
    let links;
    try{
      links=reconcileHistoricalInvoices({tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,rows:history,
        provider:[{mandate:owner.mandate,customer:owner.customer,payments:historical}],
        invoices:evidence.accounting.invoices,contacts:evidence.accounting.contacts});
      assertHistoricalInvoicesComplete(history,links);
    }catch(error){
      blocked.push({...row,customerId:owner.customer.id,reasons:[`HISTORICAL_RECONCILIATION: ${error.message}`]});
      continue;
    }
    for(const link of links)for(const [key,value] of [
      ['paymentIds',link.provider_payment_id],['invoiceIds',link.xero_invoice_id],
    ]){const scope=collides(scopes,key,value);if(scope)fail(`Supplemental ${key} collision with ${scope} scope`);}
    members.push({...row,customerId:owner.customer.id,...owner,history,links,
      financiallyReconciled:true,adoptionReady:false});
  }
  const allHistory=members.flatMap(member=>member.history),allLinks=members.flatMap(member=>member.links);
  if(members.length)assertHistoricalInvoicesComplete(allHistory,allLinks);
  for(const key of ['memberId','mandateId','customerId'])if(duplicates(members,key))
    fail(`Duplicate supplemental ${key}`);
  for(const key of ['provider_payment_id','xero_invoice_id'])
    if(duplicates(key==='provider_payment_id'?allHistory:allLinks,key))fail(`Duplicate supplemental ${key}`);
  for(const link of allLinks)if(allLinks.some(other=>other.member_id!==link.member_id
    &&other.xero_contact_id===link.xero_contact_id))fail('Supplemental cross-member Xero contact collision');
  return {
    version:SUPPLEMENT_VERSION,kind:'bnms_dd_alpha_supplement',tenantId:TENANT_ID,
    xeroTenantId:XERO_TENANT_ID,sourceSha256:hash({
      grid:input.grid,originalManifest:input.originalManifest,scopes:input.scopes,evidence:input.evidence,
    }),dataSha256:hash(evidence),collisionScopesSha256:hash(input.scopes),
    originalManifestSha256:pins.originalManifestSha256,observedAt:evidence.observedAt,
    term:{start:TERM_START,end:TERM_END,collectionDay:1,pricing:'dynamic',
      endPolicy:'continue',activation:'first_payment',priorEntitlementUnchanged:true},
    policy:{collectionHeld:true,releaseApproved:false,futurePolicy:'held_no_release',
      invoiceAccountAllowlist:['200','201'],accountingApproval:false},
    members,blocked,counts:{workbook:21,financiallyReconciled:members.length,blocked:blocked.length},
    approval:{adoptionApproved:false,writerApproved:false,schemaReviewed:false,dataReviewed:false},
  };
}

export function buildSupplementalAlphaManifest(input,{now}={}){
  return coreBuild(input,{now,pins:{gridSha256:SUPPLEMENT_GRID_SHA256,
    originalManifestSha256:ORIGINAL_ALPHA_MANIFEST_SHA256}});
}

// Synthetic tests exercise the same core without embedding private workbook data.
export function createSyntheticSupplementalGuard({gridSha256,originalManifestSha256}){
  if(!/^[0-9a-f]{64}$/.test(gridSha256)||!/^[0-9a-f]{64}$/.test(originalManifestSha256))
    fail('Synthetic guard hashes required');
  const build=input=>coreBuild(input,{now:input.now,pins:{gridSha256,originalManifestSha256}});
  return {build,prepare:(manifest,input,{apply=false}={})=>{
    if(apply)fail('Supplemental preparation is read-only; no apply capability');
    const reconstructed=build(input);
    if(hash(reconstructed)!==hash(manifest))fail('Supplemental manifest reconstruction mismatch');
    return preparationResult(manifest);
  }};
}

const preparationResult=manifest=>({
  mode:'supplemental_alpha_dry_run',manifestSha256:hash(manifest),writes:0,providerWrites:0,
  collectionReleased:false,releaseApproved:false,adoptionReady:false,eligible:false,eligibleRecords:0,
  financiallyReconciledRecords:manifest.members.length,blockedRecords:manifest.blocked.length,
  futureWriter:'accounting approval plus schema and data review required',
});

export function prepareSupplementalAlpha(manifest,input,{now,apply=false}={}){
  if(apply)fail('Supplemental preparation is read-only; no apply capability');
  const reconstructed=buildSupplementalAlphaManifest(input,{now});
  if(hash(reconstructed)!==hash(manifest))fail('Supplemental manifest reconstruction mismatch');
  return preparationResult(manifest);
}