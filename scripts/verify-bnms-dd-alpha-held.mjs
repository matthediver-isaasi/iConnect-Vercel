#!/usr/bin/env node
// Read-only DEST reconciliation. Injected auth contexts are not deployed sessions.
import assert from 'node:assert/strict';
import {readFile,mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
const {TENANT_ID,MEMBER_ID,MANDATE_ID}=await import('./bnms-dd-pilot.mjs');
const {hash,sqlHash}=await import('./bnms-dd-beta-invoices.mjs');
const {verifyAlphaSchema}=await import('./bnms-dd-alpha-adoption.mjs');
const {createClient}=await import('@supabase/supabase-js');
const {createHistoricalDdHandler}=await import('../api/membership/historical-dd.js');
const {default:ExcelJS}=await import('exceljs');
const manifestPath=process.argv[2],out=resolve(process.argv[3]||'');
if(!manifestPath||!out.startsWith(`${resolve('exports')}/`))throw Error('Reviewed manifest and private exports directory required');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
assert.equal(hash(manifest),'3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a');
const c=await destinationConnection();await c.connect();
const checks=[],projections=[];let baseline;
try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const rows=async(sql,args=[])=>(await c.query(sql,args)).rows;
  await verifyAlphaSchema(c,sqlHash(await readFile('supabase/migrations/20261113_bnms_dd_alpha_held.sql','utf8')));
  const adoptions=await rows(`SELECT a.*,to_jsonb(p) AS plan,to_jsonb(b) AS agreement,to_jsonb(h) AS history,
    to_jsonb(m) AS member FROM bnms_dd_alpha_adoption a JOIN membership_payment_plans p ON p.id=a.plan_id
    JOIN membership_billing_agreements b ON b.id=a.agreement_id JOIN member_membership_history h ON h.id=a.history_id
    JOIN member m ON m.id=a.member_id WHERE a.tenant_id=$1`,[TENANT_ID]);
  assert.equal(adoptions.length,manifest.members.length);
  const history=await rows('SELECT *,charge_date::text AS charge_date FROM bnms_dd_alpha_provider_history WHERE tenant_id=$1 ORDER BY id',[TENANT_ID]);
  const links=await rows('SELECT * FROM bnms_dd_alpha_invoice_link WHERE tenant_id=$1 ORDER BY history_id',[TENANT_ID]);
  const originalMembers=JSON.parse(JSON.stringify(await rows('SELECT * FROM member WHERE id=ANY($1)',[manifest.members.map(x=>x.identity.memberId)])));
  const reservations=await rows(`SELECT r.id FROM gocardless_collection_reservations r JOIN bnms_dd_alpha_adoption a
    ON r.plan_id=a.plan_id OR r.billing_agreement_id=a.agreement_id WHERE a.tenant_id=$1`,[TENANT_ID]);
  const mutable=await rows(`SELECT p.id FROM gocardless_payments p JOIN bnms_dd_alpha_adoption a
    ON p.gocardless_mandate_id=a.mandate_id WHERE a.tenant_id=$1`,[TENANT_ID]);
  assert.equal(reservations.length,0);assert.equal(mutable.length,0);
  for(const expected of manifest.members){
    const a=adoptions.find(r=>r.member_id===expected.identity.memberId);assert.ok(a);
    const {plan:p,agreement:b,history:h,member}=a;
    assert.equal(hash(a.evidence),hash(expected));assert.equal(a.manifest_sha256,hash(manifest));
    assert.equal(hash(originalMembers.find(x=>x.id===a.member_id)),hash(expected.sourceMember),'Existing member unchanged');
    for(const r of [a,p,b,h,member])assert.equal(r.tenant_id,TENANT_ID);
    for(const r of [p,b,h])assert.equal(r.member_id,a.member_id);
    assert.equal(p.billing_agreement_id,b.id);assert.equal(h.billing_agreement_id,b.id);
    assert.equal(p.status,'first_payment_pending');assert.equal(b.status,'first_payment_pending');
    assert.equal(h.status,'pending_payment_setup');assert.equal(h.payment_status,'unpaid');
    assert.ok(p.collection_stopped_at);assert.equal(p.metadata.bnms_release_required,true);
    assert.equal(p.metadata.collection_mode,'dynamic');assert.equal(p.gocardless_subscription_id,null);
    assert.equal(p.start_date,'2026-10-01');assert.equal(p.dynamic_next_collection_date,'2026-10-01');
    assert.equal(p.day_of_month,1);assert.equal(p.amount_minor,expected.monthlyQuoteMinor);
    assert.equal(hash(b.metadata.dd),hash(expected.dd));
    for(const key of ['plan_total','final_cost','total_with_vat'])assert.equal(b.metadata.dd[key],null);
    assert.equal(h.term_start_date,'2026-10-01');assert.equal(h.term_end_date,'2027-09-30');
    assert.equal(h.final_cost,null);assert.equal(h.total_with_vat,null);
    assert.equal(b.term_start_date,h.term_start_date);assert.equal(b.term_end_date,h.term_end_date);
    const hs=history.filter(x=>x.adoption_id===a.id),ls=links.filter(x=>x.member_id===a.member_id);
    assert.equal(hs.length,expected.history.length);assert.equal(ls.length,expected.links.length);
    assert.equal(hash(hs.map(x=>x.evidence)),hash(expected.history.map(x=>x.evidence)));
    assert.equal(hash(ls),hash(expected.links));
    assert.ok(hs.every(x=>x.tenant_id===TENANT_ID&&x.member_id===a.member_id&&x.provider_status==='paid_out'
      &&x.charge_date>='2026-01-01'&&x.charge_date<'2026-10-01'));
    checks.push({memberId:a.member_id,email:expected.identity.email,agreementId:b.id,planId:p.id,membershipId:h.id,
      membershipClass:expected.structure.structure_match_value,historicalPayments:hs.length,invoiceLinks:ls.length,
      held:true,termStart:h.term_start_date,termEnd:h.term_end_date,reservations:0,mutablePayments:0});
    projections.push({member,expected});
  }
  const beta=(await rows('SELECT count(*)::int n FROM bnms_dd_beta_adoption WHERE tenant_id=$1',[TENANT_ID]))[0].n;
  const betaHistory=(await rows('SELECT count(*)::int n FROM bnms_dd_beta_provider_history WHERE tenant_id=$1',[TENANT_ID]))[0].n;
  const pilotHistory=(await rows('SELECT count(*)::int n FROM bnms_dd_historical_payment WHERE member_id=$1 AND tenant_id=$2',[MEMBER_ID,TENANT_ID]))[0].n;
  const pilot=(await rows('SELECT count(*)::int n FROM membership_billing_agreements WHERE member_id=$1 AND tenant_id=$2 AND gocardless_mandate_id=$3',[MEMBER_ID,TENANT_ID,MANDATE_ID]))[0].n;
  assert.equal(beta,10);assert.equal(betaHistory,221);assert.equal(pilotHistory,9);assert.equal(pilot,1);
  baseline={betaMembers:beta,betaHistoricalPayments:betaHistory,pilotHistoricalPayments:pilotHistory,pilotCanonicalAgreements:pilot,
    limitation:'Known baseline counts/identity verified; not a complete pre-import state hash.'};
  await c.query('ROLLBACK');
}finally{await c.end();}
const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const responses=[];
for(let offset=0;offset<projections.length;offset+=5){
  await Promise.all(projections.slice(offset,offset+5).map(async({member,expected})=>{
    for(const actor of ['authorized_self_projection','authorized_tenant_admin_projection']){
      const admin=actor==='authorized_tenant_admin_projection';
      const handler=createHistoricalDdHandler({db,getSessionMember:async()=>admin?null:member,
        getTenantContext:async()=>({isAuthenticated:true,tenantId:TENANT_ID,tenantUserId:admin?'test-context-only':null}),
        hasAdminAccess:async()=>admin,hasFeatureAccess:async()=>true});
      let status=200,body;
      await handler({method:'GET',query:{memberId:member.id}},{setHeader(){},status(n){status=n;return this;},json(x){body=x;return this;}});
      assert.equal(status,200,`Handler projection returned ${status}`);
      assert.equal(body.payments.length,expected.history.length);
      assert.deepEqual(body.payments.map(x=>x.provider_payment_id).sort(),expected.history.map(x=>x.provider_payment_id).sort());
      for(const p of body.payments){
        const link=expected.links.find(x=>x.history_id===p.id);
        assert.ok(link);assert.equal(p.xero_invoice_id,link.xero_invoice_id);
        assert.equal(p.source,'alpha_provider_history');assert.equal(p.invoice_available,true);
        assert.equal(p.accounting_reconciled,true);assert.equal(p.historical_only,true);
      }
      responses.push({memberId:member.id,actor,status,payments:body.payments.length,allInvoicesAvailable:true});
    }
  }));
}
const report={observedAt:new Date().toISOString(),mode:'persisted_alpha_read_only_verification',manifestSha256:hash(manifest),
  schemaApplied:true,importedMembers:checks.length,historicalPayments:checks.reduce((n,x)=>n+x.historicalPayments,0),
  invoiceLinks:checks.reduce((n,x)=>n+x.invoiceLinks,0),heldPlans:checks.length,reservations:0,mutablePayments:0,
  providerWrites:0,collectionsReleased:false,checks,exceptions:manifest.exceptions,baseline,handlerProjections:responses,
  authVerification:'Injected authorized self/admin contexts against real DEST data; not deployed-session/browser verification.'};
