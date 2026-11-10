// Read-only preflight. The separate importer requires explicit consent for the
// existing timestamp/survey-revision effects, approved for this cohort only.
import { readFileSync, mkdirSync, chmodSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connectDestination, PROJECT } from './import-bnms-final-members.mjs';
import { FILE, FIELD, TENANT, parseSource, reconcile } from './bnms-student-dates-source.mjs';

if (process.argv.length !== 2) throw Error('Read-only validator accepts no arguments');
const source = parseSource(readFileSync(FILE));
const directory = 'private/bnms-student-dates';
execFileSync('git', ['check-ignore', '-q', `${directory}/preflight.json`]);
execFileSync('git', ['check-ignore', '-q', FILE]);
if (execFileSync('git', ['ls-files', '--', FILE, directory], { encoding: 'utf8' }).trim()) {
  throw Error('Private input or evidence is tracked');
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='30s'");
  const tenant = (await db.query('select id,name from public.tenant where id=$1', [TENANT])).rows;
  if (tenant.length !== 1 || tenant[0].name !== 'BNMS') throw Error('Tenant mismatch');
  const fields = (await db.query(`select * from public.preference_field where id=$1
    or (tenant_id=$2 and entity_scope='member' and (name='student_course_end_date' or label='Student course end date'))`,
  [FIELD, TENANT])).rows;
  const f = fields[0];
  if (fields.length !== 1 || f.id !== FIELD || f.tenant_id !== TENANT
    || f.name !== 'student_course_end_date' || f.label !== 'Student course end date'
    || f.field_type !== 'date' || f.entity_scope !== 'member' || f.is_active !== true
    || f.custom_object_id != null || f.is_read_only === true || f.is_writable === false) throw Error('Field mismatch');
  const ids = source.rows.filter(r => !r.reasons.length).map(r => r.member_id);
  const members = (await db.query('select id,tenant_id from public.member where id=any($1::uuid[])', [ids])).rows;
  const preferences = (await db.query('select to_jsonb(p) row from public.member_preference_value p where field_id=$1 and member_id=any($2::uuid[]) order by id', [FIELD, ids])).rows.map(r => r.row);
  const rows = reconcile(source.rows, members, preferences);
  const triggers = (await db.query(`select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,
    pg_get_functiondef(t.tgfoid) body from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('member','member_preference_value')
    and not t.tgisinternal order by 1,2`)).rows;
  const counts = Object.fromEntries(['update', 'unchanged', 'held'].map(k => [k, rows.filter(r => r.outcome === k).length]));
  const report = { generatedAt: new Date().toISOString(), project: PROJECT, tenant: TENANT,
    field: FIELD, fingerprint: source.fingerprint, fieldMetadata: f, rows, triggers, counts,
    writes: 0, metadataEffects: 'Preference writes bump parent updated_at and increment member.survey_invitation_revision. Approved for this cohort only; the separate importer requires an explicit consent flag.' };
  const file = `${directory}/preflight-${Date.now()}.json`;
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(report, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  await db.query('ROLLBACK');
  console.log(JSON.stringify({ sourceRows: rows.length, ...counts, writes: 0,
    dates: [rows.map(r => r.value).filter(Boolean).sort()[0], rows.map(r => r.value).filter(Boolean).sort().at(-1)],
    existingDiffering: rows.filter(r => r.outcome === 'update' && r.before.length && r.before[0].value).length,
    metadataEffects: report.metadataEffects }));
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
