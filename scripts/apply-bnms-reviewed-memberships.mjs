import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';
import { buildRollingCommitment } from '../api/_lib/rollingMembershipCommitment.js';
const mode=process.argv[2];
assert.ok(['dry-run','apply'].includes(mode));
const dir='generated-artifacts/bnms-expiry-only-audit';
const approved=JSON.parse(fs.readFileSync(`${dir}/candidate-payment-verification.json`)).results;
const review=JSON.parse(fs.readFileSync(`${dir}/live-review.json`));
const allowed=['200007791','200008208','200007761','200008200','200007805','200007857','200007768','200008260','200008158','200007509','200008210'];
const rows=approved.filter(r=>allowed.includes(r.invoice));
assert.equal(rows.length,11);
assert.equal(new Set(rows.map(r=>r.memberId)).size,11);
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const {selectCanvasCommitment,buildCanvasSummary}=await import('../api/membership/canvas-summary.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path){
  const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},signal:AbortSignal.timeout(30000)});
  assert.equal(r.status,200,'Provider verification failed; no repairs applied');
  return r.json();
}
for(const r of rows){
  const prior=review.reports.find(m=>m.memberId===r.memberId);
  const candidate=prior.evidence.find(i=>i.number===r.invoice);
  const i=(await get(`Invoices/${candidate.id}`)).Invoices[0];
  assert.equal(i.InvoiceNumber,r.invoice);
  assert.equal(i.Status,'PAID');assert.equal(i.AmountDue,0);assert.equal(i.AmountPaid,i.Total);
  assert.equal(i.AmountCredited||0,0);assert.equal(i.CurrencyCode,'GBP');
  for(const key of ['CreditNotes','Overpayments','Prepayments'])assert.equal((i[key]||[]).length,0);
  const lines=i.LineItems.filter(l=>/membership/i.test(l.Description));
  assert.equal(lines.length,1);
  const line=lines[0];
  assert.match(line.Description,/^1 year's (full|junior|trainee) membership\)?$/i);
  assert.equal(line.LineAmount,r.membershipLine.amount);assert.equal(line.TaxAmount,0);
  assert.equal(line.TaxType,'ZERORATEDOUTPUT');
  const payments=[];
  for(const p of i.Payments){
    const actual=(await get(`Payments/${p.PaymentID}`)).Payments[0];
    assert.equal(actual.Invoice.InvoiceID,i.InvoiceID);
    assert.equal(actual.Status,'AUTHORISED');assert.equal(actual.IsReconciled,true);
    payments.push(actual);
  }
  assert.ok(payments.length);
  assert.ok(Math.abs(payments.reduce((n,p)=>n+p.Amount,0)-i.Total)<0.005);
  r.live={invoice:i,line,payments,prior};
}
const db=await connectDestination();
const receipts=[];
try{
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query('LOCK TABLE member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const allBefore=(await db.query('select to_jsonb(h) data from member_membership_history h where tenant_id=$1 order by id',[tenant])).rows.map(r=>r.data);
  for(const r of rows){
    const {invoice,line,payments,prior}=r.live;
    const member=(await db.query('select to_jsonb(m) data from member m where tenant_id=$1 and id=$2 for update',[tenant,r.memberId])).rows[0].data;
    const histories=allBefore.filter(h=>h.member_id===r.memberId);
    assert.equal(histories.length,1);
    const before=histories[0];
    const original=JSON.parse(before.notes);
    const replay=original.source==='bnms_approved_itemised_invoice_reconstruction';
    assert.equal(before.term_end_date,r.end);assert.equal(before.payment_status,'paid');
    assert.equal(before.payment_method,'upfront');assert.equal(before.billing_agreement_id,null);
    if(!replay)assert.equal(before.term_start_date,null);
    const prefs=(await db.query(`select f.name,v.value from member_preference_value v join preference_field f on f.id=v.field_id
      where f.tenant_id=$1 and v.member_id=$2 order by v.id`,[tenant,r.memberId])).rows;
    const field=name=>prefs.find(p=>p.name===name)?.value;
    assert.equal(field('member_class'),prior.memberClass);
    const contact=invoice.Contact;
    const emailMatch=!!member.email&&member.email.trim().toLowerCase()===String(contact.EmailAddress||'').trim().toLowerCase();
    const accountMatch=!!field('ym_web_site_member_id')&&String(contact.AccountNumber)===String(field('ym_web_site_member_id'));
    assert.ok(emailMatch||accountMatch,'Live invoice identity mismatch');
    if(contact.AccountNumber&&field('ym_web_site_member_id'))assert.ok(accountMatch,'Account number conflict');
    const readRelated=async table=>(await db.query(`select to_jsonb(t) data from ${table} t where tenant_id=$1 and member_id=$2 order by id`,[tenant,r.memberId])).rows;
    const related={};
    for(const table of ['membership_billing_agreements','membership_payment_plans','membership_expiry_policy_assignment','historical_member_invoice'])related[table]=await readRelated(table);
    assert.equal(related.membership_billing_agreements.length,0);
    assert.equal(related.membership_payment_plans.length,0);
    assert.ok(related.historical_member_invoice.some(v=>v.data.invoice_number===r.invoice));
    const configs=(await db.query(`select to_jsonb(c) data from membership_tier_config c where tenant_id=$1
      and structure_scope_type='member' and structure_match_value=$2 and is_active and billing_period='annual'
      and start_mode='immediate' and effective_from<=$3 and (effective_to is null or effective_to>=$3)`,
    [tenant,field('member_class'),r.start])).rows;
    assert.equal(configs.length,1);
    const config=configs[0].data;
    assert.equal(config.name,r.schedule);
    const amounts={annual_cost:line.LineAmount,final_cost:line.LineAmount,vat_amount:0,total_with_vat:line.LineAmount,currency:'GBP'};
    const commitment=buildRollingCommitment({config,startDate:r.start,paymentMethod:'upfront',paymentFrequency:'upfront',
      amounts,pricingSnapshot:{tier_label:field('member_class'),...amounts}});
    assert.equal(commitment.term_end_date,r.end);
    const paidAt=new Date(Math.max(...payments.map(p=>Number(/\/Date\((\d+)/.exec(p.Date)[1])))).toISOString();
    const patch={...commitment,...amounts,config_id:config.id,tier_label:field('member_class'),field_value:field('member_class'),
      membership_year:commitment.term_key,paid_at:paidAt,accounting_provider:'xero',
      accounting_invoice_id:invoice.InvoiceID,accounting_invoice_number:r.invoice,
      xero_invoice_id:invoice.InvoiceID,xero_invoice_number:r.invoice,
      notes:replay?before.notes:JSON.stringify({source:'bnms_approved_itemised_invoice_reconstruction',version:1,
        previousEvidence:original,termAuthority:'owner_approved_annual_term_preserving_expiry',
        paymentAuthority:'xero_authorised_reconciled_payment',invoiceId:invoice.InvoiceID,
        membershipLineId:line.LineItemID,membershipAmount:line.LineAmount,wholeInvoiceAmount:invoice.Total,
        paymentIds:payments.map(p=>p.PaymentID),futureCollectionConsent:false})};
    if(mode==='apply'&&!replay)fs.writeFileSync(`${dir}/before-${r.memberId}-${Date.now()}.json`,
      JSON.stringify({before,patch,invoice,payments},null,2),{mode:0o600,flag:'wx'});
    if(!replay){
      const keys=Object.keys(patch);
      const result=await db.query(`update member_membership_history set ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')}
        where id=$${keys.length+1} and tenant_id=$${keys.length+2}`,
      [...keys.map(k=>typeof patch[k]==='object'&&patch[k]!==null?JSON.stringify(patch[k]):patch[k]),before.id,tenant]);
      assert.equal(result.rowCount,1);
    }
    const after=(await db.query('select to_jsonb(h) data from member_membership_history h where id=$1',[before.id])).rows[0].data;
    for(const [key,value]of Object.entries(patch)){
      if(key==='paid_at')assert.equal(Date.parse(after[key]),Date.parse(value));
      else assert.deepEqual(after[key],value,key);
    }
    for(const [table,data]of Object.entries(related))assert.deepEqual(await readRelated(table),data);
    assert.deepEqual((await db.query('select to_jsonb(m) data from member m where id=$1',[r.memberId])).rows[0].data,member);
    const today=new Date().toISOString().slice(0,10);
    const summary=buildCanvasSummary({selected:selectCanvasCommitment([{...after,membership_source:'personal'}],[],today),today});
    assert.equal(summary.membership.state,'active');assert.equal(summary.payment.state,'paid');
    receipts.push({memberId:r.memberId,name:r.name,invoice:r.invoice,start:r.start,end:r.end,amount:line.LineAmount,replay,summary});
  }
  const ids=new Set(rows.map(r=>r.memberId));
  const afterAll=(await db.query('select to_jsonb(h) data from member_membership_history h where tenant_id=$1 order by id',[tenant])).rows.map(r=>r.data);
  assert.equal(afterAll.length,allBefore.length);
  assert.deepEqual(afterAll.filter(h=>!ids.has(h.member_id)),allBefore.filter(h=>!ids.has(h.member_id)));
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  fs.writeFileSync(`${dir}/reconstruction-${mode}.json`,JSON.stringify({checkedAt:new Date().toISOString(),receipts},null,2),{mode:0o600});
  console.log(JSON.stringify({mode,members:receipts.length,replays:receipts.filter(r=>r.replay).length,activeAndPaid:receipts.length,otherHistoriesUnchanged:true}));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
