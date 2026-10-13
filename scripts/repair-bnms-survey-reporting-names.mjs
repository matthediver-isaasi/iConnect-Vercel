#!/usr/bin/env node
// One-off DEST maintenance; never invoked by startup or automatic migrations.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';
import { isScoreField, getScoreRange } from '../api/_lib/surveyScoring.js';

export const FORM = 'a8610153-ab67-4fee-8941-54d2b725e252';
export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const VERSIONS = ['d920ed8c-271a-4bb5-a4b2-4275325b3d82', '4e4a7d28-8177-4f94-8966-b38e8e4770ee'];
const MANIFEST = new URL('./data/bnms-survey-reporting-names.json', import.meta.url);
const GUARDS = ['guard_survey_snapshot_response_policy', 'trg_survey_version_immutable'];
export function check(ok, message) { if (!ok) throw new Error(message); }
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
export const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

export function transform(fields) {
  check(Array.isArray(fields) && fields.every(f => f && typeof f === 'object' && !Array.isArray(f)), 'Invalid field array');
  check(fields.every(f => typeof f.id === 'string' && f.id) && new Set(fields.map(f => f.id)).size === fields.length, 'Invalid field identities');
  check(fields.filter(isScoreField).length === 19, 'Expected 19 score fields');
  return fields.map(f => {
    if (!isScoreField(f)) return f;
    check(typeof f.label === 'string' && f.label.trim().length > 0, 'Missing score label');
    return { ...f, reporting_name: f.label };
  });
}

async function state(db) {
  const form = (await db.query('select to_jsonb(f) row from public.form f where id=$1', [FORM])).rows.map(r => r.row);
  const versions = (await db.query('select to_jsonb(v) row from public.survey_version v where form_id=$1 order by version_number', [FORM])).rows.map(r => r.row);
  check(form.length === 1 && form[0].tenant_id === TENANT && form[0].name === 'Autumn Meeting Feedback' && form[0].form_type === 'survey', 'Form ownership/name drift');
  check((await db.query('select name from public.tenant where id=$1', [TENANT])).rows[0]?.name === 'BNMS', 'Tenant identity drift');
  check(versions.length === 2 && versions.every((v, i) => v.id === VERSIONS[i] && v.version_number === i + 1 && v.tenant_id === TENANT), 'Snapshot identity drift');
  return [form[0], ...versions];
}

async function protections(db) {
  const triggers = (await db.query(`select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,
    pg_get_functiondef(t.tgfoid) function from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.oid in ('public.form'::regclass,'public.survey_version'::regclass) and not t.tgisinternal
    order by c.relname,t.tgname`)).rows;
  check(GUARDS.every(name => triggers.some(t => t.relname === 'survey_version' && t.tgname === name && t.tgenabled === 'O')), 'Snapshot guards not enabled');
  const grants = (await db.query(`select relname,relacl,relrowsecurity,relforcerowsecurity from pg_class
    where oid in ('public.form'::regclass,'public.survey_version'::regclass) order by relname`)).rows;
  const columns = (await db.query(`select table_name,column_name,grantee,privilege_type,is_grantable
    from information_schema.column_privileges where table_schema='public' and table_name in ('form','survey_version')
    order by table_name,column_name,grantee,privilege_type`)).rows;
  const policies = (await db.query(`select * from pg_policies where schemaname='public' and tablename in ('form','survey_version') order by tablename,policyname`)).rows;
  return { triggers, grants, columns, policies };
}

// Database-side fingerprints never expose respondent records, names or answers.
async function preservation(db) {
  const result = {};
  for (const [table, predicate] of [
    ['form', 'id <> $1'], ['survey_version', 'form_id <> $1'],
    ['form_submission', 'form_id = $1'], ['survey_answer', 'form_id = $1'],
  ]) {
    result[table] = (await db.query(`select count(*)::int count,
      md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by id),'')) fingerprint
      from public.${table} r where ${predicate}`, [FORM])).rows[0];
  }
  return result;
}

