// Exact operator-approved six-member repair. Provider access is GET-only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {TENANT,sha,buildRecord,assertRecord,financialProjection} from './bnms-approved-72-core.mjs';
import {projectNmcReport} from '../api/_lib/nmcMembershipReport.js';
import {MEMBERSHIP_RECOGNITION_TABLES} from '../api/_lib/alphaMembershipRecognition.js';
const root='generated-artifacts/bnms-nmc-25-evidence',out='generated-artifacts/bnms-approved-six-nmc';
const pins={'proposal.json':'4863739b20eab5685be3cf03fe67238d795aff5bd029c4c133739d52bf4b7827',
  'snapshot.json':'36fd930b215422b5898414988db04df92fdc446c6654e0b7078b148e4c0f4b43',
  'sources.json':'600c2c8e2729d2c685385b09ac16550154555c84482436b58cc75dd44ded98e9',
  'members.json':'037c4f3cb796ba2d0847facd7664dfbe41848292b8b6a1da88c3bac99bf8e2c7'};
const read=p=>JSON.parse(fs.readFileSync(p));
const save=(name,value)=>fs.writeFileSync(`${out}/${name}.json`,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
const plusDay=s=>new Date(Date.parse(s)+86400000).toISOString().slice(0,10);
const uk=s=>s.split('-').reverse().join('/');
function moneyProjection(invoice){
  const p=financialProjection(invoice);
  p.AmountCredited=invoice.AmountCredited||0;
  p.CreditNotes=invoice.CreditNotes||[];
  p.LineItems=invoice.LineItems.map(l=>Object.fromEntries(
    ['LineItemID','Description','Quantity','UnitAmount','TaxType','TaxAmount','LineAmount','AccountCode','AccountID'].map(k=>[k,l[k]??null])));
  assert.ok(invoice.LineItems.every(l=>!(l.ValidationErrors||[]).length));
  return p;
}
async function main(){
  const mode=process.argv[2];assert.ok(['verify','dry-run','apply','replay'].includes(mode));
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  for(const [file,hash] of Object.entries(pins))assert.equal(sha(fs.readFileSync(`${root}/${file}`)),hash);
  const proposal=read(`${root}/proposal.json`).rows.filter(r=>r.category.startsWith('Renewal'));
  assert.equal(proposal.length,6);assert.equal(new Set(proposal.map(r=>r.memberId)).size,6);
  const ids=new Set(proposal.map(r=>r.memberId)),snap=read(`${root}/snapshot.json`);
  const original=read(`${root}/members.json`),sources=read(`${root}/sources.json`).rows;
  destinationTarget(process.env);
  process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
  const {SOURCE_SQL,canonicalHash}=await import('./bnms-non-dd-apply.mjs');
  if(mode==='verify'){
    const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
    const auth=await getValidXeroAccessToken(TENANT);
    assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
    let requests=0;
    const get=async path=>{
      await new Promise(r=>setTimeout(r,2100));assert.ok(++requests<=30);
      const response=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{
        method:'GET',redirect:'error',headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
        signal:AbortSignal.timeout(30000)});
      assert.equal(response.status,200,'Provider verification incomplete');
      if(response.headers.has('x-daylimit-remaining'))assert.ok(Number(response.headers.get('x-daylimit-remaining'))>=500,'Daily reserve reached');
      return response.json();
    };
    const providers=[];
    for(const p of proposal){
      const old=original.find(o=>o.memberId===p.memberId);assert.equal(old.contacts.length,1);
      const prior=old.membershipInvoices.find(i=>i.InvoiceID===old.latestPaidInvoiceId);
      const invoice=(await get(`Invoices/${prior.InvoiceID}`)).Invoices[0];
      assert.deepEqual(moneyProjection(invoice),moneyProjection(prior));
      const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
      for(const k of ['ContactID','AccountNumber','EmailAddress','Name'])assert.deepEqual(contact[k],old.contacts[0][k]);
      const payments=[];
      for(const priorPayment of old.payments){
        const payment=(await get(`Payments/${priorPayment.PaymentID}`)).Payments[0];
        for(const k of ['PaymentID','Status','Amount','Date'])assert.deepEqual(payment[k],priorPayment[k]);
        assert.equal(payment.Invoice.InvoiceID,invoice.InvoiceID);payments.push(payment);
      }
      providers.push({...old,contacts:[contact],membershipInvoices:[invoice],payments});
    }
    save('verified',{at:new Date().toISOString(),providers,requests,pins});
    console.log(JSON.stringify({verified:6,GETRequests:requests,providerWrites:0}));return;
  }
  const evidence=read(`${out}/verified.json`);
  assert.deepEqual(evidence.pins,pins);
  assert.ok(Date.now()-Date.parse(evidence.at)<30*60000,'Evidence older than 30 minutes');
  const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
  const db=await connectDestination();
  try{
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='90s'");
    const protectedTables=['member','member_membership_history','member_preference_value','preference_field','membership_tier_config',
      'membership_billing_agreements','membership_payment_plans','gocardless_payments'];
    await db.query(`LOCK TABLE ${protectedTables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const readTable=async t=>(await db.query(`select to_jsonb(r) data from ${t} r where ${
      t==='member_preference_value'?'member_id in (select id from member where tenant_id=$1)':'tenant_id=$1'} order by ${MEMBERSHIP_RECOGNITION_TABLES.includes(t)?'to_jsonb(r)::text':'r.id'}`,[TENANT])).rows.map(r=>r.data);
    const before={};for(const t of protectedTables)before[t]=await readTable(t);
    const liveSources=(await db.query(SOURCE_SQL,[TENANT])).rows;
    const fields=before.preference_field;
    const classField=fields.filter(f=>f.name==='member_class'&&f.entity_scope==='member'&&f.is_active);
    const expiryField=fields.filter(f=>f.name==='ym_date_membership_expires'&&f.entity_scope==='member'&&f.is_active);
    assert.equal(classField.length,1);assert.equal(expiryField.length,1);
    const records=[],expiryChanges=[];
    for(const p of proposal){
      const h=sha(`${pins['proposal.json']}:${p.memberId}`);
      const id=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
      const oldMember=snap.members.find(m=>m.id===p.memberId),member=before.member.find(m=>m.id===p.memberId);
      for(const [k,v] of Object.entries(oldMember))assert.deepEqual(member[k],v,'Member identity changed');
      const own=before.member_membership_history.filter(h=>h.member_id===p.memberId);
      const existing=own.find(h=>h.id===id);
      assert.equal(!!existing,mode==='replay','Unexpected repair state');
      assert.deepEqual(own.filter(h=>h.id!==id),snap.histories.filter(h=>h.member_id===p.memberId).sort((a,b)=>a.id.localeCompare(b.id)));
      const source=liveSources.find(m=>m.id===p.memberId),priorSource=snap.source.find(m=>m.id===p.memberId);
      assert.equal(source.duplicate_fields,false);assert.equal(source.dd_evidence,false);
      const preferences={...source.preferences};
      if(existing)preferences.ym_date_membership_expires=priorSource.preferences.ym_date_membership_expires;
      assert.deepEqual(preferences,priorSource.preferences,'Membership source changed');
      const provider=evidence.providers.find(r=>r.memberId===p.memberId),contact=provider.contacts[0];
      const account=priorSource.preferences.ym_web_site_member_id.trim();
      assert.ok(!contact.AccountNumber||contact.AccountNumber.trim()===account);
      const emailMatches=contact.EmailAddress.trim().toLowerCase()===member.email.trim().toLowerCase();
      assert.ok(emailMatches||sources.find(s=>s.memberId===p.memberId).matches.some(s=>!s.identityConflict&&s.legacyId===account&&s.email.toLowerCase()===contact.EmailAddress.toLowerCase()&&contact.AccountNumber===account));
      const invoice=provider.membershipInvoices[0];
      assert.equal(invoice.InvoiceNumber,p.invoice);assert.equal(invoice.Status,'PAID');
      assert.equal(invoice.AmountDue,0);assert.equal(invoice.AmountPaid,invoice.Total);
      assert.equal(invoice.AmountCredited||0,0);assert.equal((invoice.CreditNotes||[]).length,0);
      assert.equal(invoice.Total,p.membershipAmount);assert.equal(invoice.TotalTax,0);
      assert.equal(invoice.LineItems.length,1);
      assert.ok(provider.payments.every(x=>x.Status==='AUTHORISED'&&x.Amount>0&&x.Invoice.InvoiceID===invoice.InvoiceID));
      assert.equal(provider.payments.reduce((n,x)=>n+x.Amount,0),invoice.Total);
      assert.ok(!before.member_membership_history.some(h=>h.member_id!==p.memberId&&h.accounting_invoice_id===invoice.InvoiceID));
      const configs=before.membership_tier_config.filter(c=>c.is_active&&c.structure_scope_type==='member'&&c.structure_field_id===classField[0].id
        &&c.structure_match_value===p.memberClass&&c.effective_from<='2026-10-14'&&(!c.effective_to||c.effective_to>='2026-10-14'));
      assert.equal(configs.length,1);
      const record=buildRecord({...p,retainedExpiry:p.proposedEnd,proposedRenewal:plusDay(p.proposedEnd)},configs[0],provider);
      record.id=id;
      record.notes=JSON.stringify({source:'bnms_approved_six_nmc_renewals',version:1,approvalDate:'2026-10-14',
        proposalHash:pins['proposal.json'],termAuthority:'operator_approved_exact_12_month_successor',
        priorRetainedExpiry:p.retainedExpiry,priorHistoryIds:own.filter(h=>h.id!==id).map(h=>h.id),
        structureAuthority:'current_member_class_mapping_not_original_purchase_configuration',
        paymentAuthority:'verified_xero_authorised_payments',invoiceId:invoice.InvoiceID,paymentIds:provider.payments.map(p=>p.PaymentID),
        historicalPaymentInstrument:'unknown',futureCollectionConsent:false,providerWrites:0});
      if(existing)assertRecord(existing,record);
      records.push(record);
      const pref=before.member_preference_value.filter(v=>v.member_id===p.memberId&&v.field_id===expiryField[0].id);
      assert.equal(pref.length,1);assert.equal(pref[0].value,uk(existing?p.proposedEnd:p.retainedExpiry));
      expiryChanges.push({id:pref[0].id,memberId:p.memberId,old:pref[0].value,value:uk(p.proposedEnd)});
    }
    const scoped={records,expiryChanges,members:before.member.filter(m=>ids.has(m.id)),
      preferences:before.member_preference_value.filter(v=>ids.has(v.member_id)),history:before.member_membership_history.filter(h=>ids.has(h.member_id))};
    const scopeHash=canonicalHash(scoped);
    if(mode==='apply')assert.equal(read(`${out}/dry-run.json`).scopeHash,scopeHash,'Approved state changed after dry run');
    const extra={organizations:await readTable('organization'),roles:await readTable('role'),
      recognitions:(await Promise.all(MEMBERSHIP_RECOGNITION_TABLES.map(readTable))).flat()};
    const project=state=>projectNmcReport({...extra,members:state.member,fields:state.preference_field,
      preferences:state.member_preference_value,history:state.member_membership_history,agreements:state.membership_billing_agreements,reportDate:'2026-10-14'});
    const reportBefore=project(before);
    save(`before-${mode}-${Date.now()}`,{before,records,expiryChanges,scopeHash});
    if(mode!=='replay')for(const record of records){
      const keys=Object.keys(record);
      await db.query(`insert into member_membership_history (${keys.join(',')}) values (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
        keys.map(k=>record[k]!=null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
      const change=expiryChanges.find(x=>x.memberId===record.member_id);
      const result=await db.query('update member_preference_value set value=$1 where id=$2 and value=$3',[change.value,change.id,change.old]);
      assert.equal(result.rowCount,1);
    }
    const after={};for(const t of protectedTables)after[t]=await readTable(t);
    for(const r of records){
      const actual=after.member_membership_history.find(h=>h.id===r.id);assertRecord(actual,r);
      const display=shapePersistedCommitment(actual,new Date('2026-10-14T12:00:00Z'));
      assert.equal(display.lifecycle,'current');assert.equal(display.startDate,r.term_start_date);
      assert.equal(display.endDate,r.term_end_date);assert.equal(display.agreedPrice,r.total_with_vat);
      assert.equal(display.structureName,r.commitment_snapshot.config.name);
      assert.equal(after.member_preference_value.find(v=>v.member_id===r.member_id&&v.field_id===expiryField[0].id).value,uk(r.term_end_date));
    }
    const newIds=new Set(records.map(r=>r.id));
    assert.deepEqual(after.member_membership_history.filter(h=>!newIds.has(h.id)),before.member_membership_history.filter(h=>!newIds.has(h.id)));
    for(const old of before.member_preference_value){
      const actual=after.member_preference_value.find(v=>v.id===old.id),change=expiryChanges.find(c=>c.id===old.id);
      assert.deepEqual(actual,change&&mode!=='replay'?{...old,value:change.value,updated_at:actual.updated_at}:old);
    }
    for(const old of before.member){
      const actual=after.member.find(m=>m.id===old.id);
      assert.deepEqual(actual,ids.has(old.id)&&mode!=='replay'?{...old,updated_at:actual.updated_at,survey_invitation_revision:old.survey_invitation_revision+1}:old);
    }
    for(const t of protectedTables.filter(t=>!['member','member_membership_history','member_preference_value'].includes(t)))assert.deepEqual(after[t],before[t]);
    const reportAfter=project(after);
    for(const id of ids)assert.equal(project({...after,member:after.member.filter(m=>m.id===id)}).total,1,'Approved member absent from NMC report');
    assert.equal(reportAfter.sheets[0].count-reportBefore.sheets[0].count,mode==='replay'?0:6);
    await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
    if(mode==='apply')for(const r of records)assertRecord((await db.query('select to_jsonb(h) data from member_membership_history h where id=$1',[r.id])).rows[0].data,r);
    const receipt={mode,committed:mode==='apply',inserted:mode==='replay'?0:6,scopeHash,
      journalCountBefore:reportBefore.sheets[0].count,journalCountAfter:reportAfter.sheets[0].count,
      providerWrites:0,priorHistoryChanged:0,billingChanged:0,at:new Date().toISOString()};
    save(mode==='dry-run'?'dry-run':`${mode}-${Date.now()}`,receipt);
    console.log(JSON.stringify(receipt));
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
}
main().catch(e=>{console.error(JSON.stringify({stopped:true,code:e.code||e.name,
  reason:e.code==='ERR_ASSERTION'||e.code==='42703'?String(e.message).split('\n')[0]:'Operation failed',
  location:e.stack?.split('\n').find(l=>l.includes('repair-bnms-approved-six-nmc.mjs:'))?.trim()}));process.exitCode=1;});
