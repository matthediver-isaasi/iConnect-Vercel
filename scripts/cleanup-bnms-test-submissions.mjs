// Authorized BNMS submitter-email cleanup. Audit by default; apply requires
// the exact private snapshot hash. No provider calls or CRM record deletions.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectDestination } from './annual-meeting-destination.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const dir = 'private/bnms-test-submission-cleanup';
const apply = process.argv[2] === '--apply';
assert.ok(process.argv.length === 2 || (apply && process.argv.length === 4));
const qi = s => { assert.match(s, /^[a-z_][a-z0-9_]*$/); return `"${s}"`; };
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const db = await connectDestination();
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='60s'");
  await db.query("SET LOCAL lock_timeout='5s'");
  assert.equal((await db.query('SELECT slug FROM tenant WHERE id=$1', [tenant])).rows[0]?.slug, 'bnms');
  const fks = (await db.query(`SELECT c.relname child,p.relname parent,
    ca.attname child_column,pa.attname parent_column,f.confdeltype action,
    cardinality(f.conkey) key_count FROM pg_constraint f
    JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=f.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid=p.oid AND pa.attnum=f.confkey[1]
    WHERE f.contype='f' AND n.nspname='public' ORDER BY 1,2,3,4`)).rows;
  const soft = (await db.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name IN
    ('form_submission_id','submission_id','response_id','case_study_submission_id',
     'copyright_submission_id','due_diligence_submission_id','form_submission_due_diligence_id',
     'swapped_from_submission_id','swapped_to_submission_id')
    ORDER BY 1,2`)).rows;
  // Lock the complete reference graph, including soft children, before audit.
  const tables = new Set(['form_submission', 'event_survey_assignment', ...soft.map(c => c.table_name)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fks) if (tables.has(f.parent) && !tables.has(f.child)) {
      tables.add(f.child); changed = true;
    }
  }
  if (apply) await db.query(`LOCK TABLE ${[...tables].sort().map(qi).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
  const submissions = (await db.query(`SELECT to_jsonb(s) row FROM form_submission s
    WHERE tenant_id=$1 AND submitted_by_email ILIKE '%isaasi%' ORDER BY id`, [tenant])).rows.map(r => r.row);
  const ids = submissions.map(r => r.id);
  const retainedDigest = async () => (await db.query(`SELECT count(*)::int count,
    md5(coalesce(string_agg(to_jsonb(s)::text, '' ORDER BY id),'')) digest
    FROM form_submission s WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[]))`, [tenant, ids])).rows[0];
  const retained = await retainedDigest();
  const rows = { form_submission: submissions };
  const add = (table, found) => {
    const old = rows[table] || [];
    const map = new Map(old.map(r => [JSON.stringify(r), r]));
    for (const r of found) {
      if (Object.hasOwn(r, 'tenant_id')) assert.equal(r.tenant_id, tenant, `Foreign/unscoped row in ${table}`);
      map.set(JSON.stringify(r), r);
    }
    if (map.size) rows[table] = [...map.values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return map.size > old.length;
  };
  const select = async (table, column, values) => (await db.query(
    `SELECT to_jsonb(r) row FROM ${qi(table)} r WHERE ${qi(column)}::text=ANY($1::text[])`,
    [[...new Set(values.filter(v => v != null).map(String))]],
  )).rows.map(r => r.row);
  const dd = await select('form_submission_due_diligence', 'form_submission_id', ids);
  for (const c of soft) add(c.table_name, await select(c.table_name, c.column_name, [...ids, ...dd.map(r => r.id)]));
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fks) {
      if (!rows[f.parent]?.length || f.parent === 'member_note') continue;
      assert.equal(f.key_count, 1, `Composite FK needs review: ${f.child}`);
      changed = add(f.child, await select(f.child, f.child_column, rows[f.parent].map(r => r[f.parent_column]))) || changed;
    }
  }
  const assignmentIds = [...new Set(submissions.map(r => r.survey_assignment_id).filter(Boolean))];
  const assignments = await select('event_survey_assignment', 'id', assignmentIds);
  for (const a of assignments) assert.equal(a.tenant_id, tenant);
  const snapshot = { tenant, match: 'submitted_by_email ILIKE %isaasi%', rows, assignments, retained, fks, soft };
  const digest = hash(snapshot);
  const counts = Object.fromEntries(Object.entries(rows).map(([k,v]) => [k,v.length]));
  console.log(JSON.stringify({ counts, assignments: assignments.length, retained, sha256: digest }, null, 2));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!apply) {
    assert.ok(!fs.existsSync(`${dir}/receipt.json`), 'Cleanup already completed');
    fs.writeFileSync(`${dir}/audit.json`, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await db.query('ROLLBACK');
  } else {
    assert.equal(digest, process.argv[3], 'Live data changed; re-audit');
    assert.equal(hash(JSON.parse(fs.readFileSync(`${dir}/audit.json`))), digest);
    assert.equal(ids.length, 25);
    // Reviewed submission-only dependents. CRM notes survive unchanged.
    const approved = new Set([
      'form_submission', 'certificate_survey_entitlement', 'certificate_survey_credential',
      'form_due_diligence_initialization', 'form_paid_pipeline_operation',
      'form_stripe_address_mapping_ledger', 'form_stripe_address_mapping_processing_lease',
      'form_stripe_address_mapping_retry', 'form_stripe_address_mapping_target',
      'form_submission_due_diligence', 'form_submission_entity_creation',
      'form_submission_pipeline_entity', 'form_submission_structured_action',
      'member_note', 'survey_answer',
    ]);
    for (const name of Object.keys(rows)) assert.ok(approved.has(name), `Unreviewed dependent: ${name}`);
    assert.ok(!fs.existsSync(`${dir}/receipt.json`), 'Cleanup already completed');
    if (fs.existsSync(`${dir}/approved-backup.json`)) {
      assert.equal(hash(JSON.parse(fs.readFileSync(`${dir}/approved-backup.json`))), digest);
    } else {
      fs.writeFileSync(`${dir}/approved-backup.json`, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: 'wx' });
    }
    const order = [], seen = new Set(), visiting = new Set();
    const visit = table => {
      if (seen.has(table) || table === 'member_note') return;
      assert.ok(!visiting.has(table), `Cyclic deletion dependency: ${table}`);
      visiting.add(table);
      for (const f of fks) if (f.parent === table && rows[f.child]?.length) visit(f.child);
      visiting.delete(table); seen.add(table); order.push(table);
    };
    for (const table of Object.keys(rows)) visit(table);
    // Soft-linked children must also precede their owning form.
    order.splice(order.indexOf('form_submission'), 1);
    order.push('form_submission');
    const deleted = {};
    // Some submission-owned tables have composite keys, not an id column.
    // All children of the selected submissions were snapshotted and locked.
    const rowKey = table => {
      const key = ['id', 'form_submission_id', 'submission_id'].find(k => rows[table].every(r => r[k]));
      assert.ok(key, `Missing reviewed row selector: ${table}`);
      return key;
    };
    for (const table of order) {
      const key = rowKey(table);
      const result = await db.query(`DELETE FROM ${qi(table)} WHERE ${qi(key)}::text=ANY($1::text[]) RETURNING ${qi(key)}`,
        [rows[table].map(r => String(r[key]))]);
      assert.equal(result.rowCount, rows[table].length, `Unexpected deletion count: ${table}`);
      deleted[table] = result.rowCount;
    }
    // Refresh counts only; historical first/last response timestamps remain.
    await db.query(`UPDATE event_survey_assignment a SET response_count=(
      SELECT count(*) FROM form_submission s WHERE s.survey_assignment_id=a.id AND s.tenant_id=a.tenant_id
    ), updated_at=now() WHERE a.tenant_id=$1 AND a.id=ANY($2::uuid[])`, [tenant, assignmentIds]);
    const verify = async () => {
      for (const table of order) assert.equal(
        (await select(table, rowKey(table), rows[table].map(r => r[rowKey(table)]))).length, 0, `${table} remains`);
      assert.equal(Number((await db.query(`SELECT count(*) n FROM form_submission
        WHERE tenant_id=$1 AND submitted_by_email ILIKE '%isaasi%'`, [tenant])).rows[0].n), 0);
      assert.deepEqual(await retainedDigest(), retained, 'Nonmatching submissions changed');
      const notes = await select('member_note', 'id', rows.member_note.map(r => r.id));
      assert.deepEqual(notes.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), rows.member_note);
      const after = await select('event_survey_assignment', 'id', assignmentIds);
      for (const a of after) {
        const n = Number((await db.query(`SELECT count(*) n FROM form_submission
          WHERE tenant_id=$1 AND survey_assignment_id=$2`, [tenant, a.id])).rows[0].n);
        assert.equal(a.response_count, n);
        const before = assignments.find(r => r.id === a.id);
        const omit = ({ response_count, updated_at, ...rest }) => rest;
        assert.deepEqual(omit(a), omit(before));
      }
      return after.map(a => ({ id: a.id, response_count: a.response_count }));
    };
    const assignmentCounts = await verify();
    await db.query('COMMIT');
    fs.writeFileSync(`${dir}/receipt.json`, JSON.stringify({
      committedAt: new Date().toISOString(), sha256: digest, deleted, assignmentCounts,
      retained, memberNotesRetained: rows.member_note.length,
    }, null, 2), { mode: 0o600, flag: 'wx' });
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await verify();
    await db.query('COMMIT');
    console.log(JSON.stringify({ committed: true, independentlyVerified: true, deleted, assignmentCounts }));
  }
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  throw error;
} finally { await db.end(); }