await mkdir(out,{recursive:true,mode:0o700});
async function save(name,bytes){const f=await open(`${out}/${name}`,'wx',0o600);try{await f.writeFile(bytes);}finally{await f.close();}}
await save('verification.json',JSON.stringify(report,null,2));
const wb=new ExcelJS.Workbook(),summary=wb.addWorksheet('Summary'),members=wb.addWorksheet('Imported memberships'),exceptions=wb.addWorksheet('Exceptions');
summary.addRows([['BNMS alpha import','Completed and persisted; collections HELD'],['Verified at',report.observedAt],
  ['Memberships created',checks.length],['Historical payments / existing invoices',report.invoiceLinks],['Historical dates','2026-01-01 inclusive to 2026-10-01 exclusive'],
  ['Term','2026-10-01 to 2027-09-30; unpaid; first-payment activation'],['Pricing','Dynamic current membership class; continuation'],
  ['Exceptions',manifest.exceptions.length],['Collections released',false],['New provider charges/invoices/emails',0],
  ['Reservation / mutable historical payment rows',0],['Handler projections',responses.length],['Projection limitation',report.authVerification],
  ['Manifest SHA256',hash(manifest)],['Prior entitlement','Unknown and unchanged; no current activation']]);
summary.columns=[{width:44},{width:110}];
members.columns=Object.keys(checks[0]).map(key=>({header:key,key,width:key.includes('Id')||key==='email'?40:25}));members.addRows(checks);
const exceptionRows=manifest.exceptions.map(x=>({memberId:x.identity?.memberId||'',email:x.identity?.email||'',mandateId:x.mandateId||'',reasons:x.reasons.join('; ')}));
exceptions.columns=Object.keys(exceptionRows[0]).map(key=>({header:key,key,width:key==='reasons'?110:40}));exceptions.addRows(exceptionRows);
for(const s of wb.worksheets){s.views=[{state:'frozen',ySplit:1}];s.eachRow(r=>{r.font={name:'Arial',size:10};r.alignment={vertical:'top',wrapText:true};});}
await save('BNMS-alpha-completed.xlsx',Buffer.from(await wb.xlsx.writeBuffer()));
const csvCell=v=>`"${String(v??'').replace(/"/g,'""').replace(/^([=+\-@\t\r])/,"'$1")}"`;
for(const [name,rows] of [['BNMS-alpha-imported.csv',checks],['BNMS-alpha-exceptions.csv',exceptionRows]]){
  const keys=Object.keys(rows[0]);await save(name,[keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n');
}
const reopened=new ExcelJS.Workbook();await reopened.xlsx.readFile(`${out}/BNMS-alpha-completed.xlsx`);
assert.equal(reopened.getWorksheet('Imported memberships').rowCount,checks.length+1);
assert.equal(reopened.getWorksheet('Exceptions').rowCount,manifest.exceptions.length+1);
assert.equal(JSON.parse(await readFile(`${out}/verification.json`)).importedMembers,checks.length);
console.log(JSON.stringify({importedMembers:checks.length,invoiceLinks:report.invoiceLinks,handlerProjections:responses.length,baseline,out,writes:0}));