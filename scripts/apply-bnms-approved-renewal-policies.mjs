import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';
import { inspect, assertServiceOnly } from './lib/expiry-only-migration.mjs';
import { isAttestedExpiryOnlyHistory } from '../api/_lib/expiryOnlyRenewalPolicy.js';
import { POLICY, TENANT } from './repair-bnms-reviewed-expiry-policies.mjs';

export const REPORT = 'reports/bnms-legacy-renewal-schedule-approval-2026-10-04.md';
export const REPORT_HASH = '983c80dd969c7fe621684e2f0ec41fb6ec2c452e34f37f3f2356e28c67a2ad7c';
export const PRIVATE = 'private/bnms-renewal-policy-2026-10-04';
export const REFERENCE = 'BNMS 2026-10-04 exact 72-history schedule approval; separate operator authorization: Authorize the scoped DEST writes. No rollout, recurring consent, charges or successor commitments.';
export const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const guardQuery = "SELECT pg_get_functiondef('public.guard_membership_expiry_policy_assignment()'::regprocedure) definition";
const tables = ['member', 'member_membership_history', 'membership_tier_config',
  'membership_billing_agreements', 'membership_successor_election', 'membership_successor_payment_attempt',
  'membership_successor_rollout', 'membership_successor_tenant_rollout'];
const counts = [37, 13, 8, 4, 3, 5, 2];

export function parseApproval(text) {
  const configs = [...text.matchAll(/^\| ([^|]+) \| (\d+) \| ([^|]+) \| ([a-f0-9-]{36}) \| (\d{4}-\d\d-\d\d) \|$/gm)]
    .map(([, cohort, count, suffix, id, start]) => ({ cohort, count: Number(count), id, name: `2026-2027 ${suffix}`, start }));
  const cohort = [...text.matchAll(/^\| ([^|]+) \| ([a-f0-9-]{36}) \| (\d{4}-\d\d-\d\d) \|$/gm)]
    .map(([, kind, id, expiry]) => ({ kind, id, expiry, config: configs.find(c => c.cohort === kind) }));
  if (configs.length !== 7 || cohort.length !== 72 || new Set(cohort.map(r => r.id)).size !== 72
    || configs.some((c, i) => c.count !== counts[i] || cohort.filter(r => r.kind === c.cohort).length !== c.count)
    || cohort.some(r => !r.config)) throw new Error('Exact approved cohort is invalid');
  return cohort;
}

export function validateRow(a, row) {
  const { history: h, config: c, member: m } = row;
  if (!isAttestedExpiryOnlyHistory(h, TENANT) || h.id !== a.id || h.term_end_date !== a.expiry
    || h.expiry_enforced_at != null || h.annual_renewal_state != null
    || !m || m.id !== h.member_id || m.tenant_id !== TENANT || m.status === 'deleted'
    || m.is_deleted === true || m.deleted_at != null
    || c?.id !== a.config.id || c.tenant_id !== TENANT || c.name !== a.config.name
    || c.structure_scope_type !== 'member' || c.billing_period !== 'annual' || c.is_active !== true
    || c.effective_from !== a.config.start || c.effective_to !== null || c.start_mode !== 'immediate') {
    throw new Error(`Approved history/member/config binding changed: ${a.id}`);
  }
  const expected = a.kind === 'Full Overseas'
    ? { ...POLICY, renewal_open_days: 0, renewal_grace_days: 0, renewal_disable_login: false } : POLICY;
  if (Object.entries(expected).some(([k, v]) => c[k] !== v)) throw new Error('Approved schedule policy changed');
  const n = typeof h.notes === 'string' ? JSON.parse(h.notes) : h.notes;
  if (n.version !== 1 || !/^[a-f0-9]{64}$/.test(n.sourceHash || '')
    || n.paymentAuthority !== 'operator_attested_upfront_paid_2025_2026'
    || n.startDateAuthority !== 'unknown_not_inferred' || n.expiryAuthority !== 'retained_legacy_expiry'
    || !['operator_attested_existing_2025_2026', 'operator_reviewed_pilot', 'explicit_invoice_2025_2026'].includes(n.termAuthority)) {
    throw new Error('Approved historical provenance is unavailable');
  }
}

function assignment(a, h) {
  return { tenant_id: TENANT, history_id: h.id, member_id: h.member_id,
    config_id: a.config.id, config_name: a.config.name, expiry_date: a.expiry,
    policy_snapshot: POLICY, approval_source: 'operator', approval_reference: REFERENCE };
}

