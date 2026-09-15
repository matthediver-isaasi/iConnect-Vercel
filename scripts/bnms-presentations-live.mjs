import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildReport, checksum, readWorkbook, TENANT_ID, INPUT } from './bnms-presentations-proposal.mjs';

export const APPROVAL_DIR = 'reports/bnms-presentations/2026-09-15T13-27-11.746Z';
export const PROPOSAL_SHA = 'ff16e5604fe73e001df933cea278f1f05d1da92c4ffd4558b9edb4a73368336f';
export const SOURCE_SHA = '0e522c5e96581bce9b23dc35841638724266a98c5060d79c19ac66153dbbb998';
export const SNAPSHOT_SHA = '7aa2c4a3c4abb2812f1c476fb2ed82ab6f0c4b9655132c943e20d804f0fdc838';
export const RESOURCE_COLUMNS = [
  'id','title','description','subcategories','resource_type','target_url','open_in_new_tab','image_url',
  'release_date','is_public','allowed_role_ids','tags','author_id','author_name','folder_id','status',
  'tenant_id','search_text','linked_events','seo_title','seo_description','og_image_url','is_sample','member_group_id',
];
const PATCH_FIELDS = ['title','description','release_date','subcategories'];

export function loadApproval() {
  const bytes = readFileSync(`${APPROVAL_DIR}/proposal.json`);
  const snapshotBytes = readFileSync(`${APPROVAL_DIR}/destination-snapshot.json`);
  const input = readFileSync(INPUT);
  assert.equal(checksum(bytes), PROPOSAL_SHA, 'Proposal file changed');
  assert.equal(checksum(snapshotBytes), SNAPSHOT_SHA, 'Approved snapshot changed');
  assert.equal(checksum(input), SOURCE_SHA, 'Workbook changed');
  const report = JSON.parse(bytes), before = JSON.parse(snapshotBytes), workbook = readWorkbook(input);
  assert.equal(report.inputChecksum, SOURCE_SHA);
  assert.equal(report.snapshotChecksum, SNAPSHOT_SHA);
  for (const [path, hash] of Object.entries(report.generatorChecksums)) {
    assert.equal(checksum(readFileSync(path)), hash, `Approved generator changed: ${path}`);
  }
  const replay = buildReport(workbook, before.resources, before.categories);
  for (const [key, value] of Object.entries(replay)) assert.deepEqual(report[key], value, `Approval replay differs: ${key}`);
  assert.deepEqual(
    [report.summary.inserts, report.summary.updates, report.summary.unchanged, report.summary.blocked],
    [1354, 4, 0, 87],
    'Approved action totals differ',
  );
  return { report, before, workbook };
}

