// Read-only DEST audit. Never invokes reservation, simulation, or provider APIs.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';
import { parseApproval, REPORT, REPORT_HASH } from './apply-bnms-approved-renewal-policies.mjs';
import { loadExpiryOnlyRenewalPolicy } from '../api/_lib/expiryOnlyRenewalPolicy.js';
import { hasFormExpiryOnlyProvenance } from '../api/_lib/formExpiryOnlyRenewal.js';
import { assessFormMembershipRenewalEvidence } from '../api/_lib/formMembershipRenewalEvidence.js';
import { loadFormMembershipRenewalContext } from '../api/_lib/formMembershipRenewalContext.js';

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const PRIVATE = 'private/bnms-renewal-policy-2026-10-04';
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const discarded = ['cancelled', 'canceled', 'void', 'expired_checkout'];
const open = row => ![...discarded, 'completed', 'expired'].includes(row.status);

// Read-only in-memory adapter lets the actual application admission code consume
// one complete SQL snapshot. Unsupported operations fail rather than fall back.
export function snapshotDb(tables, { rollout = false, capability = true } = {}) {
  return {
    async rpc(name) {
      if (name === 'membership_successor_elections_enabled') return { data: rollout };
      if (name === 'form_expiry_only_renewal_supported') return { data: capability };
      throw new Error(`RPC forbidden in audit: ${name}`);
    },
    from(table) {
      if (!Array.isArray(tables[table])) throw new Error(`Unknown snapshot table: ${table}`);
      let rows = [...tables[table]];
      const q = {
        select() { return q; },
        eq(key, value) { rows = rows.filter(r => r[key] === value); return q; },
        order(key) { rows.sort((a, b) => String(a[key]).localeCompare(String(b[key]))); return q; },
        range(start, end) { rows = rows.slice(start, end + 1); return q; },
        maybeSingle() {
          if (rows.length > 1) throw new Error('Nonunique snapshot row');
          return Promise.resolve({ data: rows[0] || null });
        },
        then(resolve, reject) { return Promise.resolve({ data: rows }).then(resolve, reject); },
      };
      return q;
    },
  };
}

