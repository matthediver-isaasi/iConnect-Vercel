import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectDestination } from './annual-meeting-destination.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const dir = 'private/bnms-deleted-member-dd';
const apply = process.argv[2] === '--apply';
assert.ok(process.argv.length === 2 || (apply && process.argv.length === 4));
const qi = s => { assert.match(s, /^[a-z_][a-z0-9_]*$/); return `"${s}"`; };
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const db = await connectDestination();
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='60s'");
  await db.query("SET LOCAL lock_timeout='5s'");
  if (apply) {
    // Prevent inserted soft references as well as FK children while revalidating.
    const tables = (await db.query(`SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema='public' AND (column_name IN ('form_submission_id','submission_id',
      'case_study_submission_id','copyright_submission_id','response_id',
      'due_diligence_submission_id','form_submission_due_diligence_id',
      'swapped_from_submission_id','swapped_to_submission_id'))
      ORDER BY table_name`)).rows.map(r => r.table_name);
    await db.query(`LOCK TABLE ${[...new Set([...tables, 'form_submission', 'member', 'submission_document_comment'])].sort().map(t => `public.${qi(t)}`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
  }
  const all = (await db.query(`
    SELECT to_jsonb(d) dd,to_jsonb(s) submission,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM form_submission_pipeline_entity p
       WHERE p.form_submission_id=s.id::text) links
    FROM form_submission_due_diligence d LEFT JOIN form_submission s ON s.id=d.form_submission_id
    WHERE d.tenant_id=$1 ORDER BY d.id`, [tenant])).rows;
  const members = (await db.query(`SELECT id,tenant_id,email,login_enabled FROM member
    WHERE tenant_id=$1 ORDER BY id`, [tenant])).rows;
  const byId = new Map(members.map(m => [m.id, m]));
  const candidates = all.filter(r => {
    if (!r.submission) return false;
    assert.equal(r.submission.tenant_id, tenant);
    const pipelineIds = [...new Set((r.links || []).filter(p => p.entity_type === 'member').map(p => {
      assert.equal(p.tenant_id, tenant); return p.entity_id;
    }))];
    const memberId = r.submission.created_member_id || r.submission.member_id
      || (pipelineIds.length === 1 ? pipelineIds[0] : null);
    const m = byId.get(memberId);
    if (!m || m.email !== `deleted_${m.id}@deleted.local`) return false;
    assert.equal(m.login_enabled, false);
    // Never delete a multi-person application that also links to a live member.
    for (const id of [r.submission.created_member_id, r.submission.member_id, ...pipelineIds].filter(Boolean)) {
      assert.equal(byId.get(id)?.email, `deleted_${id}@deleted.local`);
    }
    return true;
  });
  const formIds = [...new Set(candidates.map(r => r.submission.id))].sort();
  const ddIds = candidates.map(r => r.dd.id).sort();
  const columns = (await db.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND (column_name IN ('form_submission_id','submission_id',
      'case_study_submission_id','copyright_submission_id','response_id',
      'due_diligence_submission_id','form_submission_due_diligence_id',
      'swapped_from_submission_id','swapped_to_submission_id'))
    ORDER BY table_name,column_name`)).rows;
  const dependents = {};
  for (const c of columns) {
    const ids = c.column_name.includes('due_diligence') || c.column_name.startsWith('swapped_') ? [...formIds, ...ddIds] : formIds;
    const rows = (await db.query(`SELECT to_jsonb(r) row FROM public.${qi(c.table_name)} r
      WHERE ${qi(c.column_name)}::text=ANY($1::text[]) ORDER BY to_jsonb(r)::text`, [ids])).rows.map(r => r.row);
    for (const r of rows) {
      if (Object.hasOwn(r, 'tenant_id')) assert.equal(r.tenant_id, tenant, `Foreign/unscoped dependency: ${c.table_name}`);
    }
    if (rows.length) dependents[`${c.table_name}.${c.column_name}`] = rows;
  }
  const documentIds = (dependents['submission_document.form_submission_id'] || []).map(r => r.id);
  const comments = (await db.query(`SELECT to_jsonb(r) row FROM submission_document_comment r
    WHERE submission_document_id=ANY($1::uuid[]) ORDER BY id`, [documentIds])).rows.map(r => r.row);
  for (const r of comments) assert.equal(r.tenant_id, tenant);
  if (comments.length) dependents['submission_document_comment.submission_document_id'] = comments;
  const superseding = (await db.query(`SELECT id FROM submission_document
    WHERE superseded_by_id=ANY($1::uuid[]) AND NOT (id=ANY($1::uuid[]))`, [documentIds])).rows;
  assert.equal(superseding.length, 0, 'Other submissions reference these documents');
  const snapshot = { all, candidates, formIds, ddIds, dependents,
    members: members.filter(m => candidates.some(r => r.submission.created_member_id === m.id
      || r.submission.member_id === m.id || r.links?.some(p => p.entity_type === 'member' && p.entity_id === m.id))) };
  const hash = digest(snapshot);
  console.log(JSON.stringify({ dashboardTotal: all.length, deleteDD: ddIds.length, deleteForms: formIds.length,
    retainDD: all.length - ddIds.length, dependencies: Object.fromEntries(Object.entries(dependents).map(([k,v]) => [k,v.length])), sha256: hash }, null, 2));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!apply) {
    fs.writeFileSync(`${dir}/audit.json`, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await db.query('ROLLBACK');
  } else {
    assert.equal(hash, process.argv[3], 'Live data changed; re-audit before deleting');
    assert.equal(digest(JSON.parse(fs.readFileSync(`${dir}/audit.json`))), hash);
    assert.equal(ddIds.length, 38);
    assert.equal(formIds.length, 38);
    assert.equal(all.length, 48);
    const cascadeTables = new Set([
      'form_due_diligence_field_mapping_workflow_outbox', 'form_due_diligence_initialization',
      'form_due_diligence_one_off_ready', 'form_paid_pipeline_operation',
      'form_stripe_address_mapping_ledger', 'form_stripe_address_mapping_target',
      'form_submission_due_diligence', 'form_submission_entity_creation',
      'form_submission_structured_action', 'submission_document', 'submission_document_comment',
    ]);
    const allowed = new Set([...cascadeTables, 'form_submission_pipeline_entity', 'member_note']);
    for (const key of Object.keys(dependents)) assert.ok(allowed.has(key.split('.')[0]), `Unreviewed dependent ${key}`);
    // Reject new schema cascades rather than silently broadening the deletion.
    const fks = (await db.query(`SELECT c.relname child FROM pg_constraint f
      JOIN pg_class c ON c.oid=f.conrelid
      WHERE f.contype='f' AND f.confrelid=ANY($1::regclass[])`,
      [[...cascadeTables, 'form_submission'].map(t => `public.${t}`)])).rows;
    const checkedAbsent = new Set(['article_brief', 'department_current_set_commit',
      'form_submission_email', 'form_stripe_address_mapping_processing_lease',
      'form_stripe_address_mapping_retry', 'form_due_diligence_action_checkpoint',
      'form_due_diligence_one_off_ready_recovery', 'form_payment_completion_retry',
      'certificate_survey_entitlement']);
    for (const { child } of fks) assert.ok(cascadeTables.has(child) || checkedAbsent.has(child), `Unreviewed FK child ${child}`);
    const receiptPath = `${dir}/receipt.json`;
    assert.ok(!fs.existsSync(receiptPath), 'Already completed');
    fs.writeFileSync(`${dir}/approved-backup.json`, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: 'wx' });
    const links = await db.query(`DELETE FROM form_submission_pipeline_entity
      WHERE tenant_id=$1::text AND form_submission_id=ANY($2::text[]) RETURNING id`, [tenant, formIds]);
    assert.equal(links.rowCount, 67);
    const deleted = await db.query(`DELETE FROM form_submission
      WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) RETURNING id`, [tenant, formIds]);
    assert.equal(deleted.rowCount, 38);
    const verify = async () => {
      for (const [table, ids] of [['form_submission', formIds], ['form_submission_due_diligence', ddIds]]) {
        assert.equal(Number((await db.query(`SELECT count(*) n FROM ${qi(table)} WHERE id=ANY($1::uuid[])`, [ids])).rows[0].n), 0);
      }
      const remaining = (await db.query(`SELECT to_jsonb(d) dd,to_jsonb(s) submission
        FROM form_submission_due_diligence d LEFT JOIN form_submission s ON s.id=d.form_submission_id
        WHERE d.tenant_id=$1 ORDER BY d.id`, [tenant])).rows;
      assert.deepEqual(remaining, all.filter(r => !ddIds.includes(r.dd.id)).map(({dd,submission}) => ({dd,submission})));
      for (const c of columns) {
        const ids = c.column_name.includes('due_diligence') || c.column_name.startsWith('swapped_') ? [...formIds, ...ddIds] : formIds;
        const rows = (await db.query(`SELECT to_jsonb(r) row FROM public.${qi(c.table_name)} r
          WHERE ${qi(c.column_name)}::text=ANY($1::text[]) ORDER BY to_jsonb(r)::text`, [ids])).rows.map(r => r.row);
        if (c.table_name === 'member_note') assert.deepEqual(rows, dependents[`${c.table_name}.${c.column_name}`] || []);
        else assert.equal(rows.length, 0, `Remaining submission dependency ${c.table_name}`);
      }
      assert.equal(Number((await db.query('SELECT count(*) n FROM submission_document_comment WHERE submission_document_id=ANY($1::uuid[])', [documentIds])).rows[0].n), 0);
    };
    await verify();
    await db.query('COMMIT');
    await verify();
    fs.writeFileSync(receiptPath, JSON.stringify({ committedAt: new Date().toISOString(), snapshotSha256: hash,
      deletedDueDiligence: 38, deletedFormSubmissions: 38, remainingDueDiligence: 10,
      verifiedAfterCommit: true, preservedMemberNotes: 35, storageFilesDeleted: false }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log('Committed and verified: 38 DD + 38 original submissions removed; 10 DD records unchanged.');
  }
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  throw e;
} finally { await db.end(); }
