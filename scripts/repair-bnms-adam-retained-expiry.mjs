// Individually approved entitlement repair. No provider write operations.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {sha,TENANT,assertRecord} from './bnms-approved-72-core.mjs';
import {HISTORICAL_ENTITLEMENT_SOURCE,isBnmsHistoricalEntitlement} from '../api/_lib/bnmsHistoricalEntitlement.js';
import {projectNmcReport} from '../api/_lib/nmcMembershipReport.js';
import {MEMBERSHIP_RECOGNITION_TABLES} from '../api/_lib/alphaMembershipRecognition.js';
const memberId='1be724c5-febf-563c-adbf-a8986ad46c79',expiry='2026-11-18';
const out='generated-artifacts/bnms-adam-retained-expiry',read=p=>JSON.parse(fs.readFileSync(p));
const save=(name,data)=>fs.writeFileSync(`${out}/${name}.json`,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
const approval={memberId,expiry,memberClass:'Full with NMC',start:'unknown',scope:'historical_entitlement_only',approved:'2026-10-14'};
const approvalHash=sha(JSON.stringify(approval)),key=sha(`${HISTORICAL_ENTITLEMENT_SOURCE}:${approvalHash}`);
const id=`${key.slice(0,8)}-${key.slice(8,12)}-5${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}`;
async function main(){
  const mode=process.argv[2];assert.ok(['verify','dry-run','apply','replay'].includes(mode));
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  destinationTarget(process.env);
  process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
  const {SOURCE_SQL,canonicalHash}=await import('./bnms-non-dd-apply.mjs');
  if(mode==='verify'){
    const old=read('generated-artifacts/bnms-nmc-25-evidence/members.json').find(r=>r.memberId===memberId);
    const prior=old.membershipInvoices.find(i=>i.InvoiceID===old.latestPaidInvoiceId);
    assert.equal(prior.InvoiceNumber,'300004866');
    const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
    const auth=await getValidXeroAccessToken(TENANT);assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
    let requests=0;
    const get=async path=>{
      assert.ok(++requests<=5);await new Promise(r=>setTimeout(r,2100));
      const response=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{method:'GET',redirect:'error',
        headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},signal:AbortSignal.timeout(30000)});
      assert.equal(response.status,200);return response.json();
    };
    const invoice=(await get(`Invoices/${prior.InvoiceID}`)).Invoices[0];
    const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
    const payments=[];for(const p of invoice.Payments||[])payments.push((await get(`Payments/${p.PaymentID}`)).Payments[0]);
    save('provider',{at:new Date().toISOString(),invoice,contact,payments,requests});
    console.log(JSON.stringify({verifiedProviderReads:requests,providerWrites:0}));return;
  }
  const evidence=read(`${out}/provider.json`),{invoice:i,contact,payments}=evidence;
  assert.ok(Date.now()-Date.parse(evidence.at)<1800000);
  assert.equal(i.InvoiceNumber,'300004866');assert.equal(i.Type,'ACCREC');assert.equal(i.Status,'PAID');
  assert.equal(i.CurrencyCode,'GBP');assert.equal(i.Total,156);assert.equal(i.AmountPaid,156);assert.equal(i.AmountDue,0);
  assert.equal(i.AmountCredited||0,0);assert.equal((i.CreditNotes||[]).length,0);
  assert.equal(i.TotalTax,0);assert.equal(i.LineItems.length,1);assert.equal(i.LineItems[0].Description,'Full Membership UK');
  assert.equal(i.LineItems[0].LineAmount,156);assert.equal(i.LineItems[0].Quantity,1);
  assert.ok(payments.length&&payments.every(p=>p.Status==='AUTHORISED'&&p.Amount>0&&p.Invoice.InvoiceID===i.InvoiceID));
  assert.equal(payments.reduce((s,p)=>s+p.Amount,0),156);
  const db=await connectDestination();
  try{
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    const tables=['member','member_preference_value','preference_field','membership_billing_agreements','membership_payment_plans',
      'membership_tier_config','gocardless_payments','gocardless_customers','gocardless_mandate_discovery_row',
      'membership_expiry_policy_assignment',...MEMBERSHIP_RECOGNITION_TABLES];
    await db.query(`LOCK TABLE member_membership_history,${tables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const table=async t=>(await db.query(`select to_jsonb(r) data from ${t} r where ${
      t==='member_preference_value'?'member_id in (select id from member where tenant_id=$1)':'tenant_id=$1'} order by to_jsonb(r)::text`,[TENANT])).rows.map(r=>r.data);
    const before={};for(const t of tables)before[t]=await table(t);
    const history=await table('member_membership_history'),own=history.filter(h=>h.member_id===memberId);
    assert.equal(own.length,mode==='replay'?1:0);
    const source=(await db.query(SOURCE_SQL,[TENANT])).rows.find(s=>s.id===memberId);
    assert.equal(source.preferences.member_class,approval.memberClass);assert.equal(source.preferences.membership_status,'Active');
    assert.equal(source.preferences.ym_date_membership_expires,'18/11/2026');assert.equal(source.duplicate_fields,false);
    if(mode==='replay')source.history_count--;
    const member=before.member.find(m=>m.id===memberId);
    assert.equal(contact.EmailAddress.toLowerCase(),member.email.toLowerCase());
    assert.ok(!contact.AccountNumber||contact.AccountNumber.trim()===source.preferences.ym_web_site_member_id.trim());
    const notes={source:HISTORICAL_ENTITLEMENT_SOURCE,version:1,approvalDate:'2026-10-14',
      scope:'historical_entitlement_only',memberId,expiry,approvalHash,sourceHash:sha(JSON.stringify(source)),
      paymentAuthority:'xero_authorised_payments',startDateAuthority:'unknown_not_inferred',
      expiryAuthority:'operator_approved_retained_expiry',invoiceAuthority:'verified_xero_payment',
      invoiceId:i.InvoiceID,paymentIds:payments.map(p=>p.PaymentID).sort(),futureCollectionConsent:false,providerWrites:0,
      ddEvidenceRecorded:source.dd_evidence,historicalPaymentInstrument:'unknown',historicalStructureAuthority:'member_class_not_current_price'};
    const record={id,tenant_id:TENANT,member_id:memberId,membership_year:'Legacy membership (start unknown)',
      tier_label:approval.memberClass,field_value:approval.memberClass,status:'active',term_start_date:null,term_end_date:expiry,
      billing_period:'annual',payment_status:'paid',payment_method:'upfront',annual_cost:156,final_cost:156,total_with_vat:156,
      vat_amount:0,currency:'GBP',paid_at:new Date(Math.max(...payments.map(p=>Number(/\/Date\((\d+)/.exec(p.Date)?.[1])))).toISOString(),
      accounting_provider:'xero',accounting_invoice_id:i.InvoiceID,accounting_invoice_number:i.InvoiceNumber,
      xero_invoice_id:i.InvoiceID,xero_invoice_number:i.InvoiceNumber,notes:JSON.stringify(notes)};
    for(const k of ['config_id','billing_agreement_id','prorata_cost','membership_renewal_date','renewal_policy_snapshot',
      'commitment_snapshot','previous_term_id','term_key','term_duration_months','term_anchor_date','membership_successor_election_id',
      'stripe_payment_intent_id','free_period_discount','rollover_discount','custom_discount_total'])record[k]=null;
    assert.ok(isBnmsHistoricalEntitlement(record));
    assert.ok(!history.some(h=>h.accounting_invoice_id===i.InvoiceID&&h.id!==id));
    const scopeHash=canonicalHash({source,member,record,own});
    if(mode==='apply')assert.equal(read(`${out}/dry-run.json`).scopeHash,scopeHash);
    const input={members:before.member,fields:before.preference_field,preferences:before.member_preference_value,
      organizations:await table('organization'),roles:await table('role'),agreements:before.membership_billing_agreements,
      recognitions:MEMBERSHIP_RECOGNITION_TABLES.flatMap(t=>before[t]),reportDate:'2026-10-14'};
    const count=h=>projectNmcReport({...input,history:h}).sheets[0].count;
    save(`before-${mode}-${Date.now()}`,{before,history,record,source,approval,scopeHash});
    if(mode!=='replay'){
      const keys=Object.keys(record);
      await db.query(`insert into member_membership_history (${keys.join(',')}) values (${keys.map((_,j)=>`$${j+1}`).join(',')})`,keys.map(k=>record[k]));
    }
    const after=await table('member_membership_history');assertRecord(after.find(h=>h.id===id),record);
    assert.ok(isBnmsHistoricalEntitlement(after.find(h=>h.id===id)));
    assert.deepEqual(after.filter(h=>h.id!==id),history.filter(h=>h.id!==id));
    for(const t of tables)assert.deepEqual(await table(t),before[t],`Unexpected change: ${t}`);
    assert.equal(projectNmcReport({...input,members:[member],history:after}).sheets[0].count,1);
    assert.equal(count(after)-count(history),mode==='replay'?0:1);
    await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
    if(mode==='apply')assertRecord((await db.query('select to_jsonb(h) data from member_membership_history h where id=$1',[id])).rows[0].data,record);
    const receipt={mode,committed:mode==='apply',inserted:mode==='apply'?1:0,scopeHash,
      printBefore:count(history),printAfter:count(after),expiry,start:null,providerWrites:0,billingChanges:0};
    save(mode==='dry-run'?'dry-run':`${mode}-${Date.now()}`,receipt);console.log(JSON.stringify(receipt));
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
}
main().catch(e=>{console.error(JSON.stringify({stopped:true,code:e.code||e.name,
  reason:e.code==='ERR_ASSERTION'?e.message.split('\n')[0]:'Repair stopped',
  location:e.stack?.split('\n').find(l=>l.includes('repair-bnms-adam-retained-expiry.mjs:'))?.trim()}));process.exitCode=1;});
