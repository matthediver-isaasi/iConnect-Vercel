// Insert ONLY Lavinia/Aisha display histories. No providers, financial writes,
// role/member/preference updates, invoice associations or authority creation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { TENANT, MEMBERS, TARGETS, hash, loadProposal, completeRows } from './prepare-bnms-five-unverified.mjs';
import { planIdempotentInserts } from './prepare-bnms-five-members.mjs';
import { buildApprovedRows } from './repair-bnms-five-verified-paid.mjs';
import { BASE_SCHEMA_HASH, inspectSchema, assertInstalled, assertGuardPrivileges, migrationSql, sqlHash,
  historySnapshot, ident } from './prepare-member-history-unverified-migration.mjs';

export async function protectedTables(db) {
  return (await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    AND table_name <> 'member_membership_history' ORDER BY table_name`)).rows.map(r => r.table_name);
}
export async function takeProtected(db, tables) {
  if (!tables.length) return {};
  // Bounded server-side batches avoid hundreds of network round trips and one
  // unbounded global sort. Two additive 64-bit row-hash limbs + count preserve
  // duplicate multiplicity (unlike XOR); complete composite rows are covered.
  const result = {};
  for (let offset = 0; offset < tables.length; offset += 20) {
    const sql = tables.slice(offset, offset + 20).map(table => {
      const quoted = ident(table);
      return `SELECT '${table}'::text table_name,count(*)::int count,
        md5(coalesce(sum(('x'||substr(md5(r::text),1,16))::bit(64)::bigint)::text,'')||':'||
            coalesce(sum(('x'||substr(md5(r::text),17,16))::bit(64)::bigint)::text,'')) hash
        FROM public.${quoted} r`;
    }).join(' UNION ALL ');
    Object.assign(result,Object.fromEntries((await db.query(sql)).rows.map(({ table_name, ...value }) => [table_name,value])));
  }
  return result;
}
async function context(db) {
  assert.equal((await db.query('SELECT slug FROM public.tenant WHERE id=$1', [TENANT])).rows[0]?.slug, 'bnms');
  const members = (await db.query(`SELECT to_jsonb(m) data FROM public.member m
    WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [TENANT, MEMBERS])).rows.map(r => r.data);
  assert.equal(members.length, 5);
  const preferences = (await db.query(`SELECT v.member_id,f.name,v.value FROM public.member_preference_value v
    JOIN public.preference_field f ON f.id=v.field_id WHERE f.tenant_id=$1 AND v.member_id=ANY($2::uuid[])
    ORDER BY v.member_id,f.name,v.id`, [TENANT,MEMBERS])).rows;
  return { members, preferences };
}
function verifyContext(current, evidence) {
  for (const member of current.members) {
    const original = evidence.find(e => e.member.id === member.id);
    for (const [key, value] of Object.entries(original.member)) {
      if (key === 'created_on' && value != null) assert.equal(Date.parse(member[key]), Date.parse(value));
      else assert.deepEqual(member[key], value, `Member ${key} changed`);
    }
    for (const name of ['member_class','membership_status','ym_membership_type','ym_date_membership_expires','ym_web_site_member_id']) {
      assert.deepEqual(current.preferences.filter(p => p.member_id === member.id && p.name === name).map(p => p.value),
        original.prefs.filter(p => p.name === name).map(p => p.value), `Preference ${name} changed`);
    }
  }
}
async function assertNoAuthority(db) {
  for (const table of ['membership_billing_agreements','membership_payment_plans','membership_successor_election',
    'membership_payment_quote','member_membership_amendment']) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.${ident(table)}
      WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])`, [TENANT,TARGETS])).rows[0].n, 0, `Unexpected ${table}`);
  }
}
export function assertThreePreserved(history, expected) {
  for (const row of expected) {
    const actual = history.find(h => h.id === row.id);
    assert.ok(actual, 'Previously approved paid history missing');
    for (const [key, value] of Object.entries(row)) {
      if (key === 'paid_at' && value != null) assert.equal(Date.parse(actual[key]), Date.parse(value));
      else assert.deepEqual(actual[key], value, `Previously approved paid ${key} changed`);
    }
  }
}
export async function preparePlan(db, loaded, paidRows, sql) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'");
    const schema = await inspectSchema(db);
    if (hash(schema) !== BASE_SCHEMA_HASH) {
      assertInstalled(schema, sql);
      await assertGuardPrivileges(db);
    }
    const current = await context(db);
    verifyContext(current, loaded.evidence);
    await assertNoAuthority(db);
    const before = await historySnapshot(db);
    assertThreePreserved(before, paidRows);
    assert.equal(before.filter(r => TARGETS.includes(r.member_id)).length, 0, 'Target history already exists; use reviewed replay');
    const tables = await protectedTables(db);
    const rows = completeRows(loaded.rows, schema.columns, new Date().toISOString());
    const plan = { version: 1, tenant: TENANT, targetIds: TARGETS, rows, migrationSha256: sqlHash(sql),
      baseSchemaHash: BASE_SCHEMA_HASH, historyBefore: before, context: current, tables,
      protectedBefore: await takeProtected(db, tables), providerCalls: 0 };
    await db.query('ROLLBACK');
    return plan;
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
}
export async function executePlan(db, plan, sql, { apply = false, replay = false, journal = async () => {} } = {}) {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'");
    assert.deepEqual(await protectedTables(db), plan.tables, 'Protected table set changed');
    // Only the insertion ledger and the two target owners/source preferences
    // need write protection. Other public tables are read/fingerprinted, never
    // globally write-locked for this two-record repair.
    await lockRepairScope(db);
    assertInstalled(await inspectSchema(db), sql);
    await assertGuardPrivileges(db);
    assert.equal(sqlHash(sql), plan.migrationSha256);
    assert.deepEqual(await context(db), plan.context, 'Member/context changed after review');
    await assertNoAuthority(db);
    await journal({ phase: 'before_write', apply, replay, planHash: hash(plan), pending: replay ? 0 : 2 });
    // Production can change unrelated operational rows between review/rehearsal/
    // commit. Refresh ONLY their read-only baseline inside this transaction after
    // the exact history, target-owner context and absence of target authority have
    // passed the strict checks above. The audit pins the effective refreshed plan.
    const result = await insertAndVerify(db, plan, { replay, refreshUnrelated: true, journal });
    await journal({ phase: 'validated', apply, replay, ...result });
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { committed: apply, inserted: apply ? result.pending : 0, validated: result.pending,
      replayed: result.replayed, providerCalls: 0, protectedRowsUnchanged: true };
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
}
export async function lockRepairScope(db) {
  await db.query('LOCK TABLE public.member_membership_history IN SHARE ROW EXCLUSIVE MODE');
  const members = await db.query(`SELECT id FROM public.member
    WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [TENANT,TARGETS]);
  assert.equal(members.rows.length, 2, 'Target members missing');
  await db.query(`SELECT v.id FROM public.member_preference_value v
    JOIN public.preference_field f ON f.id=v.field_id
    WHERE f.tenant_id=$1 AND v.member_id=ANY($2::uuid[])
    ORDER BY v.id FOR SHARE OF v,f`, [TENANT,TARGETS]);
  await db.query('SELECT id FROM public.tenant WHERE id=$1 FOR SHARE', [TENANT]);
  // config_id is explicitly NULL: no purchased/source configuration is attached.
}
// Shared mutation/verification core, called only inside the runner's serializable
// transaction after destination/schema/source/context/locks have been validated.
export async function insertAndVerify(db, plan, { replay = false, refreshUnrelated = false, journal = async () => {} } = {}) {
  const before = await historySnapshot(db), ids = new Set(plan.rows.map(r => r.id));
  const unrelated = rows => rows.filter(r => !ids.has(r.id));
  assert.deepEqual(unrelated(before), plan.historyBefore, 'Protected histories changed after review');
  const protectedBefore = await takeProtected(db, plan.tables);
  if (hash(protectedBefore) !== hash(plan.protectedBefore)) {
    assert.ok(refreshUnrelated, 'Protected tables changed after review');
    const changedTables = plan.tables.filter(table => hash(protectedBefore[table]) !== hash(plan.protectedBefore[table]));
    await journal({ phase: 'unrelated_baseline_refreshed', reviewedPlanHash: hash(plan),
      effectivePlanHash: hash({ ...plan, protectedBefore }), changedTables, protectedBefore,
      exactHistoryAndTargetContextRevalidated: true });
  }
  const planned = planIdempotentInserts(plan.rows, before);
  assert.equal(planned.pending.length, replay ? 0 : 2);
  assert.equal(planned.replayed.length, replay ? 2 : 0);
  for (const row of planned.pending) {
    const keys = Object.keys(row);
    const result = await db.query(`INSERT INTO public.member_membership_history (${keys.map(ident).join(',')})
      VALUES (${keys.map((_,i) => `$${i+1}`).join(',')}) RETURNING id`, keys.map(k => row[k]));
    assert.equal(result.rowCount, 1);
  }
  const after = await historySnapshot(db);
  assert.deepEqual(unrelated(after), unrelated(before), 'Other histories changed, including all three paid histories');
  assert.equal(after.length - before.length, replay ? 0 : 2);
  const verified = planIdempotentInserts(plan.rows, after);
  assert.equal(verified.pending.length, 0);
  assert.equal(verified.replayed.length, 2);
  assert.deepEqual(await takeProtected(db, plan.tables), protectedBefore, 'Protected whole rows changed');
  return { pending: planned.pending.length, replayed: planned.replayed.length,
    historyHash: hash(after), protectedRowsUnchanged: true };
}
export async function main(args = process.argv.slice(2)) {
  const [mode, directory, review] = args;
  assert.ok(/^\/tmp\/bnms-five-unverified-[a-z0-9-]+$/.test(directory || ''), 'Private audit directory required');
  assert.ok(mode === '--prepare' && args.length === 2
    || mode === '--execute-reviewed' && args.length === 3 && /^--review-sha256=[a-f0-9]{64}$/.test(review || ''),
  'Only --prepare <new directory> or --execute-reviewed <directory> --review-sha256=<plan hash>');
  const loaded = await loadProposal(), sql = await migrationSql();
  const decisions = JSON.parse(await readFile('/tmp/bnms-five-decisions.json', 'utf8'));
  const source = JSON.parse(await readFile('/tmp/bnms-five-source-rows.json', 'utf8'));
  const paidRows = buildApprovedRows(loaded.evidence, decisions, source);
  if (mode === '--execute-reviewed') {
    // Validate review and source artifacts BEFORE connecting to production.
    const plan = JSON.parse(await readFile(`${directory}/plan.json`, 'utf8'));
    assert.equal(review, `--review-sha256=${hash(plan)}`, 'Exact reviewed plan hash required');
    assert.deepEqual(plan.rows.map(row => Object.fromEntries(Object.keys(loaded.rows[0]).map(k => [k,row[k]]))), loaded.rows);
    assert.equal(plan.tenant, TENANT);
    assert.deepEqual(plan.targetIds, TARGETS);
    for (const row of plan.rows) for (const [key,value] of Object.entries(row)) {
      if (!['created_at','updated_at',...Object.keys(loaded.rows[0])].includes(key)) assert.equal(value, null, `Unsupported ${key}`);
    }
    const handle = await open(`${directory}/execution-${randomUUID()}.jsonl`, 'wx', 0o600);
    let previousHash = null;
    const journal = async data => {
      const entry = { previousHash, at: new Date().toISOString(), ...data };
      previousHash = hash(entry);
      await handle.writeFile(`${JSON.stringify({ ...entry, hash: previousHash })}\n`);
      await handle.sync();
    };
    let db;
    try {
      const { connectDestination } = await import('./annual-meeting-destination.mjs');
      db = await connectDestination();
      const present = await historySnapshot(db);
      assertThreePreserved(present, paidRows);
      const replay = plan.rows.every(row => present.some(h => h.id === row.id));
      const rehearsal = await executePlan(db, plan, sql, { replay, journal });
      const applied = await executePlan(db, plan, sql, { apply: true, replay, journal });
      const checkedReplay = await executePlan(db, plan, sql, { replay: true, journal });
      await journal({ phase: 'complete', rehearsal, applied, replay: checkedReplay });
      console.log(JSON.stringify({ planHash: hash(plan), rehearsal, applied, replay: checkedReplay }));
    } catch (error) {
      await journal({ phase: 'stopped', code: error.code || error.name });
      throw error;
    } finally { if (db) await db.end(); await handle.close(); }
    return;
  }
  await mkdir(directory, { mode: 0o700 });
  const { connectDestination } = await import('./annual-meeting-destination.mjs');
  const db = await connectDestination();
  try {
    const plan = await preparePlan(db, loaded, paidRows, sql);
    await writeFile(`${directory}/plan.json`, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ readOnly: true, planHash: hash(plan), proposed: 2, protectedTables: plan.tables.length,
      protectedHistoryRows: plan.historyBefore.length, providerCalls: 0, productionWrites: 0 }));
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1; });
}
