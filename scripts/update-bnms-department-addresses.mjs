#!/usr/bin/env node
/**
 * Pinned destination-only maintenance. Dry run first:
 *   node scripts/update-bnms-department-addresses.mjs
 *   node scripts/update-bnms-department-addresses.mjs --apply --preflight=<dry-run.json>
 *
 * No creates, no hierarchy importer, no blank clears. All writes commit together.
 * Each run saves immutable reports; before.json is fsynced before the first write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import {
  TENANT_ID, OBJECT_ID, PHONE_ID, PROJECT, KEYS, readSource, makePlan, stable, digest,
} from './lib/bnms-department-address-plan.mjs';
import { auditPhoneDependencies } from './lib/bnms-department-phone-audit.mjs';
import { APPROVED_RESOLUTIONS } from './lib/bnms-department-address-approvals.mjs';
import {
  validateCustomObjectFieldDefinition, validateCustomObjectRecordData,
} from '../api/_lib/customObjectDomain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTOR = 'system:bnms-department-addresses';
const TABLES = [
  'tenant', 'organization', 'custom_object_definition', 'preference_field',
  'custom_object_relationship_definition', 'custom_object_relationship', 'custom_object_record',
];
const check = (condition, message) => { if (!condition) throw new Error(message); };
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

// Exact JSON timestamps avoid pg's Date conversion losing sub-millisecond precision.
export async function readAll(client, table, where, params, lock = false) {
  check(TABLES.includes(table), 'Unapproved table');
  const output = [];
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await client.query(
      `SELECT to_jsonb(t) AS row FROM public."${table}" t
       WHERE (${where}) AND t.id > $${params.length + 1}::uuid
       ORDER BY t.id LIMIT 500 ${lock ? 'FOR UPDATE OF t' : ''}`,
      [...params, cursor],
    );
    output.push(...page.rows.map(({ row }) => row));
    if (page.rows.length < 500) break;
    cursor = page.rows.at(-1).row.id;
  }
  const count = await client.query(`SELECT count(*)::int n FROM public."${table}" t WHERE ${where}`, params);
  check(output.length === count.rows[0].n && new Set(output.map(x => x.id)).size === output.length,
    `Incomplete or duplicate pagination: ${table}`);
  return output;
}

export async function loadState(client, lock = false) {
  const scope = 't.tenant_id=$1';
  const tenant = await readAll(client, 'tenant', 't.id=$1', [TENANT_ID], lock);
  const objects = await readAll(client, 'custom_object_definition', 't.id=$1', [OBJECT_ID], lock);
  const fields = await readAll(client, 'preference_field', 't.custom_object_id=$1', [OBJECT_ID], lock);
  const organisations = await readAll(client, 'organization', scope, [TENANT_ID], lock);
  const records = await readAll(client, 'custom_object_record', 't.custom_object_id=$1', [OBJECT_ID], lock);
  const definitions = await readAll(client, 'custom_object_relationship_definition', scope, [TENANT_ID], lock);
  const edges = await readAll(client, 'custom_object_relationship',
    `t.tenant_id=$1 OR t.source_record_id IN
      (SELECT id FROM public.custom_object_record WHERE custom_object_id=$2)
     OR t.target_record_id IN
      (SELECT id FROM public.custom_object_record WHERE custom_object_id=$2)`,
    [TENANT_ID, OBJECT_ID], lock);
  return { tenant: tenant[0], object: objects[0], fields, organisations, records, definitions, edges };
}

export function assertFresh(expected, actual) {
  check(digest(expected) === digest(actual), 'Stale preflight: destination data or configuration changed; run a new dry run.');
}

// Hash every row in relevant tables, excluding only the explicitly permitted
// metadata/data changes. This proves our transaction did not alter other tenants,
// relationships, organisations, names, region, or any unrelated custom data.
export async function preservation(client, items, phoneChange) {
  const ids = items.filter(x => x.diffs.length).map(x => x.recordId);
  const patches = Object.fromEntries(items.map(x => [x.recordId, Object.keys(x.patch)]));
  const result = {};
  for (const table of TABLES) {
    let expression = 'to_jsonb(t)';
    let params = [];
    if (table === 'custom_object_record') {
      expression = `CASE WHEN t.id=ANY($1::uuid[]) THEN
        (to_jsonb(t)-'updated_at'-'updated_by'-'data') ||
        jsonb_build_object('data', t.data - ARRAY(SELECT jsonb_array_elements_text($2::jsonb->t.id::text)))
        ELSE to_jsonb(t) END`;
      params = [ids, JSON.stringify(patches)];
    } else if (table === 'preference_field' && phoneChange) {
      expression = `CASE WHEN t.id=$1 THEN to_jsonb(t)-'field_type'-'updated_at'-'updated_by'
        ELSE to_jsonb(t) END`;
      params = [PHONE_ID];
    }
    const { rows } = await client.query(`SELECT count(*)::int count,
      md5(coalesce(string_agg(md5((${expression})::text), '' ORDER BY t.id),'')) hash
      FROM public."${table}" t`, params);
    result[table] = rows[0];
  }
  return result;
}

export async function applyChanges(client, state, plan) {
  check(plan.blockers.length === 0, 'Cannot apply blocked plan');
  const fields = state.fields.map(f => f.id === PHONE_ID ? { ...f, field_type: 'text' } : f);
  if (plan.phoneChange.required) {
    const field = fields.find(f => f.id === PHONE_ID);
    const validation = validateCustomObjectFieldDefinition(field, { tenantId: TENANT_ID, customObjectId: OBJECT_ID });
    check(validation.ok, `Invalid phone definition: ${validation.errors.join('; ')}`);
    const changed = await client.query(`UPDATE public.preference_field f
      SET field_type='text', updated_at=now(), updated_by=$4
      WHERE id=$1 AND tenant_id=$2 AND custom_object_id=$3 AND field_type='number'
        AND to_jsonb(f)=$5::jsonb RETURNING id`,
    [PHONE_ID, TENANT_ID, OBJECT_ID, ACTOR, JSON.stringify(plan.phoneField)]);
    check(changed.rowCount === 1, 'Stale phone definition; transaction must roll back');
  }
  let updated = 0;
  for (const item of plan.items) {
    if (!item.diffs.length) continue;
    check(Object.keys(item.patch).every(key => KEYS.includes(key)
      && typeof item.patch[key] === 'string' && item.patch[key].trim()),
    `Forbidden or blank patch at row ${item.sourceRow}`);
    const before = state.records.find(r => r.id === item.recordId);
    check(before?.tenant_id === TENANT_ID && before.custom_object_id === OBJECT_ID
      && !before.archived_at, 'Record ownership/lifecycle mismatch');
    const validated = validateCustomObjectRecordData({
      data: item.patch, fields, existingData: before.data, mode: 'update',
    });
    check(validated.ok && stable(validated.data) === stable(item.afterData),
      `Record validation changed for source row ${item.sourceRow}`);
    const changed = await client.query(`UPDATE public.custom_object_record r
      SET data=data || $4::jsonb, updated_at=now(), updated_by=$5
      WHERE id=$1 AND tenant_id=$2 AND custom_object_id=$3 AND archived_at IS NULL
        AND to_jsonb(r)=$6::jsonb RETURNING id`,
    [item.recordId, TENANT_ID, OBJECT_ID, JSON.stringify(item.patch), ACTOR, JSON.stringify(before)]);
    check(changed.rowCount === 1, `Stale Department for source row ${item.sourceRow}; transaction must roll back`);
    updated++;
  }
  return updated;
}

export async function main(args = process.argv.slice(2)) {
  check(args.every(a => ['--apply', '--dry-run'].includes(a) || a.startsWith('--preflight=')), 'Unknown argument');
  check(!(args.includes('--apply') && args.includes('--dry-run')), 'Choose apply or dry-run, not both');
  const apply = args.includes('--apply');
  const priorPath = args.find(a => a.startsWith('--preflight='))?.slice(12);
  check(!apply || priorPath, 'Apply requires --preflight=<clean dry-run.json>');
  const prior = priorPath ? JSON.parse(fs.readFileSync(priorPath, 'utf8')) : null;
  const source = readSource();
  const runDir = path.join(ROOT, 'reports/bnms-department-addresses',
    `${new Date().toISOString().replaceAll(':', '-')}-${apply ? 'apply' : 'dry-run'}`);
  save(path.join(runDir, 'source.json'), source);
  const client = await connectDestination();
  let committed = false;
  try {
    check(client.connection.stream.encrypted && client.connection.stream.authorized, 'Verified TLS is required');
    await client.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='90s'");
    await client.query("SET LOCAL lock_timeout='10s'");
    if (apply) {
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) acquired",
        [`${TENANT_ID}:department-addresses`]);
      check(lock.rows[0].acquired, 'Another address import is running');
      // Shared with the application's current-set mutation triggers. Acquire
      // before row locks, following the application's lock order.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`department-current-set:${TENANT_ID}`]);
    }
    const state = await loadState(client, apply);
    const audit = await auditPhoneDependencies(client);
    const plan = makePlan(source, state, APPROVED_RESOLUTIONS);
    plan.blockers.push(...audit.blockers);
    plan.summary.blockers = plan.blockers.length;
    const report = {
      project: PROJECT, tenantId: TENANT_ID, objectId: OBJECT_ID,
      mode: apply ? 'apply-preflight' : 'dry-run', observedAt: new Date().toISOString(),
      sourceDigest: source.fileDigest, stateDigest: digest(state),
      auditDigest: digest(audit), tlsVerified: true, paginationComplete: true,
      summary: plan.summary, blockers: plan.blockers, phoneChange: plan.phoneChange,
      approvedResolutions: APPROVED_RESOLUTIONS,
      rows: plan.rows, items: plan.items, audit,
    };
    save(path.join(runDir, 'dry-run.json'), report);
    console.log(JSON.stringify({ report: path.relative(ROOT, path.join(runDir, 'dry-run.json')),
      summary: plan.summary, phoneChange: plan.phoneChange, blockers: plan.blockers }, null, 2));
    check(!plan.blockers.length, 'Preflight blocked; no writes performed. See row-level report.');
    if (!apply) { await client.query('ROLLBACK'); return report; }
    check(prior?.mode === 'dry-run' && prior.project === PROJECT && prior.tenantId === TENANT_ID
      && prior.objectId === OBJECT_ID && prior.sourceDigest === source.fileDigest
      && Array.isArray(prior.blockers) && !prior.blockers.length, 'Invalid clean preflight');
    assertFresh(prior.approvedResolutions, APPROVED_RESOLUTIONS);
    assertFresh(prior.stateDigest, report.stateDigest);
    assertFresh(prior.auditDigest, report.auditDigest);
    const beforeHashes = await preservation(client, plan.items, plan.phoneChange.required);
    save(path.join(runDir, 'before.json'), { project: PROJECT, sourceDigest: source.fileDigest,
      state, plan, beforeHashes, status: 'prepared-not-yet-committed' });
    const updated = await applyChanges(client, state, plan);
    const after = await loadState(client);
    for (const item of plan.items) {
      check(stable(after.records.find(r => r.id === item.recordId)?.data) === stable(item.afterData),
        `Post-update value mismatch at source row ${item.sourceRow}`);
    }
    const replay = makePlan(source, after, APPROVED_RESOLUTIONS);
    check(!replay.blockers.length && replay.summary.recordsUpdated === 0 && !replay.phoneChange.required,
      'Post-update plan is not zero-write');
    const afterHashes = await preservation(client, plan.items, plan.phoneChange.required);
    check(stable(beforeHashes) === stable(afterHashes), 'Preservation fingerprint mismatch; rolling back');
    save(path.join(runDir, 'verified-before-commit.json'), {
      updated, unchanged: plan.summary.recordsUnchanged,
      beforeHashes, afterHashes, zeroWriteReplay: replay.summary, phoneField: after.fields.find(f => f.id === PHONE_ID),
    });
    await client.query('COMMIT');
    committed = true;
    save(path.join(runDir, 'committed.json'), { committedAt: new Date().toISOString(), updated,
      unchanged: plan.summary.recordsUnchanged, fieldValuesChanged: plan.summary.fieldValuesChanged,
      phoneDefinitionChanged: plan.phoneChange.required, unresolvedExceptions: 0 });
    console.log(`Committed ${updated} Department updates. Evidence: ${path.relative(ROOT, runDir)}`);
    return { runDir, updated };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    save(path.join(runDir, 'failure.json'), { committed, message: error.message });
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}