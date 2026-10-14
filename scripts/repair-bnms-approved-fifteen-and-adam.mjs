// Bounded approved reconstruction: 15 inserts and one in-place update.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {TENANT,sha,buildRecord,assertRecord} from './bnms-approved-72-core.mjs';
import {addCalendarMonths} from '../shared/rollingMembershipTerm.js';
import {projectNmcReport} from '../api/_lib/nmcMembershipReport.js';
import {MEMBERSHIP_RECOGNITION_TABLES} from '../api/_lib/alphaMembershipRecognition.js';
const root='generated-artifacts/bnms-approved-fifteen-and-adam',adam='1be724c5-febf-563c-adbf-a8986ad46c79';
const reviewPath='generated-artifacts/bnms-adam-similar-review/latest.json';
const reviewHash='d0fa91d97a1acf640541d5e3d051d752251d22c6b8f63476809d33c12f1cfca1';
const read=p=>JSON.parse(fs.readFileSync(p));
const save=(name,data)=>fs.writeFileSync(`${root}/${name}.json`,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
const endToDates=end=>{
  const renewal=new Date(Date.parse(end)+86400000).toISOString().slice(0,10);
  const start=`${Number(renewal.slice(0,4))-1}${renewal.slice(4)}`;
  assert.equal(addCalendarMonths(start,12),renewal);
  return {proposedStart:start,proposedRenewal:renewal};
};
async function main(){
  const mode=process.argv[2];assert.ok(['prepare','dry-run','apply','replay'].includes(mode));
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  assert.equal(sha(fs.readFileSync(reviewPath)),reviewHash);
  const cohort=read(reviewPath).current.filter(r=>r.paid&&r.amount>0&&r.sourceState==='source_fields_corroborated');
  assert.equal(cohort.length,15);
  cohort.push({id:adam,class:'Full with NMC',expiry:'2026-11-18',invoice:'300004866',amount:156});
  const ids=new Set(cohort.map(r=>r.id));assert.equal(ids.size,16);
  destinationTarget(process.env);
  process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
  const {SOURCE_SQL,canonicalHash}=await import('./bnms-non-dd-apply.mjs');
  const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
  const tables=['member','member_preference_value','preference_field','membership_tier_config',
    'membership_billing_agreements','membership_payment_plans','gocardless_payments','gocardless_customers',
    'gocardless_mandate_discovery_row','membership_expiry_policy_assignment',...MEMBERSHIP_RECOGNITION_TABLES];
  const db=await connectDestination();
  const table=async t=>(await db.query(`select to_jsonb(r) data from ${t} r where ${
    t==='member_preference_value'?'member_id in (select id from member where tenant_id=$1)':'tenant_id=$1'} order by to_jsonb(r)::text`,[TENANT])).rows.map(r=>r.data);
  try{
    if(mode==='prepare'){
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot={members:(await table('member')).filter(m=>ids.has(m.id)),
        history:(await table('member_membership_history')).filter(h=>ids.has(h.member_id)),
        sources:(await db.query(SOURCE_SQL,[TENANT])).rows.filter(s=>ids.has(s.id)),configs:await table('membership_tier_config')};
      assert.equal(snapshot.members.length,16);assert.equal(snapshot.history.length,1);
      assert.equal(snapshot.history[0].member_id,adam);assert.equal(snapshot.history[0].term_start_date,null);
      await db.query('ROLLBACK');
      const originals=[...read('generated-artifacts/bnms-live-xero-150/members.json'),
        ...read('generated-artifacts/bnms-remaining-84/members.json'),...read('generated-artifacts/bnms-nmc-25-evidence/members.json')];
      const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
      const auth=await getValidXeroAccessToken(TENANT);
      assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
      let requests=0,reserve=10000;const providers=[];
      const get=async path=>{
        assert.ok(++requests<=65);assert.ok(reserve>=300,'Accounting daily reserve reached');
        await new Promise(r=>setTimeout(r,2100));
        const response=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{method:'GET',redirect:'error',
          headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
          signal:AbortSignal.timeout(30000)});
        assert.equal(response.status,200);if(response.headers.has('x-daylimit-remaining'))reserve=Number(response.headers.get('x-daylimit-remaining'));
        return response.json();
      };
      for(const c of cohort){
        const original=originals.find(p=>p.memberId===c.id);
        const old=original.membershipInvoices.find(i=>i.InvoiceNumber===c.invoice);
        assert.ok(old);
        const invoice=(await get(`Invoices/${old.InvoiceID}`)).Invoices[0];
        const contact=(await get(`Contacts/${invoice.Contact.ContactID}`)).Contacts[0];
        assert.equal(contact.ContactID,old.Contact.ContactID);
        const m=snapshot.members.find(m=>m.id===c.id),source=snapshot.sources.find(s=>s.id===c.id);
        assert.equal(contact.EmailAddress.trim().toLowerCase(),m.email.trim().toLowerCase());
        assert.ok(!contact.AccountNumber||contact.AccountNumber.trim()===source.preferences.ym_web_site_member_id.trim());
        assert.equal(invoice.InvoiceNumber,c.invoice);assert.equal(invoice.Status,'PAID');
        assert.equal(invoice.Type,'ACCREC');assert.equal(invoice.CurrencyCode,'GBP');
        assert.equal(invoice.AmountPaid,invoice.Total);assert.equal(invoice.AmountDue,0);
        assert.equal(invoice.AmountCredited||0,0);assert.equal((invoice.CreditNotes||[]).length,0);
        assert.ok(invoice.LineItems.every(l=>!(l.ValidationErrors||[]).length&&l.LineAmount>=0));
        const payments=[];for(const p of invoice.Payments||[])payments.push((await get(`Payments/${p.PaymentID}`)).Payments[0]);
        assert.ok(payments.length&&payments.every(p=>p.Status==='AUTHORISED'&&p.Amount>0&&p.Invoice.InvoiceID===invoice.InvoiceID));
        assert.equal(payments.reduce((sum,p)=>sum+p.Amount,0),invoice.Total);
        providers.push({memberId:c.id,latestPaidInvoiceId:invoice.InvoiceID,membershipInvoices:[invoice],payments,contacts:[contact]});
        if(providers.length%4===0)console.log(`Verified ${providers.length}/16; GETs=${requests}; dailyRemaining=${reserve}`);
      }
      save('evidence',{at:new Date().toISOString(),reviewHash,snapshot,providers,requests});
      console.log(JSON.stringify({prepared:16,GETRequests:requests,providerWrites:0}));return;
    }
    const evidence=read(`${root}/evidence.json`);
    assert.equal(evidence.reviewHash,reviewHash);assert.ok(Date.now()-Date.parse(evidence.at)<1800000);
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    await db.query(`LOCK TABLE member_membership_history,${tables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const before={};for(const t of tables)before[t]=await table(t);
    const histories=await table('member_membership_history'),sources=(await db.query(SOURCE_SQL,[TENANT])).rows;
    const fields=before.preference_field.filter(f=>f.name==='member_class'&&f.is_active&&f.entity_scope==='member');assert.equal(fields.length,1);
    const records=[];
    for(const c of cohort){
      const source=sources.find(s=>s.id===c.id),prior=evidence.snapshot.sources.find(s=>s.id===c.id);
      assert.deepEqual(source.preferences,prior.preferences);assert.equal(source.dd_evidence,prior.dd_evidence);
      assert.equal(source.duplicate_fields,false);
      assert.equal(source.preferences.member_class,c.class);
      assert.equal(source.preferences.ym_date_membership_expires,c.expiry.split('-').reverse().join('/'));
      assert.equal(source.preferences.membership_status,'Active');
      assert.deepEqual(before.member.find(m=>m.id===c.id),evidence.snapshot.members.find(m=>m.id===c.id));
      const configs=before.membership_tier_config.filter(x=>x.is_active&&x.structure_scope_type==='member'&&x.structure_field_id===fields[0].id
        &&x.structure_match_value===c.class&&x.effective_from<='2026-10-14'&&(!x.effective_to||x.effective_to>='2026-10-14'));
      assert.equal(configs.length,1);assert.deepEqual(configs[0],evidence.snapshot.configs.find(x=>x.id===configs[0].id));
      const provider=evidence.providers.find(p=>p.memberId===c.id);
      const record=buildRecord({memberId:c.id,memberClass:c.class,membershipAmount:c.amount,retainedExpiry:c.expiry,...endToDates(c.expiry)},configs[0],provider);
      const h=sha(`${reviewHash}:${c.id}:approved-annual`);
      record.id=c.id===adam?evidence.snapshot.history[0].id:`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
      const own=histories.filter(x=>x.member_id===c.id);
      assert.equal(own.length,mode==='replay'||c.id===adam?1:0);
      if(c.id===adam&&mode!=='replay')assert.deepEqual(own[0],evidence.snapshot.history[0]);
      const notes=JSON.parse(record.notes);
      record.notes=JSON.stringify({...notes,source:'bnms_approved_annual_reconstruction',reviewSha256:reviewHash,
        csvSha256:null,approval:'Owner approved all 15 and Adam; 12-month duration and current-class schedule reconstruction',
        termAuthority:'operator_approved_12_month_term_ending_on_retained_expiry',
        historicalScheduleCaveat:'Current schedule reconstructed by explicit owner assumption, not provider-confirmed historical terms.',
        historicalPaymentInstrument:'unknown; existing DD records left unchanged',
        paymentCoverageCaveat:'Provider confirms historical settlement; assignment to reconstructed coverage is administrator-approved, not a provider statement of coverage.',
        priorEvidence:c.id===adam?JSON.parse(evidence.snapshot.history[0].notes):null});
      if(mode==='replay')assertRecord(own[0],record);
      assert.ok(!histories.some(x=>x.accounting_invoice_id===record.accounting_invoice_id&&x.id!==record.id));
      records.push(record);
    }
    const scopeHash=canonicalHash({records,members:before.member.filter(m=>ids.has(m.id)),
      histories:histories.filter(h=>ids.has(h.member_id)),sources:sources.filter(s=>ids.has(s.id))});
    if(mode==='apply')assert.equal(read(`${root}/dry-run.json`).scopeHash,scopeHash);
    const input={members:before.member,fields:before.preference_field,preferences:before.member_preference_value,
      organizations:await table('organization'),roles:await table('role'),agreements:before.membership_billing_agreements,
      recognitions:MEMBERSHIP_RECOGNITION_TABLES.flatMap(t=>before[t]),reportDate:'2026-10-14'};
    const oldReport=projectNmcReport({...input,history:histories});
    save(`before-${mode}-${Date.now()}`,{before,histories,records,scopeHash});
    if(mode!=='replay')for(const record of records){
      const keys=Object.keys(record),values=keys.map(k=>record[k]!=null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]);
      if(record.member_id===adam){
        const result=await db.query(`update member_membership_history set ${keys.map((k,j)=>`${k}=$${j+1}`).join(',')} where id=$${keys.length+1} and tenant_id=$${keys.length+2}`,values.concat(record.id,TENANT));
        assert.equal(result.rowCount,1);
      }else await db.query(`insert into member_membership_history (${keys.join(',')}) values (${keys.map((_,j)=>`$${j+1}`).join(',')})`,values);
    }
    const after=await table('member_membership_history');
    for(const record of records){
      const actual=after.find(x=>x.id===record.id);assertRecord(actual,record);
      const display=shapePersistedCommitment(actual,new Date('2026-10-14T12:00:00Z'));
      assert.equal(display.lifecycle,'current');assert.equal(display.startDate,record.term_start_date);
      assert.equal(display.endDate,record.term_end_date);assert.equal(display.structureName,record.commitment_snapshot.config.name);
      assert.equal(display.agreedPrice,record.total_with_vat);
    }
    assert.equal(after.length-histories.length,mode==='replay'?0:15);
    assert.deepEqual(after.filter(h=>!ids.has(h.member_id)),histories.filter(h=>!ids.has(h.member_id)));
    for(const t of tables)assert.deepEqual(await table(t),before[t],`Protected data changed: ${t}`);
    const newReport=projectNmcReport({...input,history:after});
    assert.equal(newReport.sheets[0].count,oldReport.sheets[0].count);
    assert.equal(newReport.total-oldReport.total,mode==='replay'?0:15);
    for(const record of records)assert.equal(projectNmcReport({...input,members:input.members.filter(m=>m.id===record.member_id),history:after}).total,1);
    await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
    if(mode==='apply')for(const record of records)assertRecord((await db.query('select to_jsonb(h) data from member_membership_history h where id=$1',[record.id])).rows[0].data,record);
    const receipt={mode,committed:mode==='apply',scopeHash,newHistories:mode==='replay'?0:15,adamUpdated:mode!=='replay',
      printCount:newReport.sheets[0].count,totalBefore:oldReport.total,totalAfter:newReport.total,
      providerWrites:0,billingChanges:0};
    save(mode==='dry-run'?'dry-run':`${mode}-${Date.now()}`,receipt);console.log(JSON.stringify(receipt));
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
}
main().catch(e=>{console.error(JSON.stringify({stopped:true,code:e.code||e.name,
  reason:['ERR_ASSERTION','42703'].includes(e.code)?e.message.split('\n')[0]:'Repair stopped',
  location:e.stack?.split('\n').find(l=>l.includes('repair-bnms-approved-fifteen-and-adam.mjs:'))?.trim()}));process.exitCode=1;});
