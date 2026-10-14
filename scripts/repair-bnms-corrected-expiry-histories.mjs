// Pinned, owner-approved historical entitlement repair. No provider clients.
// dry-run performs real inserts and rolls them back; apply is idempotent.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SOURCE_SQL, canonicalHash } from './bnms-non-dd-apply.mjs';
import { classify, legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { CORRECTED_EXPIRY_SOURCE, CORRECTED_EXPIRY_COHORT, CORRECTED_EXPIRY_APPROVAL_DATE,
  isBnmsCorrectedExpiryAttestation } from '../api/_lib/bnmsCorrectedExpiryAttestation.js';
import { isAttestedExpiryOnlyHistory } from '../api/_lib/expiryOnlyRenewalPolicy.js';
import { NMC_TENANT as tenant, NMC_FIELDS, projectNmcReport } from '../api/_lib/nmcMembershipReport.js';
import { MEMBERSHIP_RECOGNITION_TABLES } from '../api/_lib/alphaMembershipRecognition.js';

const mode=process.argv[2] || 'dry-run';
assert.ok(['dry-run','apply'].includes(mode));
const manifest=JSON.parse(await readFile('/tmp/bnms-96-current-review.json','utf8'));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
assert.equal(sha(manifest.rows),'57fc71422a8a1cc070b7326d34052a10a98e1432e7962987b9f674458cb17523');
assert.equal(manifest.rows.length,96);
assert.equal(new Set(manifest.rows.map(r=>r.id)).size,96);
const contract=manifest.rows.map(r=>({memberId:r.id,expiry:r.expiry,
  method:r.dd_evidence?'direct_debit':'upfront'})).sort((a,b)=>a.memberId.localeCompare(b.memberId));
assert.equal(sha(contract),CORRECTED_EXPIRY_COHORT);
assert.equal(contract.filter(r=>r.expiry>=CORRECTED_EXPIRY_APPROVAL_DATE).length,66);
assert.equal(contract.filter(r=>r.method==='direct_debit').length,6);
assert.ok(!contract.some(r=>r.memberId==='eda44595-1c5d-4bf8-8395-8c75b19774b5'));
const historyId=memberId=>{
  const h=canonicalHash(`${CORRECTED_EXPIRY_SOURCE}:${memberId}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
const db=await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='120s'");
  await db.query(`LOCK TABLE member,member_preference_value,preference_field,member_membership_history,
    membership_billing_agreements,membership_payment_plans,gocardless_customers,
    gocardless_mandate_discovery_row,bnms_dd_alpha_adoption,bnms_dd_beta_adoption,
    bnms_dd_pilot_import,bnms_dd_historical_payment IN SHARE ROW EXCLUSIVE MODE`);
  assert.equal((await db.query('SELECT slug FROM tenant WHERE id=$1',[tenant])).rows[0]?.slug,'bnms');
  const read=async(table,where='tenant_id=$1',args=[tenant])=>
    (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE ${where} ORDER BY id`,args)).rows.map(r=>r.data);
  const protectedSnapshot=async()=>{
    const result={};
    for(const table of ['member','membership_billing_agreements','membership_payment_plans',
      'gocardless_payments','membership_expiry_policy_assignment','historical_member_invoice']) {
      result[table]=(await db.query(`SELECT count(*)::int n,
        md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY id),'')) hash
        FROM ${table} r WHERE tenant_id=$1`,[tenant])).rows[0];
    }
    result.preferences=(await db.query(`SELECT count(*)::int n,
      md5(coalesce(string_agg(md5(to_jsonb(v)::text),'' ORDER BY v.id),'')) hash
      FROM member_preference_value v JOIN member m ON m.id=v.member_id WHERE m.tenant_id=$1`,[tenant])).rows[0];
    return result;
  };
  const protectedBefore=await protectedSnapshot();
  const original=await read('member_membership_history');
  const source=(await db.query(SOURCE_SQL,[tenant])).rows;
  const members=await read('member');
  const fields=await read('preference_field',"tenant_id=$1 AND entity_scope='member' AND is_active=true AND name=ANY($2)",[tenant,NMC_FIELDS]);
  const preferences=await read('member_preference_value','member_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])',
    [members.map(r=>r.id),fields.map(f=>f.id)]);
  const organizations=await read('organization'),agreements=await read('membership_billing_agreements'),roles=await read('role');
  const recognitions=[];
  for(const table of MEMBERSHIP_RECOGNITION_TABLES) {
    recognitions.push(...(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1`,[tenant])).rows.map(r=>r.data));
  }
  const input={members,fields,preferences,organizations,agreements,roles,recognitions,reportDate:CORRECTED_EXPIRY_APPROVAL_DATE};
  const before=projectNmcReport({...input,history:original});
  const pending=[];
  let replayed=0;
  for(const pinned of manifest.rows) {
    const id=historyId(pinned.id);
    const existing=original.find(r=>r.id===id);
    const live=source.find(r=>r.id===pinned.id);
    assert.ok(live);
    const normalized={...live,history_count:live.history_count-(existing?1:0)};
    normalized.category=classify(normalized);
    normalized.expiry=legacyExpiry(normalized.preferences.ym_date_membership_expires);
    assert.equal(canonicalHash(normalized),canonicalHash(pinned),'Member evidence changed since approval');
    assert.equal(normalized.history_count,0);
    const member=members.find(m=>m.id===pinned.id);
    assert.ok(member && !member.is_sample && !member.is_test && !member.is_guest
      && member.status!=='deleted' && !member.deleted_at && !member.anonymized_at,'Ineligible member');
    const notes=JSON.stringify({
      source:CORRECTED_EXPIRY_SOURCE,version:1,cohortHash:CORRECTED_EXPIRY_COHORT,
      approvalDate:CORRECTED_EXPIRY_APPROVAL_DATE,scope:'historical_entitlement_only',
      memberId:pinned.id,expiry:pinned.expiry,sourceHash:canonicalHash(pinned),
      ddEvidenceRecorded:pinned.dd_evidence,
      paymentAuthority:'operator_confirmed_paid',startDateAuthority:'unknown_not_inferred',
      expiryAuthority:'retained_corrected_legacy_expiry',invoiceAuthority:'not_verified_not_linked',
      historicalAmountAuthority:'unknown_not_inferred',currencyAuthority:'unknown_not_inferred',
    });
    const status=pinned.expiry<CORRECTED_EXPIRY_APPROVAL_DATE?'expired':'active';
    if(existing) {
      assert.ok(isBnmsCorrectedExpiryAttestation(existing));
      assert.equal(existing.notes,notes);
      assert.equal(existing.status,status);
      replayed++;
    } else {
      pending.push({id,member_id:pinned.id,tier_label:pinned.preferences.ym_membership_type,
        expiry:pinned.expiry,status,method:pinned.dd_evidence?'direct_debit':'upfront',notes});
    }
  }
  if(mode==='apply' && pending.length) {
    // Retain both the pinned source and exact proposed rows privately before writing.
    await writeFile('generated-artifacts/bnms-corrected-expiry-history-repair-before.json',
      JSON.stringify({tenant,cohortHash:CORRECTED_EXPIRY_COHORT,source:manifest.rows,pending,protectedBefore},null,2),
      {flag:'wx',mode:0o600});
  }
  if(pending.length) {
    const inserted=await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,membership_year,tier_label,term_start_date,term_end_date,
       status,payment_status,payment_method,billing_period,currency,notes,
       annual_cost,prorata_cost,free_period_discount,rollover_discount,custom_discount_total)
      SELECT p.id,$2,p.member_id,'Legacy membership (start unknown)',p.tier_label,NULL,p.expiry,
        p.status,'paid',p.method,'annual',NULL,p.notes,NULL,NULL,NULL,NULL,NULL
      FROM jsonb_to_recordset($1::jsonb) AS p(id uuid,member_id uuid,tier_label text,
        expiry date,status text,method text,notes text) RETURNING id`,
      [JSON.stringify(pending),tenant]);
    assert.equal(inserted.rowCount,pending.length);
  }
  const after=await read('member_membership_history');
  const oldIds=new Set(original.map(r=>r.id));
  assert.deepEqual(after.filter(r=>oldIds.has(r.id)),original,'Existing history changed');
  assert.equal(after.length,original.length+pending.length);
  assert.deepEqual(await protectedSnapshot(),protectedBefore,'Non-history records changed');
  const repaired=after.filter(h=>contract.some(c=>historyId(c.memberId)===h.id));
  assert.equal(repaired.length,96);
  assert.equal(repaired.filter(h=>h.status==='active').length,66);
  assert.equal(repaired.filter(h=>h.status==='expired').length,30);
  for(const h of repaired) {
    assert.ok(isBnmsCorrectedExpiryAttestation(h));
    assert.equal(isAttestedExpiryOnlyHistory(h,tenant),false,'Unexpected renewal authority');
  }
  const finalReport=projectNmcReport({...input,history:after});
  const cohortReport=projectNmcReport({...input,members:members.filter(m=>contract.some(c=>c.memberId===m.id)),history:after});
  assert.equal(cohortReport.total,78);
  assert.equal(cohortReport.excludedCounts.expired_over_90_days,18);
  assert.deepEqual(cohortReport.reviewCounts,{});
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  const result={mode,inserted:mode==='apply'?pending.length:0,validatedInserts:pending.length,replayed,
    active:66,expired:30,existingHistoryUnchanged:true,nonHistoryRecordsUnchanged:true,
    reportBefore:before.sheets.map(s=>({name:s.name,count:s.count})),
    reportAfter:finalReport.sheets.map(s=>({name:s.name,count:s.count})),
    repairedMembersIncludedInNmc:cohortReport.total,expiredBeyond90Days:18,
    cohortHash:CORRECTED_EXPIRY_COHORT};
  if(mode==='apply') {
    const verified=await read('member_membership_history','tenant_id=$1 AND id=ANY($2::uuid[])',
      [tenant,contract.map(c=>historyId(c.memberId))]);
    assert.deepEqual(verified,repaired);
    await writeFile(`generated-artifacts/bnms-corrected-expiry-history-${pending.length?'applied':'replay'}.json`,
      JSON.stringify(result,null,2),{mode:0o600});
  }
  console.log(JSON.stringify(result));
} catch(error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