// Execute the existing reporting functions, not a second implementation.
// No authentication bypass or production source edits; no export audit writes.
export function reportingFunctions() {
  const source = readFileSync(new URL('../api/reports/survey-report.js', import.meta.url), 'utf8');
  const context = vm.createContext({ isScoreField, getScoreRange });
  const sections = [
    source.slice(source.indexOf('const round ='), source.indexOf('// Deterministic')),
    source.slice(source.indexOf('function buildQuestionMeta('), source.indexOf('function buildTextFieldMeta(')),
    source.slice(source.indexOf('function aggregate('), source.indexOf('// Per-event comparison')),
    source.slice(source.indexOf('function buildSummarySheetRows(')),
    `function distributionView(answers, perSubmission, questionMeta, fieldId) {
      const req = {query:{fieldId}};
      const res = {status(){return this},json(v){return v}};
      ${source.slice(source.indexOf("    if (view === 'distribution') {"), source.indexOf('    // ---- comments')).replace("if (view === 'distribution')", 'if (true)')}
    }`,
  ];
  vm.runInContext(sections.join('\n') + '\nthis.functions = {buildQuestionMeta,aggregate,buildSummarySheetRows,distributionView};', context);
  return context.functions;
}

async function reportEvidence(db, rows) {
  const subs = (await db.query(`select id,survey_version_id from public.form_submission
    where tenant_id=$1 and form_id=$2 and survey_version_id is not null order by id`, [TENANT, FORM])).rows;
  const answers = (await db.query(`select submission_id,survey_version_id,field_id,reporting_category,
    raw_score,is_na,normalised_score,weight,included_in_overall from public.survey_answer
    where tenant_id=$1 and form_id=$2 order by id`, [TENANT, FORM])).rows;
  const f = reportingFunctions();
  const results = [];
  for (const versions of [rows.slice(1), [rows[1]], [rows[2]]]) {
    const ctx = { form: rows[0], versions };
    const scoped = subs.filter(s => versions.some(v => v.id === s.survey_version_id));
    const scopedAnswers = answers.filter(a => scoped.some(s => s.id === a.submission_id));
    const meta = f.buildQuestionMeta(versions);
    const agg = f.aggregate(ctx, scoped, scopedAnswers, meta);
    const sheets = f.buildSummarySheetRows(ctx, agg, [], agg.perSubmission, { isAnonymous: false }, false, versions.map(v => v.version_number));
    const distributions = [...meta.keys()].sort().map(id => f.distributionView(scopedAnswers, agg.perSubmission, meta, id));
    results.push({
      meta: [...meta.values()].sort((a,b) => a.fieldId.localeCompare(b.fieldId)),
      summary: agg.summary, categories: agg.categories,
      questions: [...agg.questions].sort((a,b) => a.fieldId.localeCompare(b.fieldId)),
      distributions, sheets,
    });
  }
  return results;
}

export function compareReports(before, after) {
  check(before.length === after.length, 'Reporting scope changed');
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    const strip = items => items.map(({label, ...rest}) => rest);
    check(hash(a.summary) === hash(b.summary) && hash(a.categories) === hash(b.categories), 'Overall/category aggregates changed');
    for (const key of ['meta', 'questions', 'distributions']) {
      check(hash(strip(a[key])) === hash(strip(b[key])), `Reporting ${key} changed beyond labels`);
      check(b[key].every(q => q.label === b.meta.find(m => m.fieldId === q.fieldId)?.rawLabel), `Incorrect ${key} labels`);
    }
    // CSV and XLSX share these exact question rows; sorting may legitimately change.
    check(b.sheets.questionsSheet.slice(1).every(r => b.questions.some(q => q.label === r[0])), 'Export labels mismatch');
  }
}