export async function assessSnapshot(tables, { now, capability, rollout, sqlPolicies }) {
  const db = snapshotDb(tables, { capability, rollout });
  // Only this in-memory copy opens the gate to inspect downstream admission.
  // The live database rollout remains unchanged and no payment is simulated.
  const hypothetical = snapshotDb(tables, { capability, rollout: true });
  const output = [];
  for (const a of tables.membership_expiry_policy_assignment) {
    const owner = tables.member.find(m => m.id === a.member_id);
    const histories = tables.member_membership_history.filter(h => h.member_id === a.member_id);
    const history = histories.find(h => h.id === a.history_id);
    const agreements = tables.membership_billing_agreements.filter(b => b.member_id === a.member_id);
    const elections = tables.membership_successor_election.filter(e => e.member_id === a.member_id);
    const config = tables.membership_tier_config.find(c => c.id === a.config_id);
    const policies = {};
    const errors = [];
    for (const h of histories.filter(h => !discarded.includes(h.status) && !h.term_start_date)) {
      if (!hasFormExpiryOnlyProvenance(h, TENANT)) continue;
      try { policies[h.id] = await loadExpiryOnlyRenewalPolicy(db, { tenantId: TENANT, history: h }); }
      catch (e) { errors.push(e.message); }
    }
    const evidence = { tenantId: TENANT, memberId: a.member_id, histories, agreements,
      now, paused: owner?.membership_paused === true, expiryOnlyPolicies: policies, successorConfig: config };
    const assessment = assessFormMembershipRenewalEvidence(evidence);
    const stop = new Error('AUDIT_STOP_BEFORE_PRICING');
    const simulate = async () => { throw stop; };
    let context;
    if (!owner) context = { state: 'review_required', reason: 'owner_missing' };
    else {
      try {
        context = (await loadFormMembershipRenewalContext(hypothetical,
          { tenantId: TENANT, memberId: a.member_id, now, simulate })).renewal;
      } catch (e) {
        context = e === stop ? { state: 'admitted_to_pricing_not_run' }
          : { state: 'review_required', reason: e.message };
      }
    }
    const live = await loadFormMembershipRenewalContext(db,
      { tenantId: TENANT, memberId: a.member_id, now, simulate });
    const next = new Date(`${a.expiry_date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const start = next.toISOString().slice(0, 10);
    const conflictHistories = histories.filter(h => h.id !== a.history_id && !discarded.includes(h.status)
      && (!h.term_start_date || h.term_start_date <= a.expiry_date));
    const successorHistories = histories.filter(h => h.term_start_date === start && !discarded.includes(h.status));
    const quotes = tables.membership_payment_quote.filter(q => q.member_id === a.member_id && !q.organization_id);
    output.push({
      historyId: a.history_id, memberId: a.member_id, assignmentId: a.id,
      configId: a.config_id, configName: config?.name, expiry: a.expiry_date,
      ownerUnavailable: !owner || owner.status === 'deleted' || owner.is_deleted === true || !!owner.deleted_at,
      provenanceValid: hasFormExpiryOnlyProvenance(history, TENANT),
      applicationPolicyValid: !!policies[a.history_id], sqlPolicyValid: !!sqlPolicies[a.history_id],
      paused: owner?.membership_paused === true, policyErrors: errors,
      conflictingHistoryIds: conflictHistories.map(h => h.id),
      successorHistoryIds: successorHistories.map(h => h.id),
      openAgreementIds: agreements.filter(open).map(b => b.id),
      nonReleasedElectionIds: elections.filter(e => e.status !== 'released').map(e => e.id),
      // Quote checks are separately inspected against the installed SQL contract.
      quotes: quotes.map(q => ({ id: q.id,
        start: q.quote?.simResult?.commitment?.term_start_date
          || q.quote?.simResult?.paymentSchedule?.term_start_date
          || q.quote?.simResult?.membershipYear?.start })),
      assessment, hypotheticalContext: context, liveState: live.renewal,
    });
  }
  return output;
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--read-only-dest'], 'Explicit read-only DEST opt-in required');
  assert(isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL));
  const approval = await readFile(REPORT, 'utf8');
  assert.equal(hash(approval), REPORT_HASH);
  const approved = parseApproval(approval);
  const db = await connectDestination();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='30s'");
    const meta = (await db.query(`SELECT current_setting('transaction_read_only') read_only,
      now() at time zone 'UTC' observed_at, current_date::text as_of,
      public.membership_successor_elections_enabled($1::uuid) rollout,
      public.membership_successor_elections_enabled() global_rollout,
      public.form_expiry_only_renewal_supported() capability`, [TENANT])).rows[0];
    assert.equal(meta.read_only, 'on');
    assert.equal(meta.rollout, false);
    assert.equal(meta.global_rollout, false);
    const tables = {};
    const read = async (table, where, args = [TENANT]) =>
      (await db.query(`SELECT to_jsonb(t) row FROM public.${table} t ${where} ORDER BY t.id`, args)).rows.map(r => r.row);
    tables.membership_expiry_policy_assignment = await read('membership_expiry_policy_assignment', 'WHERE tenant_id=$1');
    assert.equal(tables.membership_expiry_policy_assignment.length, 83);
    const ids = tables.membership_expiry_policy_assignment.map(a => a.member_id);
    assert.equal(new Set(ids).size, 83);
    for (const a of approved) {
      const found = tables.membership_expiry_policy_assignment.find(p => p.history_id === a.id);
      assert(found && found.config_id === a.config.id && found.expiry_date === a.expiry);
    }
    for (const table of ['member_membership_history', 'membership_billing_agreements',
      'membership_successor_election', 'membership_payment_quote']) {
      tables[table] = await read(table, 'WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])', [TENANT, ids]);
    }
    tables.member = (await db.query(`SELECT id,tenant_id,status,membership_paused,
      to_jsonb(m)->'is_deleted' is_deleted,to_jsonb(m)->'deleted_at' deleted_at
      FROM public.member m WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [TENANT, ids])).rows;
    tables.membership_tier_config = await read('membership_tier_config', 'WHERE tenant_id=$1');
    const sqlPolicies = Object.fromEntries((await db.query(`SELECT h.id,
      public.form_expiry_only_renewal_policy(to_jsonb(h),h.tenant_id,h.member_id) policy
      FROM public.member_membership_history h JOIN public.membership_expiry_policy_assignment a
      ON a.history_id=h.id AND a.tenant_id=h.tenant_id WHERE a.tenant_id=$1`, [TENANT])).rows.map(r => [r.id, r.policy]));
    const functions = (await db.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,
      pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname,p.oid`,
    [['reserve_membership_successor', 'form_expiry_only_renewal_policy',
      'membership_successor_elections_enabled', 'guard_membership_expiry_policy_assignment']])).rows;
    const rows = await assessSnapshot(tables, { now: `${meta.as_of}T12:00:00Z`,
      ...meta, sqlPolicies });
    await db.query('ROLLBACK');
    await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
    const evidence = { meta, tableCounts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
      snapshotHash: hash(tables), functions, functionsHash: hash(functions), rows };
    await writeFile(`${PRIVATE}/readiness.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    const counts = key => rows.reduce((out, r) => {
      const value = key(r); out[value] = (out[value] || 0) + 1; return out;
    }, {});
    console.log(JSON.stringify({ ...meta, counts: evidence.tableCounts, snapshotHash: evidence.snapshotHash,
      functionsHash: evidence.functionsHash, provenance: counts(r => r.provenanceValid),
      sqlPolicy: counts(r => r.sqlPolicyValid), appPolicy: counts(r => r.applicationPolicyValid),
      assessment: counts(r => r.assessment.reason || r.assessment.state),
      context: counts(r => r.hypotheticalContext.reason || r.hypotheticalContext.state),
      paused: counts(r => r.paused), conflicts: counts(r => r.conflictingHistoryIds.length),
      agreements: counts(r => r.openAgreementIds.length), elections: counts(r => r.nonReleasedElectionIds.length),
      quotes: counts(r => r.quotes.length), unavailable: counts(r => r.ownerUnavailable) }, null, 2));
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}