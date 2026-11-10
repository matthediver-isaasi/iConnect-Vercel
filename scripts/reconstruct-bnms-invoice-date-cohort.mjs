import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';
import { TENANT, hash, reviewMember } from './lib/bnms-invoice-date-repair.mjs';
import { assessFormMembershipRenewalEvidence } from '../api/_lib/formMembershipRenewalEvidence.js';
import { redact } from './capture-bnms-all-renewal.mjs';

const root = 'generated-artifacts/bnms-invoice-date-repair';
const mode = process.argv[2];
assert(['review', 'dry-run', 'apply', 'verify'].includes(mode));
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const snapshot = JSON.parse(await fs.readFile(`${root}/baseline-snapshot.json`, 'utf8'));
const evidence = JSON.parse(await fs.readFile(`${root}/baseline-evidence.json`, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const t = snapshot.tables;
const selected = evidence.rows.filter(r => !r.exclusion && r.issues.some(i => i.code === 'renewal_admission_review'));
const own = (table, memberId) => (t[table] || []).filter(r => r.member_id === memberId);
const plan = selected.map(r => reviewMember(t.member.find(m => m.id === r.memberId),
  own('member_membership_history', r.memberId), own('historical_member_invoice', r.memberId),
  t.membership_tier_config, { memberClass: r.memberClass }, {
    agreements: own('membership_billing_agreements', r.memberId), plans: own('membership_payment_plans', r.memberId),
    quotes: own('membership_payment_quote', r.memberId), elections: own('membership_successor_election', r.memberId),
  }, today));
const digest = hash(plan);
const candidates = plan.filter(p => p.state === 'candidate');
if (mode === 'review') {
  await fs.writeFile(`${root}/plan.json`, JSON.stringify({ digest, today, plan }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ digest, reviewed: plan.length, candidates: candidates.length,
    rows: candidates.map(c => ({ memberId: c.memberId, terms: c.repairs.map(r => ({ invoice: r.invoice.invoice_number,
      start: r.start, end: r.end, kind: r.kind, schedule: r.config.name })) })),
    held: plan.filter(p => p.state === 'held').map(p => ({ member: p.memberId, reason: p.reason })) }, null, 2));
} else {
  assert(process.argv.includes(`--review-sha256=${digest}`), 'Review hash missing or state changed');
  if (mode === 'apply') {
    const dry = JSON.parse(await fs.readFile(`${root}/dry-run.json`, 'utf8'));
    assert.equal(dry.digest, digest);
    assert.equal(dry.failures.length, 0);
    assert.equal(dry.results.length, candidates.length);
  }
  const db = await connectDestination();
  const results = [], failures = [];
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    if (mode !== 'verify') await db.query(await fs.readFile('scripts/sql/bnms-invoice-date-reconstruction-guard.sql', 'utf8'));
    assert.equal((await db.query(`select has_table_privilege('authenticated','public.bnms_invoice_date_reconstruction_audit','INSERT') permitted`)).rows[0].permitted, false);
    assert.equal((await db.query(`select has_table_privilege('service_role','public.bnms_invoice_date_reconstruction_audit','INSERT') permitted`)).rows[0].permitted, false);
    for (const candidate of candidates) {
      try {
        await db.query('SAVEPOINT candidate');
        const member = (await db.query(`select to_jsonb(m) row from member m where tenant_id=$1 and id=$2 for update`,
          [TENANT, candidate.memberId])).rows[0]?.row;
        assert.ok(member && !member.email?.startsWith('deleted_') && !member.membership_paused && !member.membership_cancelled);
        for (const table of ['membership_billing_agreements', 'membership_payment_plans', 'membership_payment_quote', 'membership_successor_election']) {
          const actual = (await db.query(`select to_jsonb(x) row from ${table} x where tenant_id=$1 and member_id=$2 order by id for share`,
            [TENANT, member.id])).rows.map(r => redact(r.row));
          assert.deepEqual(actual, own(table, member.id).sort((a, b) => a.id.localeCompare(b.id)), `Changed ${table}`);
        }
        const histories = (await db.query('select to_jsonb(h) row from member_membership_history h where tenant_id=$1 and member_id=$2 order by id for update',
          [TENANT, member.id])).rows.map(r => r.row);
        assert.equal(histories.length, own('member_membership_history', member.id).length);
        const prefs = (await db.query(`select v.value from member_preference_value v join preference_field f on f.id=v.field_id
          where v.member_id=$1 and f.tenant_id=$2 and f.name='member_class'`, [member.id, TENANT])).rows;
        assert.equal(prefs.length, 1);
        assert.equal(prefs[0].value, candidate.repairs[0].memberClass);
        for (const repair of candidate.repairs) {
          const old = histories.find(h => h.id === repair.historyId);
          const invoice = (await db.query('select to_jsonb(i) row from historical_member_invoice i where tenant_id=$1 and id=$2 for share',
            [TENANT, repair.invoice.id])).rows[0]?.row;
          for (const k of ['member_id', 'invoice_number', 'invoice_date', 'description', 'amount_minor',
            'accounting_payment_status', 'accounting_status', 'xero_document_id']) assert.deepEqual(invoice?.[k], repair.invoice[k], k);
          const config = (await db.query('select to_jsonb(c) row from membership_tier_config c where tenant_id=$1 and id=$2 for share',
            [TENANT, repair.config.id])).rows[0].row;
          assert.deepEqual(redact(config), repair.config, 'Schedule changed');
          if (mode === 'verify') {
            const audit = (await db.query('select * from bnms_invoice_date_reconstruction_audit where history_id=$1', [repair.historyId])).rows[0];
            assert.equal(audit.plan_hash, digest);
            assert.deepEqual(old, audit.corrected_record || audit.after_record);
            continue;
          }
          assert.deepEqual(redact(old), repair.before, 'History changed after review');
          if (mode === 'apply') await fs.writeFile(`${root}/before-${old.id}.json`,
            JSON.stringify({ memberId: member.id, before: old, patch: repair.patch, invoice, config }, null, 2),
            { mode: 0o600, flag: 'wx' });
          await db.query(`insert into public.bnms_invoice_date_reconstruction_audit
            (history_id,tenant_id,member_id,plan_hash,before_record,after_record) values ($1,$2,$3,$4,$5,$6)`,
            [old.id, TENANT, member.id, digest, JSON.stringify(old), JSON.stringify({ ...old, ...repair.patch })]);
          const keys = Object.keys(repair.patch);
          const result = await db.query(`update member_membership_history set ${keys.map((k, i) => `"${k}"=$${i + 1}`).join(',')}
            where tenant_id=$${keys.length + 1} and id=$${keys.length + 2} returning to_jsonb(member_membership_history) row`,
          [...keys.map(k => repair.patch[k] && typeof repair.patch[k] === 'object' ? JSON.stringify(repair.patch[k]) : repair.patch[k]), TENANT, old.id]);
          assert.equal(result.rowCount, 1);
          const actual = result.rows[0].row;
          for (const [key, value] of Object.entries(repair.patch)) assert.deepEqual(actual[key], value, key);
          for (const key of Object.keys(old).filter(k => !keys.includes(k))) assert.deepEqual(actual[key], old[key], `Unexpected change ${key}`);
        }
        const after = (await db.query('select to_jsonb(h) row from member_membership_history h where tenant_id=$1 and member_id=$2',
          [TENANT, member.id])).rows.map(r => r.row);
        const assessment = assessFormMembershipRenewalEvidence({ tenantId: TENANT, memberId: member.id,
          histories: after, agreements: own('membership_billing_agreements', member.id),
          successorConfig: candidate.repairs[0].config, now: new Date() });
        assert.notEqual(assessment.state, 'review_required', JSON.stringify(assessment));
        assert.deepEqual((await db.query('select to_jsonb(m) row from member m where id=$1', [member.id])).rows[0].row, member);
        await db.query('RELEASE SAVEPOINT candidate');
        results.push({ memberId: member.id, terms: candidate.repairs.map(r => ({ historyId: r.historyId, invoice: r.invoice.invoice_number,
          start: r.start, end: r.end, kind: r.kind })), assessment });
      } catch (e) {
        await db.query('ROLLBACK TO SAVEPOINT candidate');
        failures.push({ memberId: candidate.memberId, reason: String(e.message),
          location: e.stack?.split('\n').find(line => line.includes('reconstruct-bnms-invoice-date-cohort.mjs:')) });
      }
    }
    if (mode !== 'verify' && !failures.length) {
      // The repair journal cannot authorise any second edit to the repaired policy.
      const first = candidates[0].repairs[0];
      await db.query('SAVEPOINT forbidden_edit');
      let rejected = false;
      try { await db.query(`update member_membership_history set renewal_policy_snapshot =
        jsonb_set(renewal_policy_snapshot,'{renewal_grace_days}','91') where id=$1`, [first.historyId]); }
      catch (e) { rejected = /Purchased renewal policy is immutable/.test(e.message); }
      await db.query('ROLLBACK TO SAVEPOINT forbidden_edit');
      assert(rejected, 'Purchased policy protection was not preserved');
    }
    await db.query(mode === 'apply' && !failures.length ? 'COMMIT' : 'ROLLBACK');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { await db.end(); }
  await fs.writeFile(`${root}/${mode}.json`, JSON.stringify({ digest, mode, results, failures }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ mode, digest, committed: mode === 'apply' && !failures.length, members: results.length, failures, results }, null, 2));
}
