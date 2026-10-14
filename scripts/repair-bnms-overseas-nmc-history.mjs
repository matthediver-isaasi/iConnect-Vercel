// One explicitly approved overseas member. No provider or application services.
// Run dry-run before apply; a repeated apply validates and inserts nothing.
import assert from 'node:assert/strict';
import { SOURCE_SQL, canonicalHash } from './bnms-non-dd-apply.mjs';
import { classify, legacyExpiry } from './audit-bnms-non-dd-cohort.mjs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { UNEXPIRED_SOURCE, isBnmsUnexpiredAttestation } from '../api/_lib/bnmsUnexpiredAttestation.js';
import { NMC_TENANT as tenant, NMC_FIELDS, projectNmcReport } from '../api/_lib/nmcMembershipReport.js';
import { MEMBERSHIP_RECOGNITION_TABLES } from '../api/_lib/alphaMembershipRecognition.js';

const memberId = 'ecbe925e-937d-46f7-a7eb-94a8e6741d88';
const expiry = '2027-07-08';
const mode = process.argv[2] || 'dry-run';
if (!['dry-run', 'apply'].includes(mode)) throw Error('Expected dry-run or apply');
const digest = canonicalHash(`${UNEXPIRED_SOURCE}:${memberId}`);
const historyId = `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='120s'");
  await db.query(`LOCK TABLE member,member_preference_value,preference_field,member_membership_history,
    membership_billing_agreements,membership_payment_plans,gocardless_customers,
    gocardless_mandate_discovery_row,bnms_dd_alpha_adoption,bnms_dd_beta_adoption,
    bnms_dd_pilot_import,bnms_dd_historical_payment IN SHARE ROW EXCLUSIVE MODE`);
  const read = async (table, where = 'tenant_id=$1', params = [tenant]) =>
    (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE ${where} ORDER BY id`, params)).rows.map(r => r.data);
  assert.equal((await db.query('SELECT slug FROM tenant WHERE id=$1', [tenant])).rows[0]?.slug, 'bnms');
  const original = await read('member_membership_history');
  const existing = original.find(r => r.id === historyId);
  const source = (await db.query(SOURCE_SQL, [tenant])).rows.find(r => r.id === memberId);
  assert.ok(source, 'Member source missing');
  source.history_count -= existing ? 1 : 0;
  assert.equal(classify(source), 'requires_term_and_invoice_review');
  assert.equal(source.history_count, 0, 'Unexpected membership history');
  assert.equal(source.preferences.member_class, 'Overseas Full with NMC');
  assert.equal(source.preferences.ym_membership_type, 'Full Membership Overseas');
  assert.equal(legacyExpiry(source.preferences.ym_date_membership_expires), expiry);
  const notes = JSON.stringify({
    source: UNEXPIRED_SOURCE, version: 1, memberId, expiry,
    sourceHash: canonicalHash(source), approvalDate: '2026-10-14',
    approvalScope: 'single_overseas_nmc_member',
    paymentAuthority: 'operator_confirmed_paid', startDateAuthority: 'unknown_not_inferred',
    expiryAuthority: 'retained_legacy_expiry', invoiceAuthority: 'not_verified_not_linked',
    historicalAmountAuthority: 'unknown_not_inferred', currencyAuthority: 'unknown_not_inferred',
  });
  const members = await read('member');
  const fields = await read('preference_field', "tenant_id=$1 AND entity_scope='member' AND is_active=true AND name=ANY($2)", [tenant,NMC_FIELDS]);
  const preferences = await read('member_preference_value', 'member_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])',
    [members.map(m => m.id), fields.map(f => f.id)]);
  const organizations = await read('organization');
  const agreements = await read('membership_billing_agreements');
  const roles = await read('role');
  const recognitions = [];
  for (const table of MEMBERSHIP_RECOGNITION_TABLES) {
    recognitions.push(...(await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1`, [tenant])).rows.map(r=>r.data));
  }
  const reportDate = new Date().toISOString().slice(0,10);
  const input = {members, fields, preferences, organizations, agreements, roles, recognitions, reportDate};
  const before = projectNmcReport({...input, history: original});
  if (!existing) {
    const targetBefore = projectNmcReport({...input,members:members.filter(m=>m.id===memberId),history:original});
    assert.equal(targetBefore.reviewCounts.missing_membership_evidence, 1);
    await db.query(`INSERT INTO member_membership_history
      (id,tenant_id,member_id,membership_year,tier_label,term_start_date,term_end_date,
       status,payment_status,payment_method,billing_period,currency,notes,
       annual_cost,prorata_cost,free_period_discount,rollover_discount,custom_discount_total)
      VALUES ($1,$2,$3,'Legacy membership (start unknown)',$4,NULL,$5,
        'active','paid','upfront','annual',NULL,$6,NULL,NULL,NULL,NULL,NULL)`,
    [historyId,tenant,memberId,source.preferences.ym_membership_type,expiry,notes]);
  } else {
    assert.equal(existing.notes, notes, 'Replay provenance mismatch');
  }
  const after = await read('member_membership_history');
  const inserted = after.find(r=>r.id===historyId);
  assert.ok(isBnmsUnexpiredAttestation(inserted));
  assert.equal(inserted.notes, notes);
  for (const key of ['currency','paid_at','accounting_invoice_id','xero_invoice_id','annual_cost',
    'final_cost','total_with_vat','renewal_policy_snapshot','membership_renewal_date','commitment_snapshot']) {
    assert.equal(inserted[key], null, `Unexpected ${key}`);
  }
  const oldIds = new Set(original.map(r=>r.id));
  assert.deepEqual(after.filter(r=>oldIds.has(r.id)), original, 'Existing history changed');
  assert.equal(after.length, original.length + (existing ? 0 : 1));
  const target = projectNmcReport({...input,members:members.filter(m=>m.id===memberId),history:after});
  assert.equal(target.total, 1);
  assert.equal(target.sheets[0].count, 1);
  const finalReport = projectNmcReport({...input,history:after});
  assert.equal(finalReport.sheets[0].count, before.sheets[0].count + (existing ? 0 : 1));
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({mode,inserted:mode==='apply'&&!existing?1:0,
    validatedInserts:existing?0:1,replayed:!!existing,existingHistoryUnchanged:true,
    memberIncluded:true,reportDate,fullJuniorBefore:before.sheets[0].count,
    fullJuniorAfter:finalReport.sheets[0].count}));
} catch(e) {
  await db.query('ROLLBACK');
  throw e;
} finally { await db.end(); }