// UUIDv5 namespace is the fixed tenant; row numbers and workbook hash pin replay.
export function resourceId(row, sourceChecksum = SOURCE_SHA) {
  const hash = createHash('sha1').update(Buffer.from(TENANT_ID.replaceAll('-', ''), 'hex'))
    .update(`presentations:${sourceChecksum}:${row}`).digest().subarray(0, 16);
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function normalized(snapshot) {
  return {
    tenant: snapshot.tenant,
    categories: [...snapshot.categories].sort((a,b)=>a.id.localeCompare(b.id)),
    resources: snapshot.resources.map(r => ({
      ...r, release_date: r.release_date ? new Date(r.release_date).toISOString() : null,
    })).sort((a,b)=>a.id.localeCompare(b.id)),
  };
}
export function assertSnapshot(actual, expected, message = 'Destination drift') {
  assert.deepEqual(normalized(actual), normalized(expected), message);
}

export function planApproved(bundle) {
  const { report, before } = bundle;
  assert.equal(report.tenantId, TENANT_ID);
  assert.deepEqual(before.tenant, {id:TENANT_ID,name:'BNMS'});
  assert(before.resources.every(r=>r.tenant_id === TENANT_ID), 'Foreign resource');
  assert(before.categories.every(r=>r.tenant_id === TENANT_ID), 'Foreign taxonomy');
  const inserts = [], updates = [], skipped = [];
  for (const row of report.rows) {
    if (row.status === 'blocked' || row.status === 'unchanged') {
      skipped.push({ row:row.row, status:row.status, issues:row.issues });
      continue;
    }
    assert(['insert','update'].includes(row.status), 'Unapproved action');
    assert.equal(row.issues.length, 0, 'Blocked row cannot be written');
    assert.equal(row.proposed.tenant_id, TENANT_ID);
    assert.equal(row.proposed.is_public, false, 'All approved presentations must remain member-only');
    assert.equal(row.source['Member Only'], 'Yes');
    if (row.status === 'insert') {
      assert.equal(row.before, null);
      assert.equal(row.candidateIds.length, 0);
      const record = {
        ...Object.fromEntries(RESOURCE_COLUMNS.map(k=>[k,null])),
        is_sample:false, ...row.proposed, id:resourceId(row.row, report.inputChecksum),
      };
      assert.equal(record.resource_type, 'external_link');
      assert.equal(record.member_group_id, null);
      assert.equal(record.status, 'active');
      assert.deepEqual(record.tags, []);
      assert.deepEqual(record.allowed_role_ids, []);
      assert.deepEqual(Object.keys(record).sort(), [...RESOURCE_COLUMNS].sort());
      assert(!before.resources.some(r=>r.id === record.id), 'Insert ID already belongs to an approved before-row');
      inserts.push({ row:row.row, record });
    } else {
      assert(row.before && row.before.tenant_id === TENANT_ID);
      assert(Object.keys(row.patch).every(k=>PATCH_FIELDS.includes(k)), 'Unapproved update field');
      assert.deepEqual(row.proposed, {...row.before,...row.patch}, 'Patch does not reproduce proposed record');
      assert.deepEqual(before.resources.find(r=>r.id === row.before.id), row.before);
      for (const tag of row.before.tags ?? []) assert(row.proposed.tags.includes(tag), 'Tag removed');
      for (const sub of row.before.subcategories ?? []) assert(row.proposed.subcategories.includes(sub), 'Classification removed');
      assert.deepEqual(row.proposed.allowed_role_ids, row.before.allowed_role_ids);
      updates.push({ row:row.row, before:row.before, record:row.proposed });
    }
  }
  const ids = [...inserts.map(p=>p.record.id),...updates.map(p=>p.record.id)];
  assert.equal(new Set(ids).size, ids.length, 'Several approved writes target one ID');
  const expected = structuredClone(before);
  for (const p of updates) expected.resources[expected.resources.findIndex(r=>r.id === p.record.id)] = p.record;
  expected.resources.push(...inserts.map(p=>p.record));
  expected.resources.sort((a,b)=>a.id.localeCompare(b.id));
  return { inserts, updates, skipped, expected };
}

export async function sqlSnapshot(client) {
  const tenant = await client.query('SELECT id, name FROM public.tenant WHERE id = $1', [TENANT_ID]);
  assert.deepEqual(tenant.rows, [{id:TENANT_ID,name:'BNMS'}], 'SQL tenant identity mismatch');
  const read = async table => (await client.query(
    `SELECT to_jsonb(r) AS record FROM public.${table} r WHERE tenant_id = $1 ORDER BY id`, [TENANT_ID],
  )).rows.map(r=>r.record);
  return { tenant:tenant.rows[0], resources:await read('resource'), categories:await read('resource_category') };
}

export function verifyApplied(bundle, after) {
  const plan = planApproved(bundle);
  assertSnapshot(after, plan.expected, 'Unexpected data or access changes');
  const replay = buildReport(bundle.workbook, after.resources, after.categories);
  for (const row of bundle.report.rows) {
    const result = replay.rows.find(r=>r.row === row.row);
    if (['insert','update','unchanged'].includes(row.status)) assert.equal(result.status, 'unchanged', `Row ${row.row} is not replay-safe`);
    else assert.equal(result.status, 'blocked', `Blocked row ${row.row} unexpectedly resolved`);
  }
  assert.equal(replay.summary.inserts, 0);
  assert.equal(replay.summary.updates, 0);
  return replay.summary;
}

export async function applyApproved({client, bundle, journal}) {
  const plan = planApproved(bundle);
  // Do the expensive workbook matching before taking any database locks. Full
  // snapshot equality below proves the committed result is this verified plan.
  const replaySummary = verifyApplied(bundle, plan.expected);
  let commitStarted = false, writes = 0;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    // Briefly fence generic API writes too; tenant-only advisory locks would not
    // prevent a new matching resource from appearing during this import.
    await client.query('LOCK TABLE public.resource, public.resource_category IN SHARE ROW EXCLUSIVE MODE');
    await client.query('SELECT id FROM public.tenant WHERE id = $1 FOR SHARE', [TENANT_ID]);
    const schema = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='resource' ORDER BY ordinal_position",
    );
    assert.deepEqual(schema.rows.map(r=>r.column_name), RESOURCE_COLUMNS, 'Resource schema changed');
    const triggers = await client.query("SELECT tgname FROM pg_trigger WHERE tgrelid='public.resource'::regclass AND NOT tgisinternal");
    assert.equal(triggers.rows.length, 0, 'Unreviewed resource trigger');
    const current = await sqlSnapshot(client);
    let alreadyApplied = false;
    try { assertSnapshot(current, plan.expected); alreadyApplied = true; } catch { /* Only the exact approved before-state is writable. */ }
    if (alreadyApplied) {
      await client.query('ROLLBACK');
      journal({status:'already_applied',writes:0});
      return {status:'already_applied',writes:0,inserted:0,updated:0,after:current};
    }
    assertSnapshot(current, bundle.before, 'Destination changed since approval; no writes permitted');
    journal({status:'transaction_intent',inserts:plan.inserts.map(p=>({row:p.row,id:p.record.id})),
      updates:plan.updates.map(p=>({row:p.row,id:p.record.id})),skipped:plan.skipped});
    if (plan.inserts.length) {
      const columns = RESOURCE_COLUMNS.join(', ');
      const result = await client.query(
        `INSERT INTO public.resource (${columns})
         SELECT ${RESOURCE_COLUMNS.map(k=>`p.${k}`).join(', ')}
         FROM jsonb_populate_recordset(NULL::public.resource, $1::jsonb) p
         WHERE p.tenant_id = $2
         RETURNING id`,
        [JSON.stringify(plan.inserts.map(p=>p.record)),TENANT_ID],
      );
      assert.equal(result.rowCount, plan.inserts.length, 'Insert count mismatch');
      assert.deepEqual(result.rows.map(r=>r.id).sort(), plan.inserts.map(p=>p.record.id).sort());
      writes += result.rowCount;
    }
    if (plan.updates.length) {
      const result = await client.query(
        `UPDATE public.resource r SET title = p.title, description = p.description,
           release_date = p.release_date, subcategories = p.subcategories
         FROM jsonb_to_recordset($1::jsonb) AS p
           (id uuid, title text, description text, release_date timestamptz, subcategories text[], before jsonb)
         WHERE r.id = p.id AND r.tenant_id = $2 AND to_jsonb(r) = p.before
         RETURNING r.id`,
        [JSON.stringify(plan.updates.map(p=>({...p.record,before:p.before}))),TENANT_ID],
      );
      assert.equal(result.rowCount, plan.updates.length, 'Conditional update count mismatch');
      assert.deepEqual(result.rows.map(r=>r.id).sort(), plan.updates.map(p=>p.record.id).sort());
      writes += result.rowCount;
    }
    const after = await sqlSnapshot(client);
    assertSnapshot(after, plan.expected, 'Unexpected data or access changes inside transaction');
    journal({status:'verified_in_transaction',writes,replaySummary});
    journal({status:'commit_intent',writes});
    commitStarted = true;
    await client.query('COMMIT');
    journal({status:'committed',writes,inserted:plan.inserts.length,updated:plan.updates.length});
    return {status:'applied',writes,inserted:plan.inserts.length,updated:plan.updates.length,after};
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    journal({status:commitStarted?'commit_outcome_requires_reconciliation':'rolled_back',
      attemptedWrites:writes,confirmedWrites:commitStarted?null:0,error:error.message});
    throw error;
  }
}