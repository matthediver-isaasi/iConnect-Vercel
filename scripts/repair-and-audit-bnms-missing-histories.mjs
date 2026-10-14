import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
import { SOURCE_SQL, canonicalHash } from './bnms-non-dd-apply.mjs';
import { legacyExpiry, classify } from './audit-bnms-non-dd-cohort.mjs';
import { NMC_TENANT as tenant,NMC_FIELDS,projectNmcReport } from '../api/_lib/nmcMembershipReport.js';
import { MEMBERSHIP_RECOGNITION_TABLES } from '../api/_lib/alphaMembershipRecognition.js';
import { INDIVIDUAL_HISTORY_SOURCE,isBnmsIndividualHistoricalAttestation } from '../api/_lib/bnmsIndividualHistoricalAttestation.js';
const mode=process.argv[2];assert.ok(['dry-run','apply'].includes(mode));
const id='eda44595-1c5d-4bf8-8395-8c75b19774b5',expiry='2026-08-27';
const historyId='c32e2104-2921-5b2d-a948-59caa9e62a31';
const dir='generated-artifacts/bnms-missing-history-review';fs.mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name,data)=>fs.writeFileSync(`${dir}/${name}`,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
const db=await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='120s'");
  await db.query('LOCK TABLE member_membership_history,member,member_preference_value,preference_field IN SHARE ROW EXCLUSIVE MODE');
  const read=async table=>(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1 ORDER BY id`,[tenant])).rows.map(r=>r.data);
  assert.equal((await db.query('SELECT slug FROM tenant WHERE id=$1',[tenant])).rows[0]?.slug,'bnms');
  const members=await read('member'), history=await read('member_membership_history');
  const sources=(await db.query(SOURCE_SQL,[tenant])).rows;
  const source=sources.find(r=>r.id===id),existing=history.find(h=>h.id===historyId);
  source.history_count-=existing?1:0;
  assert.equal(source.history_count,0);assert.equal(source.dd_evidence,false);
  assert.equal(source.preferences.member_class,'Full with NMC');
  assert.equal(source.preferences.membership_status,'Active');
  assert.equal(legacyExpiry(source.preferences.ym_date_membership_expires),expiry);
  const notes=JSON.stringify({source:INDIVIDUAL_HISTORY_SOURCE,version:1,memberId:id,expiry,
    approvalDate:'2026-10-14',scope:'historical_entitlement_only',sourceHash:canonicalHash(source),
    paymentAuthority:'operator_confirmed_paid',startDateAuthority:'unknown_not_inferred',
    invoiceAuthority:'not_verified_not_linked',expiryAuthority:'retained_legacy_expiry',
    historicalAmountAuthority:'unknown_not_inferred',currencyAuthority:'unknown_not_inferred'});
  const fields=(await read('preference_field')).filter(f=>f.entity_scope==='member'&&f.is_active&&NMC_FIELDS.includes(f.name));
  const preferences=(await db.query(`SELECT to_jsonb(p) data FROM member_preference_value p
    JOIN member m ON m.id=p.member_id WHERE m.tenant_id=$1 AND p.field_id=ANY($2::uuid[])`,
    [tenant,fields.map(f=>f.id)])).rows.map(r=>r.data);
  const input={members,fields,preferences,history,organizations:await read('organization'),
    roles:await read('role'),agreements:await read('membership_billing_agreements'),recognitions:[],
    reportDate:new Date().toISOString().slice(0,10)};
  for(const table of MEMBERSHIP_RECOGNITION_TABLES) input.recognitions.push(
    ...(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1`,[tenant])).rows.map(r=>r.data));
  const before=projectNmcReport(input);
  if(!existing){
    if(mode==='apply')save(`before-${Date.now()}.json`,{member:members.find(m=>m.id===id),source,history,notes});
    await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,membership_year,tier_label,term_start_date,term_end_date,
      status,payment_status,payment_method,billing_period,currency,notes,
      annual_cost,prorata_cost,free_period_discount,rollover_discount,custom_discount_total)
      VALUES ($1,$2,$3,'Legacy membership (start unknown)','Full Membership UK',NULL,$4,
      'expired','paid','upfront','annual',NULL,$5,NULL,NULL,NULL,NULL,NULL)`,[historyId,tenant,id,expiry,notes]);
  }
  const after=await read('member_membership_history'), repaired=after.find(h=>h.id===historyId);
  assert.ok(isBnmsIndividualHistoricalAttestation(repaired));
  assert.equal(repaired.status,'expired');assert.equal(repaired.notes,notes);
  assert.deepEqual(after.filter(h=>h.id!==historyId),history.filter(h=>h.id!==historyId));
  assert.equal(after.length,history.length+(existing?0:1));
  assert.deepEqual(await read('member'),members);
  const report=projectNmcReport({...input,history:after});
  assert.ok(report.rows.some(r=>r.memberId===id&&r.cells[12]==='Expired'));
  const missing=[];
  for(const member of members){
    const single=projectNmcReport({...input,history:after,members:[member]});
    if(!single.reviewCounts.missing_membership_evidence)continue;
    const s=sources.find(r=>r.id===member.id),p=s.preferences;
    const end=legacyExpiry(p.ym_date_membership_expires);
    const days=end?(Date.parse(input.reportDate)-Date.parse(end))/86400000:null;
    missing.push({memberId:member.id,name:[member.first_name,member.last_name].filter(Boolean).join(' '),
      email:member.email,memberClass:p.member_class,legacyStatus:p.membership_status||'',
      legacyExpiry:p.ym_date_membership_expires||'',expiry:end,
      legacyMembershipType:p.ym_membership_type||'',seedingClassification:classify(s),
      ddEvidence:s.dd_evidence,
      expiryGroup:!end?'Missing/invalid expiry':days<0?'Unexpired':days<=90?'Expired within 90 days':'Expired over 90 days',
      originallyInWindow:!!end&&end>='2026-09-22'&&end<='2026-12-31'});
  }
  const count=key=>Object.fromEntries([...new Set(missing.map(r=>String(r[key])))].map(k=>[k,missing.filter(r=>String(r[key])===k).length]));
  const summary={mode,inserted:mode==='apply'&&!existing?1:0,validated:!existing,replayed:!!existing,
    beforeMissing:before.reviewCounts.missing_membership_evidence,afterMissing:report.reviewCounts.missing_membership_evidence,
    reportSheets:report.sheets,byExpiry:count('expiryGroup'),byStatus:count('legacyStatus'),byClass:count('memberClass'),
    ddEvidence:count('ddEvidence'),originalWindow:count('originallyInWindow'),
    seedingClassification:count('seedingClassification'),
    activeBreakdown:missing.filter(r=>r.legacyStatus==='Active').reduce((a,r)=>{const key=`${r.expiryGroup}; ${r.ddEvidence?'DD evidence':'No DD evidence'}`;a[key]=(a[key]||0)+1;return a;},{})};
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  if(mode==='apply'){
    assert.deepEqual((await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1',[historyId])).rows[0].data,repaired);
    save(`receipt-${Date.now()}.json`,{summary,repaired,missing});
    const keys=Object.keys(missing[0]||{});
    const cell=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
    fs.writeFileSync(`${dir}/BNMS-missing-membership-evidence-2026-10-14.csv`,
      '\uFEFF'+[keys,...missing.map(r=>keys.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n'),{mode:0o600});
  }
  console.log(JSON.stringify(summary));
}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
