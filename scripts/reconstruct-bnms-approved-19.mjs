// Narrow owner-approved recovery. Provider calls are GET-only; no billing entrypoints.
// verify -> dry-run <provider-file> -> apply <same-file> -> replay <same-file>.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { assessMember } from './bnms-live-xero-review-core.mjs';
import { overseasWordingAgrees } from './bnms-recovery-source-evidence.mjs';
import { TENANT, REVIEW_HASH, CSV_HASH, SOURCE_HASHES, sha, memberInvoice, financialProjection,
  approvedCandidates, assertAssessment, buildRecord, assertRecord, historyId, approvalState } from './bnms-approved-19-core.mjs';

const root = 'generated-artifacts/bnms-current-commitments';
const out = 'generated-artifacts/bnms-approved-19';
const read = path => JSON.parse(fs.readFileSync(path));
const save = (name, data) => {
  const path = `${out}/${name}.json`;
  fs.writeFileSync(path, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  return path;
};
async function main() {
  const mode = process.argv[2];
  assert.ok(['verify','dry-run','apply','replay'].includes(mode));
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const candidates = approvedCandidates(fs.readFileSync(`${root}/recovery-review.json`),
    fs.readFileSync(`${root}/BNMS-Membership-Recovery-162-14-10-2026.csv`));
  for (const [file, hash] of Object.entries(SOURCE_HASHES))
    assert.equal(sha(fs.readFileSync(`${root}/${file}`)), hash, 'Source evidence changed');
  const approval = read(`${root}/approval-19-pinned.json`);
  assert.equal(approval.status, 'owner_approved_all_19_exact_dates');
  assert.equal(approval.sourceReportSha256, REVIEW_HASH);
  assert.equal(approval.sourceCsvSha256, CSV_HASH);
  assert.deepEqual(approval.members, candidates.map(c => ({id:c.memberId,start:c.proposedStart,end:c.retainedExpiry})));
  const sources = read(`${root}/recovery-sources.json`).rows;
  const snapshot = read(`${root}/recovery-162.json`);
  const context = read(`${root}/snapshot.json`);
  const classFields = context.preference_field.filter(f => f.name === 'member_class' && f.entity_scope === 'member' && f.is_active);
  assert.equal(classFields.length, 1);
  const originals = [...read('generated-artifacts/bnms-remaining-84/members.json'),
    ...read('generated-artifacts/bnms-live-xero-150/members.json')];
  const reviewFor = c => {
    const s = sources.find(s => s.memberId === c.memberId);
    assert.ok(s);
    assert.equal(overseasWordingAgrees(s), c.aliasReconciled);
    // Check original file bytes too; the pinned row evidence determines the narrow wording reconciliation.
    for (const m of s.matches) assert.equal(sha(fs.readFileSync(m.file)), m.fileSha256, 'Original import changed');
    return {...s, sourceState: c.aliasReconciled ? 'source_fields_corroborated' : s.state,
      liveSource: snapshot.source.find(s => s.id === c.memberId), historicalDDDescription: false};
  };
  for (const c of candidates) {
    const p = originals.find(p => p.memberId === c.memberId);
    assert.ok(p);
    assertAssessment(assessMember({review:reviewFor(c),live:snapshot.source.find(s=>s.id===c.memberId),
      provider:p,configs:context.membership_tier_config,classFieldId:classFields[0].id}), c);
    assert.ok(!snapshot.invoices.some(i => i.member_id === c.memberId && /\bDD\b|direct debit/i.test(i.description || '')));
  }
  destinationTarget(process.env);
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  const { SOURCE_SQL, canonicalHash } = await import('./bnms-non-dd-apply.mjs');
  if (mode === 'verify') {
    const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
    const auth = await getValidXeroAccessToken(TENANT);
    assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
    const responses = [], providers = [];
    let last = 0;
    const get = async (resource, params={}) => {
      await new Promise(r=>setTimeout(r,Math.max(0,2100-(Date.now()-last))));
      last=Date.now();
      const url = `${resource}?${new URLSearchParams(params)}`;
      const res = await fetch(`https://api.xero.com/api.xro/2.0/${url}`, {
        headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
        signal:AbortSignal.timeout(30000)});
      assert.equal(res.status,200,'Xero read failed');
      const body=await res.json();
      responses.push({url,capturedAt:new Date().toISOString(),body});
      if(res.headers.has('x-daylimit-remaining')) assert.ok(Number(res.headers.get('x-daylimit-remaining'))>=300);
      return body;
    };
    const pages = async (resource,params,key) => {
      const rows=[],seen=new Set();
      for(let page=1;page<=100;page++){
        const body=await get(resource,{...params,page:String(page)});
        assert.ok(Array.isArray(body[key]));
        for(const row of body[key]){
          const id=row[key==='Contacts'?'ContactID':'InvoiceID'];
          assert.ok(id&&!seen.has(id));seen.add(id);rows.push(row);
        }
        if(body[key].length<100)return rows;
      }
      throw Error('Incomplete provider pagination');
    };
    for (const c of candidates) {
      const old=originals.find(p=>p.memberId===c.memberId);
      assert.equal(old.contacts.length,1);
      const account=reviewFor(c).liveSource.preferences.ym_web_site_member_id.trim();
      const contacts=await pages('Contacts',{where:
        `ContactID==Guid("${old.contacts[0].ContactID}") OR EmailAddress==${JSON.stringify(c.email.trim().toLowerCase())} OR AccountNumber==${JSON.stringify(account)}`,
        includeArchived:'true'},'Contacts');
      assert.equal(contacts.length,1,'Contact identity changed');
      assert.equal(contacts[0].ContactID,old.contacts[0].ContactID);
      assert.equal(contacts[0].EmailAddress?.trim().toLowerCase(),c.email.trim().toLowerCase());
      assert.equal(contacts[0].AccountNumber?.trim()||'',old.contacts[0].AccountNumber?.trim()||'');
      const invoices=await pages('Invoices',{ContactIDs:contacts[0].ContactID,where:'Type=="ACCREC"',order:'Date DESC'},'Invoices');
      assert.ok(invoices.every(i=>i.Contact?.ContactID===contacts[0].ContactID));
      const history=invoices.filter(memberInvoice).sort((a,b)=>String(b.DateString).localeCompare(String(a.DateString))||a.InvoiceID.localeCompare(b.InvoiceID));
      const latest=history.find(i=>!['VOIDED','DELETED','DRAFT'].includes(i.Status));
      const paid=history.find(i=>i.Status==='PAID');
      assert.equal(latest?.InvoiceID,old.latestInvoiceId);
      assert.equal(paid?.InvoiceID,old.latestPaidInvoiceId);
      assert.deepEqual(financialProjection(paid),financialProjection(old.membershipInvoices.find(i=>i.InvoiceID===old.latestPaidInvoiceId)));
      const payments=[];
      for(const p of paid.Payments||[]){
        const body=await get(`Payments/${p.PaymentID}`);
        assert.equal(body.Payments?.length,1);
        const live=body.Payments[0],prior=old.payments.find(x=>x.PaymentID===p.PaymentID);
        assert.ok(prior);
        for(const key of ['PaymentID','Status','Amount','Date','CurrencyRate','IsReconciled'])assert.deepEqual(live[key],prior[key]);
        assert.equal(live.Invoice?.InvoiceID,paid.InvoiceID);
        payments.push(live);
      }
      providers.push({...old,contacts,membershipInvoices:history,payments});
      console.log(`Verified ${providers.length}/19`);
    }
    console.log('PROVIDER_EVIDENCE '+save(`provider-${Date.now()}`,{
      reviewSha256:REVIEW_HASH,csvSha256:CSV_HASH,capturedAt:new Date().toISOString(),providers,responses,financialWrites:0}));
    return;
  }
  const evidencePath=process.argv[3];
  assert.ok(evidencePath?.startsWith(`${out}/provider-`)&&evidencePath.endsWith('.json'));
  const bytes=fs.readFileSync(evidencePath),evidence=JSON.parse(bytes),evidenceHash=sha(bytes);
  assert.equal(evidence.reviewSha256,REVIEW_HASH);assert.equal(evidence.csvSha256,CSV_HASH);
  assert.ok(Date.now()-Date.parse(evidence.capturedAt)>=0&&Date.now()-Date.parse(evidence.capturedAt)<30*60000);
  assert.equal(evidence.providers.length,19);assert.equal(new Set(evidence.providers.map(p=>p.memberId)).size,19);
  const dryPath=`${out}/dry-${evidenceHash}.json`;
  if(mode==='apply'){const dry=read(dryPath);assert.equal(dry.mode,'dry-run');assert.equal(dry.inserted,19);assert.equal(dry.evidenceHash,evidenceHash);}
  const {shapePersistedCommitment}=await import('../api/membership/member-membership.js');
  const {projectNmcReport}=await import('../api/_lib/nmcMembershipReport.js');
  const db=await connectDestination();
  try{
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SET LOCAL statement_timeout='90s'");
    const tables=['member','member_membership_history','member_preference_value','preference_field',
      'membership_tier_config','membership_billing_agreements','membership_payment_plans',
      'bnms_dd_alpha_adoption','bnms_dd_beta_adoption','bnms_dd_pilot_import','bnms_dd_historical_payment',
      'gocardless_customers','gocardless_mandate_discovery_row','membership_expiry_policy_assignment','organization','role'];
    await db.query(`LOCK TABLE ${tables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const readTable=async table=>(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE ${
      table==='member_preference_value'?'member_id IN (SELECT id FROM member WHERE tenant_id=$1)':'tenant_id=$1'} ORDER BY id`,[TENANT])).rows.map(r=>r.data);
    const before={};for(const table of tables)before[table]=await readTable(table);
    const liveSources=(await db.query(SOURCE_SQL,[TENANT])).rows;
    const records=[];
    for(const c of candidates){
      const provider=evidence.providers.find(p=>p.memberId===c.memberId);assert.ok(provider);
      const liveMember=before.member.find(m=>m.id===c.memberId);
      for(const [key,value]of Object.entries(snapshot.members.find(m=>m.id===c.memberId)))assert.deepEqual(liveMember?.[key],value);
      const own=before.member_membership_history.filter(h=>h.member_id===c.memberId);
      const existing=own.find(h=>h.id===historyId(c.memberId));
      assert.equal(own.length,existing?1:0,'Unreviewed history exists');
      if(mode==='replay')assert.ok(existing,'Replay cannot insert');
      if(mode==='apply')assert.equal(existing,undefined,'Already applied; use replay');
      const live={...liveSources.find(s=>s.id===c.memberId),history_count:own.length-(existing?1:0)};
      assert.deepEqual(live,snapshot.source.find(s=>s.id===c.memberId),'Live source changed');
      assert.equal(live.dd_evidence,false);assert.equal(live.duplicate_fields,false);
      const assessed=assessMember({review:reviewFor(c),live,provider,configs:before.membership_tier_config,classFieldId:classFields[0].id});
      assertAssessment(assessed,c);
      const config=before.membership_tier_config.find(x=>x.structure_field_id===classFields[0].id&&x.structure_match_value===c.memberClass&&x.name===c.structure&&x.is_active&&x.effective_from<='2026-10-14'&&(!x.effective_to||x.effective_to>='2026-10-14'));
      assert.ok(config);assert.deepEqual(config,context.membership_tier_config.find(x=>x.id===config.id));
      const record=buildRecord(c,config,provider,evidenceHash);
      if(existing)assertRecord(existing,record);
      records.push(record);
    }
    assert.equal(new Set(records.map(r=>r.accounting_invoice_id)).size,19);
    const beforeHash=canonicalHash(before),approvalStateHash=canonicalHash(approvalState(before,records));
    if(mode==='apply')assert.equal(read(dryPath).approvalStateHash,approvalStateHash,'Approved state changed after dry run');
    const journal=save(`before-${mode}-${Date.now()}`,{evidenceHash,beforeHash,before,records,approval});
    let inserted=0;
    for(const record of records){
      if(before.member_membership_history.some(h=>h.id===record.id))continue;
      assert.notEqual(mode,'replay');
      const keys=Object.keys(record);
      await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
        keys.map(k=>record[k]!=null&&typeof record[k]==='object'?JSON.stringify(record[k]):record[k]));
      inserted++;
    }
    const after=await readTable('member_membership_history'),details=[];
    for(const r of records){
      const actual=after.find(h=>h.id===r.id);assertRecord(actual,r);
      const display=shapePersistedCommitment(actual,new Date('2026-10-14T12:00:00Z'));
      assert.equal(display.structureName,r.commitment_snapshot.config.name);
      assert.equal(display.startDate,r.term_start_date);assert.equal(display.endDate,r.term_end_date);
      assert.equal(display.renewalDate,r.membership_renewal_date);assert.equal(display.agreedPrice,r.total_with_vat);
      assert.equal(display.lifecycle,'current');
      details.push({memberId:r.member_id,display});
    }
    const ids=new Set(candidates.map(c=>c.memberId));
    const project=history=>projectNmcReport({members:before.member.filter(m=>ids.has(m.id)),
      fields:before.preference_field,preferences:before.member_preference_value.filter(p=>ids.has(p.member_id)),
      history:history.filter(h=>ids.has(h.member_id)),organizations:before.organization,roles:before.role,
      agreements:before.membership_billing_agreements,reportDate:'2026-10-14'});
    const nmcBefore=project(before.member_membership_history),nmcAfter=project(after);
    assert.equal(nmcAfter.total,19);assert.deepEqual(nmcAfter.reviewCounts,{});
    assert.ok(nmcAfter.rows.every(r=>r.sheet==='Online-only'&&r.cells[12]==='Active'&&r.cells[13]===0));
    if(mode!=='replay'){assert.equal(nmcBefore.total,0);assert.equal(nmcBefore.reviewCounts.missing_membership_evidence,19);}
    const added=new Set(records.filter(r=>!before.member_membership_history.some(h=>h.id===r.id)).map(r=>r.id));
    assert.deepEqual(after.filter(h=>!added.has(h.id)),before.member_membership_history);
    for(const table of tables.filter(t=>t!=='member_membership_history'))assert.deepEqual(await readTable(table),before[table],`Unexpected change: ${table}`);
    if(mode==='replay')assert.equal(inserted,0);
    await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
    if(mode==='apply'){
      const persisted=await readTable('member_membership_history');
      for(const r of records)assertRecord(persisted.find(h=>h.id===r.id),r);
      assert.equal(project(persisted).total,19);
    }
    const receipt={mode,evidenceHash,beforeHash,approvalStateHash,inserted,committed:mode==='apply',
      financialWrites:0,otherTablesChanged:0,journal,at:new Date().toISOString(),details,nmcBefore,nmcAfter};
    const receiptPath=save(mode==='dry-run'?`dry-${evidenceHash}`:`receipt-${mode}-${Date.now()}`,receipt);
    if(mode==='replay'){
      const quote=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
      const csv=[['Member','Member ID','Member class unchanged','Approved start','Retained expiry',
        'Membership amount GBP','Paid Xero invoice','Membership detail','NMC report','Replay inserts'],
        ...candidates.map(c=>[c.name,c.memberId,c.memberClass,c.proposedStart,c.retainedExpiry,
          c.membershipAmount,c.invoiceNumber,'Current paid term','Active — Online-only',0])]
        .map(row=>row.map(quote).join(',')).join('\r\n');
      fs.writeFileSync(`${out}/BNMS-19-Restoration-Verified.csv`,'\uFEFF'+csv,{flag:'wx',mode:0o600});
    }
    console.log(JSON.stringify({mode,inserted,committed:receipt.committed,financialWrites:0,otherTablesChanged:0,nmcOnlineOnly:nmcAfter.total,receiptPath}));
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
}
main().catch(e=>{
  console.error(JSON.stringify({stopped:true,code:e.code||e.name,
    reason:e.code==='ERR_ASSERTION'?String(e.message).split('\n')[0]:'Operation failed; inspect private evidence',
    location:e.stack?.split('\n').find(l=>l.includes('scripts/reconstruct-bnms-approved-19.mjs:'))?.trim()}));
  process.exitCode=1;
});