async function rows(db, cohort) {
  const result = [];
  for (const a of cohort) {
    const found = (await db.query(`SELECT to_jsonb(h) history,to_jsonb(c) config,to_jsonb(m) member
      FROM public.member_membership_history h
      JOIN public.member m ON m.id=h.member_id AND m.tenant_id=h.tenant_id
      JOIN public.membership_tier_config c ON c.id=$3 AND c.tenant_id=h.tenant_id
      WHERE h.id=$1 AND h.tenant_id=$2`, [a.id, TENANT, a.config.id])).rows;
    if (found.length !== 1) throw new Error(`Approved owner/history not found: ${a.id}`);
    validateRow(a, found[0]);
    const { history, config, member } = found[0];
    // Member personal fields never leave the process; the full row hash pins its version.
    result.push({ history, config, memberHash: sha(member), assignment: assignment(a, history) });
  }
  return result;
}

export function extendGuard(definition, records) {
  const start = 'OR (NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object(';
  const end = "    ))\n    THEN RAISE EXCEPTION 'Expiry policy configuration/snapshot is invalid'";
  if (definition.split(start).length !== 2 || definition.split(end).length !== 2
    || !definition.includes("NEW.history_id = '0ff50f40-15b1-567f-a4d1-c353d9342fae'::uuid")) {
    throw new Error('Unreviewed assignment guard contract');
  }
  const overseas = records.filter(r => r.assignment.config_id === '1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce');
  if (overseas.length !== 5) throw new Error('Exactly five overseas exceptions required');
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  const exact = overseas.map(({ assignment: a }) => '(' + [
    `NEW.history_id=${literal(a.history_id)}::uuid`, `NEW.member_id=${literal(a.member_id)}::uuid`,
    `NEW.expiry_date=${literal(a.expiry_date)}::date`,
  ].join(' AND ') + ')').join('\n OR ');
  const exception = `(
      NEW.tenant_id=${literal(TENANT)}::uuid
      AND NEW.config_id='1e82bb61-a0b3-4e6c-8bad-92cb527cd0ce'::uuid
      AND NEW.config_name='2026-2027 Overseas full member'
      AND h.tier_label='Full Membership Overseas'
      AND NEW.approval_source='operator'
      AND NEW.approval_reference=${literal(REFERENCE)}
      AND NEW.policy_snapshot=${literal(JSON.stringify(POLICY))}::jsonb
      AND (${exact})
    )`;
  return definition.replace(start, 'OR ((NEW.policy_snapshot IS DISTINCT FROM jsonb_build_object(')
    .replace(end, `    )) AND NOT ${exception})\n    THEN RAISE EXCEPTION 'Expiry policy configuration/snapshot is invalid'`);
}

async function prerequisites(db) {
  const contract = await inspect(db);
  if (!contract.state.capability_installed || !contract.state.policy_installed
    || !contract.functions.find(f => f.proname === 'reserve_membership_successor')?.definition
      .includes('public.form_expiry_only_renewal_policy(prior,p_tenant_id,p_member_id)')) {
    throw new Error('Separate expiry-only safety migration must be installed first');
  }
  await assertServiceOnly(db, ['public.form_expiry_only_renewal_policy(jsonb,uuid,uuid)',
    'public.form_expiry_only_renewal_supported()']);
  return contract;
}

async function fingerprints(db) {
  const result = {};
  for (const table of tables) result[table] = (await db.query(`SELECT count(*)::int count,
    md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) fingerprint
    FROM public.${table} t`)).rows[0];
  return result;
}

async function savedAssignments(db) {
  return (await db.query('SELECT to_jsonb(p) row FROM public.membership_expiry_policy_assignment p ORDER BY history_id')).rows.map(r => r.row);
}

export async function prepare(db, cohort) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const contract = await prerequisites(db);
    const records = await rows(db, cohort);
    const saved = await savedAssignments(db);
    if (saved.some(s => records.some(r => r.history.id === s.history_id))) throw new Error('Plan requires all 72 histories unassigned');
    const guardBefore = (await db.query(guardQuery)).rows[0].definition;
    const plan = { records, guardBefore, guardAfter: extendGuard(guardBefore, records),
      contractBefore: contract.contractHash, assignmentsBefore: saved };
    await db.query('ROLLBACK');
    return plan;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

