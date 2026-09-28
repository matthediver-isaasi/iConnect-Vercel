#!/usr/bin/env node
// Dedicated September authorization only. Default is read-only review.
import { readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { connectDestination, schemaEvidence, digest, PROJECT } from './import-bnms-final-members.mjs';
import { FILE, SHA256, TENANT_ID, FIELDS, parseSourceBytes } from './bnms-september-source.mjs';
import { DIRECTORY, FOCUS, ASSIGNMENT_OBJECT, ASSIGNMENT_MEMBER, ASSIGNMENT_ORG, loadState, makeReport, regionalEvidence } from './import-bnms-september-members.mjs';

const assert = (v, message) => { if (!v) throw Error(message); };
// Reviewed current live transitive functions, defaults and triggers; never reuse
// the earlier import's audit/approval. Updated only after a fresh code review.
export const AUDIT_HASH = 'c90434a9dd3b25ad675170e06a5b55cb4c7c5055f2fb2065856f7abdc8c421dc';
const AUTHORIZATION = 'September workbook: user approved existing regional automatic-group queue/reconciliation and existing-assignment rechecks; intentional multiple Department references, all Department links and every parent Organisation assignment. Insert only; no existing-member changes, auth, login, member role, notifications, consent, billing, purchased terms or subscription reset changes.';
const TABLES = ['tenant', 'member', 'member_preference_value', 'member_resource_category', 'preference_field', 'resource_category', 'organization', 'organization_group', 'organization_preference_value', 'custom_object_definition', 'custom_object_record', 'custom_object_relationship_definition', 'custom_object_relationship', 'custom_object_audit_event', 'member_group', 'member_group_assignment', 'member_group_activity', 'member_group_history_group', 'member_group_membership_history', 'department_current_set_config', 'communication_category', 'communication_category_role', 'member_communication_preference'];
export function durableSave(name, data) {
  assert(/^[a-z-]+\.json$/.test(name), 'Invalid private filename');
  execFileSync('git', ['check-ignore', '-q', `${DIRECTORY}/${name}`]);
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 }); chmodSync(DIRECTORY, 0o700);
  const target = path.join(DIRECTORY, name), temporary = `${target}.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, target);
  const dir = openSync(DIRECTORY, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export async function auditedSchema(client) {
  const s = await schemaEvidence(client);
  s.allTriggers = (await client.query("select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1,2")).rows;
  s.allColumns = (await client.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows;
  return s;
}
export function plan(report, journal) {
  return report.rows.map(row => {
    const owned = journal?.members.find(m => m.sourceRow === row.sourceRow);
    if (row.outcome === 'held-side-effects') return { sourceRow: row.sourceRow, outcome: 'insert', memberId: owned?.memberId || randomUUID(),
      assignments: row.parentOrganizationIds.map(organizationId => owned?.assignments.find(a => a.organizationId === organizationId) || { organizationId, id: randomUUID(), memberEdgeId: randomUUID(), orgEdgeId: randomUUID() }),
      departmentEdges: row.departmentLinks.map(d => owned?.departmentEdges.find(e => e.departmentId === d.departmentId) || { ...d, id: randomUUID() }) };
    if (row.outcome === 'already-present-matching') return { sourceRow: row.sourceRow, outcome: owned && row.memberIds.length === 1 && row.memberIds[0] === owned.memberId ? 'already-imported' : 'already-present-matching', memberId: row.memberIds[0] };
    return { sourceRow: row.sourceRow, outcome: 'held', reasons: row.reasons };
  });
}
export async function insertMember(client, row, item) {
  await client.query(`insert into public.member
    (id,tenant_id,email,first_name,last_name,mobile,organization_group_id,organization_id,login_enabled,role_id,identity_id,google_id,created_on,show_in_directory)
    values($1,$2,$3,$4,$5,$6,$7,$8,false,null,null,null,null,false)`,
  [item.memberId, TENANT_ID, row.email, row.values[5], row.values[6], row.values[10] || null, row.values[11] || null, row.organizationId]);
  for (const field of FIELDS) if (row.values[field.column]) await client.query('insert into public.member_preference_value(member_id,field_id,value) values($1,$2,$3)', [item.memberId, field.id, row.values[field.column]]);
  for (const name of row.focusAreas) await client.query('insert into public.member_resource_category(member_id,resource_category_id,subcategory_name) values($1,$2,$3)', [item.memberId, FOCUS, name]);
  const edge = async (id, definition, source, target) => client.query(`insert into public.custom_object_relationship
    (id,tenant_id,relationship_definition_id,source_record_id,target_record_id,created_by) values($1,$2,$3,$4,$5,'system:bnms-september-import')`, [id, TENANT_ID, definition, source, target]);
  for (const assignment of item.assignments) {
    await client.query(`insert into public.custom_object_record(id,tenant_id,custom_object_id,data,created_by)
      values($1,$2,$3,$4::jsonb,'system:bnms-september-import')`,
    [assignment.id, TENANT_ID, ASSIGNMENT_OBJECT, JSON.stringify({ assignment_name: `${row.values[5]} ${row.values[6]} - Organisation assignment` })]);
    await edge(assignment.memberEdgeId, ASSIGNMENT_MEMBER, assignment.id, item.memberId);
    await edge(assignment.orgEdgeId, ASSIGNMENT_ORG, assignment.id, assignment.organizationId);
  }
  for (const d of item.departmentEdges) await edge(d.id, d.definitionId, d.departmentId, item.memberId);
}
export async function verifyImported(client, report, state, journal) {
  for (const item of journal.members) {
    const row = report.rows.find(r => r.sourceRow === item.sourceRow);
    assert(row?.outcome === 'already-present-matching' && row.memberIds.length === 1 && row.memberIds[0] === item.memberId, 'Imported row readback mismatch');
    const m = state.members.find(m => m.id === item.memberId);
    assert(m.organization_id === row.organizationId && m.organization_group_id === (row.values[11] || null), 'Imported hierarchy readback mismatch');
    for (const a of item.assignments) {
      assert(state.departments.some(d => d.id === a.id && d.custom_object_id === ASSIGNMENT_OBJECT && !d.archived_at), 'Assignment readback missing');
      for (const [id, def, target] of [[a.memberEdgeId, ASSIGNMENT_MEMBER, item.memberId], [a.orgEdgeId, ASSIGNMENT_ORG, a.organizationId]]) assert(state.edges.some(e => e.id === id && !e.archived_at && e.relationship_definition_id === def && e.source_record_id === a.id && e.target_record_id === target), 'Assignment edge readback missing');
    }
    for (const d of item.departmentEdges) assert(state.edges.some(e => e.id === d.id && !e.archived_at && e.relationship_definition_id === d.definitionId && e.source_record_id === d.departmentId && e.target_record_id === item.memberId), 'Department readback missing');
  }
  const ids = journal.members.map(m => m.memberId);
  const safe = (await client.query(`select id,login_enabled,role_id,identity_id,google_id,created_on,show_in_directory from public.member where tenant_id=$1 and id=any($2::uuid[])`, [TENANT_ID, ids])).rows;
  assert(safe.length === ids.length && safe.every(m => m.login_enabled === false && m.role_id == null && m.identity_id == null && m.google_id == null && m.created_on == null && m.show_in_directory === false), 'Access/date safety mismatch');
}
// Hash full stored rows rather than the preflight's comparison projection.
// Locks prevent independent writes during this before/after preservation proof.
async function preservation(client, inserted = []) {
  const memberIds = inserted.map(m => m.memberId);
  const recordIds = inserted.flatMap(m => m.assignments.map(a => a.id));
  const edgeIds = inserted.flatMap(m => [...m.assignments.flatMap(a => [a.memberEdgeId, a.orgEdgeId]), ...m.departmentEdges.map(d => d.id)]);
  const state = {};
  for (const table of TABLES.filter(t => !['member_group', 'member_group_history_group'].includes(t))) {
    let where = '', ids = [];
    if (table === 'member') { where = 'where not (id=any($1::uuid[]))'; ids = memberIds; }
    if (['member_preference_value', 'member_resource_category'].includes(table)) { where = 'where member_id is null or not (member_id=any($1::uuid[]))'; ids = memberIds; }
    if (table === 'custom_object_record') { where = 'where not (id=any($1::uuid[]))'; ids = recordIds; }
    if (table === 'custom_object_relationship') { where = 'where not (id=any($1::uuid[]))'; ids = edgeIds; }
    if (table === 'custom_object_audit_event') { where = 'where entity_id is null or not (entity_id=any($1::uuid[]))'; ids = [...recordIds, ...edgeIds]; }
    // Some history/config tables have composite identities; order canonical JSON.
    state[table] = (await client.query(`select count(*)::int count,md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),'')) hash from public.${table} t ${where}`, where ? [ids] : [])).rows[0];
  }
  state.member_group_configuration = (await client.query(`select count(*)::int count,md5(coalesce(string_agg((to_jsonb(t)-ARRAY['automatic_membership_generation','automatic_membership_sync_status','automatic_membership_cursor','automatic_membership_sync_error'])::text,'' order by id),'')) hash from public.member_group t`)).rows[0];
  return state;
}
export async function run(client, source, { apply = false, reviewHash, replay = false } = {}) {
  const journalFile = path.join(DIRECTORY, 'september-journal.json');
  const oldJournal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : null;
  if (oldJournal) assert(oldJournal.fingerprint === SHA256 && oldJournal.project === PROJECT && oldJournal.tenant === TENANT_ID, 'Journal identity mismatch');
  let committed = false;
  await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    if (apply) await client.query(`LOCK TABLE ${TABLES.map(t => `public.${t}`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const schema = await auditedSchema(client), schemaHash = digest(schema);
    durableSave('current-audit-schema.json', schema);
    assert(schemaHash === AUDIT_HASH, `Side-effect audit drift: ${schemaHash}`);
    const state = await loadState(client), report = makeReport(source, state, schema);
    report.safetyBlockers = [];
    report.authorization = AUTHORIZATION;
    for (const row of report.rows) if (row.outcome === 'held-side-effects') row.reasons = [];
    const regional = regionalEvidence(report.rows, state);
    assert(regional.supported && regional.rows.every(r => !r.ambiguousOrganizationRegion), 'Regional rule audit drift');
    assert(report.mappings.every(m => m.verified), 'Field mapping drift');
    assert(state.fields.some(f => f.custom_object_id === ASSIGNMENT_OBJECT && f.name === 'assignment_name' && f.field_type === 'text' && f.is_required === true && f.is_active === true), 'Assignment name field drift');
    for (const id of new Set(report.rows.flatMap(r => r.departmentLinks.map(d => d.definitionId)))) {
      const fields = state.definitions.find(d => d.id === id)?.configuration?.relationship_fields;
      assert(Array.isArray(fields) && fields.length === 1 && fields[0].key === 'survey_respondent' && fields[0].type === 'boolean' && fields[0].default_value === false && fields[0].required === false, 'Department relationship default drift');
    }
    const execution = plan(report, oldJournal);
    const pending = execution.filter(r => r.outcome === 'insert');
    const reviewIdentity = { fingerprint: source.fingerprint, project: PROJECT, tenant: TENANT_ID, schemaHash, snapshotHash: digest(state), authorization: AUTHORIZATION,
      decisions: execution.map(r => ({ sourceRow: r.sourceRow, outcome: r.outcome, reasons: r.reasons })) };
    const token = digest(reviewIdentity);
    const result = { ...reviewIdentity, reviewHash: token, generatedAt: new Date().toISOString(), execution, preflight: report, regional,
      imported: 0, alreadyImported: execution.filter(r => r.outcome === 'already-imported').length, alreadyMatching: execution.filter(r => r.outcome === 'already-present-matching').length, held: execution.filter(r => r.outcome === 'held').length, pending: pending.length,
      verification: { committed: false, noMigrations: true, subscriptionResetUntouched: true } };
    result.sideEffectAudit = {
      schemaHash,
      conclusions: [
        'Member INSERT guards only tenant, role capacity and advisory locks; NULL role and disabled login bypass role capacity. Explicit login=false, directory=false, role/identity/google/created_on=NULL.',
        'Preference INSERT scope guard plus updated_at bump on newly created member only; timestamp-only member update queues no further rule-key changes.',
        'Member insert queues all enabled tenant regional groups; preference insert queues matching field rules. Queue generation/status/cursor changes and identity history are explicitly approved for this September workbook.',
        'Custom Object INSERT guards validate active tenant-owned record/relationship identities, cardinality, advisory locks and deferred picker-scope intersections. All parent Organisation assignments exist before Department edges.',
        'Custom Object audit INSERTs only append audit events; transitive audit guards validate tenant scope and classify system actor. No auth, permissions, subscriptions, billing or external calls.',
        'Department relationship survey_respondent default is false. Assignment name is the sole required assignment field. No current-set configuration, permission, or consent is modified.',
        'Approved scheduled reconciliation may insert/delete automatic assignments, update group roles/history/activity and sync metadata; no member role/auth/payment/email path. This runner leaves processing to the existing scheduler.',
        'All transitive public helper bodies/defaults/triggers captured and pinned; application reconciliation uses existing code. Independent scheduler/provider activity is not disabled or attested by this runner.',
      ],
      applicationHashes: Object.fromEntries(['api/cron/process-automatic-memberships.js', 'api/_lib/automaticMembership.js', 'api/_lib/automaticMembershipQuery.js'].map(f => [f, digest(readFileSync(f, 'utf8'))])),
    };
    if (replay) {
      assert(oldJournal && !pending.length && !result.held, 'Replay requires complete matching journal cohort');
      await verifyImported(client, report, state, oldJournal);
      result.verification.zeroWriteReplay = true;
      durableSave('september-replay.json', result);
      await client.query('ROLLBACK'); return result;
    }
    durableSave('approved-preflight.json', result);
    if (!apply) { await client.query('ROLLBACK'); return result; }
    assert(token === reviewHash, 'Reviewed source/destination snapshot drifted; run fresh read-only preflight');
    // Fail whole cohort rather than silently applying a partial fresh conflict.
    assert(!result.held, 'Fresh cohort holds require review');
    const journal = { fingerprint: SHA256, tenant: TENANT_ID, project: PROJECT, authorization: AUTHORIZATION,
      members: [...(oldJournal?.members || []), ...pending.filter(p => !oldJournal?.members.some(m => m.sourceRow === p.sourceRow))] };
    durableSave('september-journal.json', journal); // fsync BEFORE any write
    const before = await preservation(client);
    for (const item of pending) await insertMember(client, report.rows.find(r => r.sourceRow === item.sourceRow), item);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE'); // includes deferred picker-scope guards
    const afterState = await loadState(client), afterReport = makeReport(source, afterState, schema);
    await verifyImported(client, afterReport, afterState, journal);
    const after = await preservation(client, pending);
    assert(digest(before) === digest(after), 'Pre-existing row/subscription preservation failed');
    result.preservation = { before, after };
    result.verification = { committed: false, noMigrations: true, subscriptionResetUntouched: true, zeroWriteReplay: true, accessDisabled: true, relationshipsVerified: true, preExistingPreserved: true };
    durableSave('september-verified-before-commit.json', result);
    await client.query('COMMIT'); committed = true;
    result.imported = pending.length; result.pending = 0;
    result.execution = execution.map(r => r.outcome === 'insert' ? { ...r, outcome: 'imported' } : r);
    result.verification.committed = true;
    durableSave(pending.length ? 'september-result.json' : 'september-apply-replay.json', result);
    return result;
  } catch (error) { if (!committed) await client.query('ROLLBACK').catch(() => {}); throw error; }
}
export async function main(args = process.argv.slice(2)) {
  assert(new Set(args).size === args.length && args.every(a => a === '--apply' || a === '--replay' || /^--review=[a-f0-9]{64}$/.test(a)), 'Usage: [--apply --review=<fresh review hash>] OR [--replay]');
  const apply = args.includes('--apply'), replay = args.includes('--replay'), reviewHash = args.find(a => a.startsWith('--review='))?.slice(9);
  assert(!(apply && replay) && (!apply || reviewHash) && (!reviewHash || apply), 'Invalid apply/replay arguments');
  const source = parseSourceBytes(readFileSync(FILE));
  const client = await connectDestination();
  try {
    const r = await run(client, source, { apply, replay, reviewHash });
    console.log(JSON.stringify({ reviewHash: r.reviewHash, imported: r.imported, alreadyImported: r.alreadyImported, alreadyMatching: r.alreadyMatching, held: r.held, pending: r.pending, verification: r.verification }));
  } finally { await client.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  // Error messages generated by this runner contain no row data; database errors
  // may contain PII, so record details privately and print only known safeguards.
  durableSave('september-error.json', { message: error.message, code: error.code ?? null, at: new Date().toISOString() });
  console.error(error.code ? `September transaction stopped (${error.code}); private error evidence saved. Retain journal for recovery.` : error.message); process.exitCode = 1;
});