export async function run(db, mode, manifest) {
  await db.query('begin');
  try {
    await db.query("set local lock_timeout='5s'; set local statement_timeout='60s'");
    // Short maintenance lock: no other writer can observe disabled guards.
    // Locks also prevent concurrent publication/acceptance and fingerprint drift.
    await db.query('lock table public.form,public.survey_version in access exclusive mode');
    await db.query('lock table public.form_submission,public.survey_answer in share mode');
    const rows = await state(db);
    const guards = await protections(db);
    const planned = rows.map(r => ({...r, fields: transform(r.fields)}));
    const entries = rows.map((r,i) => ({
      id: r.id, version: r.version_number ?? null,
      beforeHash: hash(r), afterHash: hash(planned[i]),
      fields: r.fields.filter(isScoreField).map(f => ({
        id: f.id, label: f.label, beforePresent: Object.hasOwn(f, 'reporting_name'),
        ...(Object.hasOwn(f, 'reporting_name') ? {before: f.reporting_name} : {}), after: f.label,
      })),
    }));
    if (mode === 'audit') {
      check(entries.every(e => e.fields.filter(f => f.before === 'Exhibition standard').length === 18
        && e.fields.filter(f => !f.beforePresent).length === 1), 'Unexpected initial reporting names');
      await db.query('rollback');
      return { project: PROJECT, form: FORM, tenant: TENANT, protectionsHash: hash(guards), entries };
    }
    check(manifest.project === PROJECT && manifest.form === FORM && manifest.tenant === TENANT && manifest.entries.length === 3, 'Invalid manifest scope');
    check(hash(guards) === manifest.protectionsHash, 'Deployed protections drift');
    rows.forEach((r,i) => check(manifest.entries[i].id === r.id &&
      [manifest.entries[i].beforeHash, manifest.entries[i].afterHash].includes(hash(r)) &&
      hash(planned[i]) === manifest.entries[i].afterHash, 'Locked before-state drift'));
    const preserved = await preservation(db);
    const beforeReport = await reportEvidence(db, rows);
    const changed = rows.map((r,i) => hash(r) !== hash(planned[i]));
    let writes = 0;
    if (changed.slice(1).some(Boolean)) {
      for (const guard of GUARDS) await db.query(`alter table public.survey_version disable trigger ${guard}`);
    }
    for (let i = 0; i < rows.length; i++) {
      if (!changed[i]) continue;
      const table = i ? 'survey_version' : 'form';
      const result = await db.query(`update public.${table} set fields=$1::jsonb where id=$2 and tenant_id=$3 returning id`,
        [JSON.stringify(planned[i].fields), rows[i].id, TENANT]);
      check(result.rowCount === 1, 'Unexpected write count');
      writes++;
    }
    if (changed.slice(1).some(Boolean)) {
      for (const guard of GUARDS) await db.query(`alter table public.survey_version enable trigger ${guard}`);
    }
    const after = await state(db);
    check(hash(after) === hash(planned), 'Exact resulting rows differ');
    check(hash(await protections(db)) === hash(guards), 'Protections not restored');
    check(hash(await preservation(db)) === hash(preserved), 'Out-of-scope data changed');
    compareReports(beforeReport, await reportEvidence(db, after));
    // A write attempt must still fail with both original guards individually.
    for (const guard of GUARDS) {
      await db.query('savepoint guard_probe');
      const other = GUARDS.find(g => g !== guard);
      await db.query(`alter table public.survey_version disable trigger ${other}`);
      let rejected = false;
      try { await db.query('update public.survey_version set fields=fields where id=$1', [VERSIONS[0]]); }
      catch (error) { rejected = error.code === 'P0001' && /immutable/.test(error.message); }
      await db.query('rollback to savepoint guard_probe');
      check(rejected, 'Snapshot guard probe failed');
    }
    check(hash(await protections(db)) === hash(guards), 'Probe protections not restored');
    await db.query(mode === 'rehearse' ? 'rollback' : 'commit');
    return { mode, project: PROJECT, rowsWritten: writes, fieldsCorrected: entries.reduce((n,e,i) => n + (changed[i] ? e.fields.filter(f => f.before !== f.after).length : 0), 0),
      scoreFieldsVerified: 57, preserved, reportScopesVerified: ['all', 'v1', 'v2'], guardsRestored: true };
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

async function main() {
  const mode = process.argv[2]?.replace(/^--/, '');
  check(['audit','rehearse','apply'].includes(mode) && process.argv.length === 3, 'Use --audit, --rehearse or --apply');
  const db = await connectDestination();
  try {
    if (mode === 'audit') {
      const manifest = await run(db, mode);
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', {flag:'wx'});
      console.log(JSON.stringify({mode, project: PROJECT, rows: 3, scoreFields: 57, manifest: 'scripts/data/bnms-survey-reporting-names.json'}));
    } else {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
      const before = hash(await state(db));
      const result = await run(db, mode, manifest);
      if (mode === 'rehearse') check(hash(await state(db)) === before, 'Rollback verification failed');
      console.log(JSON.stringify(result));
      if (mode === 'apply') {
        const replay = await run(db, mode, manifest);
        check(replay.rowsWritten === 0, 'Replay was not zero-write');
        console.log(JSON.stringify({replayRowsWritten: replay.rowsWritten}));
      }
    }
  } finally { await db.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never serialize database errors or assertion objects containing private data.
    console.error(`Repair aborted (${error.code || 'validation'}): ${error.code ? 'database operation failed; transaction rolled back' : error.message}`);
    process.exitCode = 1;
  });
}