export async function applyPlan(db, plan, cohort, { rollback = false } = {}) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-successor-schema',0))");
    await db.query(`LOCK TABLE public.membership_expiry_policy_assignment IN SHARE ROW EXCLUSIVE MODE`);
    await db.query(`LOCK TABLE ${tables.map(t => `public.${t}`).join(',')} IN SHARE MODE`);
    const contract = await prerequisites(db);
    const currentGuard = (await db.query(guardQuery)).rows[0].definition;
    const saved = await savedAssignments(db);
    const currentRows = await rows(db, cohort);
    if (!same(currentRows, plan.records)) throw new Error('Pinned history/member/provenance/config drift');
    const matched = saved.filter(s => plan.records.some(r => r.history.id === s.history_id));
    if (![0, 72].includes(matched.length)) throw new Error('Partial/conflicting existing assignments');
    for (const s of matched) {
      const expected = plan.records.find(r => r.history.id === s.history_id).assignment;
      if (Object.entries(expected).some(([k, v]) => !same(s[k], v))) throw new Error('Conflicting existing assignment');
    }
    const other = saved.filter(s => !plan.records.some(r => r.history.id === s.history_id));
    if (!same(other, plan.assignmentsBefore)) throw new Error('Other assignments changed since plan');
    if (matched.length === 72) {
      if (currentGuard !== plan.guardAfter) throw new Error('Replay guard drift');
      const restored = contract.functions.map(f => f.proname === 'guard_membership_expiry_policy_assignment'
        ? { ...f, definition: plan.guardBefore } : f);
      if (sha({ functions: restored, metadata: contract.metadata }) !== plan.contractBefore) {
        throw new Error('Replay database contract drift');
      }
      await db.query('ROLLBACK');
      return { inserted: 0, replay: true, writesPerformed: false, historiesUnchanged: true, rolloutEnabled: false };
    }
    if (currentGuard !== plan.guardBefore || contract.contractHash !== plan.contractBefore) throw new Error('Pinned database contract drift');
    const before = await fingerprints(db);
    await db.query(plan.guardAfter);
    for (const { assignment: a } of plan.records) {
      const keys = Object.keys(a);
      const result = await db.query(`INSERT INTO public.membership_expiry_policy_assignment (${keys.join(',')})
        VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(k => k === 'policy_snapshot' ? JSON.stringify(a[k]) : a[k]));
      if (result.rowCount !== 1) throw new Error('Assignment insert count mismatch');
    }
    if (!same(await fingerprints(db), before) || !same(await rows(db, cohort), plan.records)) {
      throw new Error('Non-assignment data changed');
    }
    const after = await savedAssignments(db);
    if (after.length !== saved.length + 72 || !same(after.filter(s => !plan.records.some(r => r.history.id === s.history_id)), saved)) {
      throw new Error('Unexpected assignment changes');
    }
    for (const { assignment: a } of plan.records) {
      const s = after.find(s => s.history_id === a.history_id);
      if (!s || Object.entries(a).some(([k, v]) => !same(s[k], v))) throw new Error('Assignment read-back mismatch');
    }
    if ((await db.query(guardQuery)).rows[0].definition !== plan.guardAfter) throw new Error('Exception guard read-back mismatch');
    await prerequisites(db);
    await db.query(rollback ? 'ROLLBACK' : 'COMMIT');
    return { inserted: rollback ? 0 : 72, rehearsed: rollback, statementsVerified: 72,
      historiesUnchanged: true, otherTablesUnchanged: before, rolloutEnabled: false };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

async function sourceHash() {
  const files = [new URL(import.meta.url), REPORT, 'api/_lib/expiryOnlyRenewalPolicy.js',
    'scripts/repair-bnms-reviewed-expiry-policies.mjs', 'scripts/lib/expiry-only-migration.mjs'];
  return sha((await Promise.all(files.map(f => readFile(f, 'utf8')))).join('\n'));
}

export async function main(args = process.argv.slice(2)) {
  const mode = args[0];
  if (!['--prepare', '--rehearse', '--apply', '--replay'].includes(mode)
    || (mode === '--prepare' ? args.length !== 1 : args.length !== 2 || !/^--plan-sha256=[a-f0-9]{64}$/.test(args[1]))) {
    throw new Error('Use --prepare or --rehearse/--apply/--replay --plan-sha256=<reviewed hash>');
  }
  const text = await readFile(REPORT, 'utf8');
  if (sha(text) !== REPORT_HASH) throw new Error('Original approval report changed');
  const cohort = parseApproval(text);
  const codeHash = await sourceHash();
  let plan;
  if (mode !== '--prepare') {
    const raw = await readFile(`${PRIVATE}/plan.json`, 'utf8');
    if (args[1] !== `--plan-sha256=${sha(raw)}`) throw new Error('Plan hash mismatch; no connection opened');
    plan = JSON.parse(raw);
    if (plan.codeHash !== codeHash || plan.reportHash !== sha(text)) throw new Error('Plan code/report drift; no connection opened');
  }
  if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
    throw new Error('Verified DEST SQL and REST targets required');
  }
  const db = await connectDestination();
  try {
    if (mode === '--prepare') {
      plan = { ...await prepare(db, cohort), codeHash, reportHash: sha(text) };
      const raw = JSON.stringify(plan, null, 2) + '\n';
      await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
      await writeFile(`${PRIVATE}/plan.json`, raw, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ prepared: 72, planHash: sha(raw), writesPerformed: false }));
    } else {
      if (mode === '--replay') {
        const existing = await savedAssignments(db);
        if (existing.filter(s => plan.records.some(r => r.history.id === s.history_id)).length !== 72) throw new Error('Replay requires all 72 assignments');
      }
      const result = await applyPlan(db, plan, cohort, { rollback: mode === '--rehearse' });
      await writeFile(`${PRIVATE}/${mode.slice(2)}.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(result));
    }
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}