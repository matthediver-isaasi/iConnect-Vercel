// Exact Q4 workbook only. Default: read-only dry run.
// Apply after review: node scripts/import-q4-publications-briefs.mjs --apply --review-sha256=<dry-run plan hash>
// Private evidence is excluded from Git. No API workflows, notifications, writer
// creation, updates, schema changes, NDA storage or other-sheet imports.
import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';

export const TENANT = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const SOURCE = 'attached_assets/Publications_data_import_file_Q4_1791263571378.xlsx';
const SOURCE_SHA = '4c78cf7c510ce6f1c8e12f3d6e5724c288a084107a08eb2ca7d421c8e3e66713';
const PRIVATE = 'private/gfi-q4-publications';
export const norm = value => String(value ?? '').trim().toLowerCase();
const hash = value => createHash('sha256').update(value).digest('hex');
function requireThat(ok, message) { if (!ok) throw new Error(message); }
export function excelDate(value) {
  requireThat(Number.isInteger(value), 'Deadline must be an Excel serial');
  return new Date((value - 25569) * 86400000).toISOString().slice(0, 10);
}
export function validateRows(rows) {
  requireThat(rows.length === 75, 'Expected exactly 75 rows');
  const titles = new Set();
  const counts = { WCID: 0, 'Job profiles': 0, internal: 0, external: 0, ndaNotImported: 0 };
  for (const [i, r] of rows.entries()) {
    const check = (ok, message) => requireThat(ok, `Row ${i + 2}: ${message}`);
    const title = norm(r.Title);
    check(title && !titles.has(title), 'Empty or duplicate title');
    titles.add(title);
    check(['WCID', 'Job profiles'].includes(r.Category), 'Unexpected category');
    counts[r.Category]++;
    check(r.SLA === '2026-2028' && r.Contract === 'Prospects', 'Unexpected SLA/contract');
    for (const k of ['Submission Deadline', 'Writer Deadline', 'Editor Deadline'])
      check(excelDate(r[k]) === '2027-01-01', 'Unexpected deadline');
    check(norm(r.Status) === 'in progress', 'Unexpected status');
    check(norm(r['Case Study']) === 'no', 'Unexpected case study flag');
    check(norm(r['Member Copyright agreement']) === '', 'Unexpected copyright flag');
    const external = norm(r['External Writer']) === 'yes';
    check(['yes', 'no'].includes(norm(r['External Writer'])), 'Unexpected writer flag');
    check(norm(r['Contributor Type']) === (external ? 'paid' : 'gfi team'), 'Unexpected contributor');
    check(norm(r.Editor), 'Missing editor');
    check(external ? norm(r['External Writer email']) : norm(r.Writer), 'Missing writer');
    check(norm(r['External Writer NDA']) === (external ? 'yes' : ''), 'Unexpected NDA flag');
    counts[external ? 'external' : 'internal']++;
    if (external) counts.ndaNotImported++;
  }
  requireThat(counts.WCID === 13 && counts['Job profiles'] === 62
    && counts.internal === 55 && counts.external === 20 && counts.ndaNotImported === 20, 'Batch totals mismatch');
  return counts;
}
export function assertMapping(actual, expected, row) {
  for (const [key, value] of Object.entries(expected)) {
    // These three schema columns are timestamptz, not date. Compare the exact
    // midnight UTC instant, not a date prefix which could hide a shifted time.
    const same = ['deadline', 'writer_deadline', 'editor_deadline'].includes(key)
      ? actual[key] != null && Date.parse(actual[key]) === Date.parse(`${value}T00:00:00.000Z`)
      : actual[key] === value;
    requireThat(same, `Row ${row}: saved ${key} differs from approved mapping`);
  }
}
async function readBriefs(client) {
  const result = [];
  let cursor = null;
  for (;;) {
    const { rows } = await client.query(
      `select to_jsonb(b) as record from public.article_brief b
       where tenant_id=$1 and ($2::uuid is null or id>$2::uuid) order by id limit 100`,
      [TENANT, cursor]);
    result.push(...rows.map(r => r.record));
    if (rows.length < 100) return result;
    cursor = rows.at(-1).record.id;
  }
}
export async function run(args = process.argv.slice(2)) {
  requireThat(args.every(a => ['--apply', '--dry-run'].includes(a) || /^--review-sha256=[a-f0-9]{64}$/.test(a)), 'Unknown argument');
  const apply = args.includes('--apply');
  requireThat(!(apply && args.includes('--dry-run')), 'Conflicting modes');
  const source = readFileSync(SOURCE);
  requireThat(hash(source) === SOURCE_SHA, 'Workbook fingerprint changed');
  const wb = XLSX.read(source, { type: 'buffer' });
  requireThat(!wb.Workbook?.WBProps?.date1904, 'Unexpected workbook date system');
  requireThat(wb.Sheets['Q4 data'], 'Q4 sheet missing');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Q4 data'], { defval: '' });
  const counts = validateRows(rows);
  mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
  const file = `${PRIVATE}/${new Date().toISOString().replaceAll(':', '-')}-${apply ? 'apply' : 'dry-run'}.json`;
  const manifest = { project: PROJECT, tenant: TENANT, sourceSha256: SOURCE_SHA,
    mode: apply ? 'apply' : 'dry-run', state: 'preflight', counts, rows: [], errors: 0 };
  const save = () => writeFileSync(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  save();
  let client;
  try {
    client = await connectDestination();
    requireThat(client.connection.stream.encrypted && client.connection.stream.authorized, 'Verified TLS required');
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL timezone = 'UTC'");
    // Serialize all brief writers during the short transaction, including other
    // importer processes. Authoritative reads happen AFTER this lock.
    if (apply) await client.query('LOCK TABLE public.article_brief IN SHARE ROW EXCLUSIVE MODE');
    const tenant = await client.query('select name from public.tenant where id=$1', [TENANT]);
    requireThat(tenant.rows.length === 1 && tenant.rows[0].name === 'Graduate Futures Institute', 'Tenant pin failed');
    const triggers = await client.query("select tgname from pg_trigger where tgrelid='public.article_brief'::regclass and not tgisinternal and tgenabled <> 'D'");
    requireThat(triggers.rows.length === 0, 'Unexpected brief trigger: review side effects first');
    const settings = await client.query('select stages from public.article_brief_settings where tenant_id=$1', [TENANT]);
    requireThat(settings.rows.length === 1, 'Missing/ambiguous stage settings');
    const stages = settings.rows[0].stages.filter(s => norm(s.label) === 'in progress');
    requireThat(stages.length === 1 && stages[0].key === 'in_progress', 'Stage mapping changed');
    const before = await readBriefs(client);
    manifest.existingBefore = before.length;
    manifest.beforeSha256 = hash(JSON.stringify(before));
    const members = new Map(), externalWriters = new Map();
    async function member(name) {
      const key = norm(name);
      if (!members.has(key)) {
        const match = await client.query(`select id from public.member where tenant_id=$1
          and lower(trim(first_name) || ' ' || trim(last_name))=$2`, [TENANT, key]);
        requireThat(match.rows.length === 1, 'Missing or ambiguous tenant member');
        members.set(key, match.rows[0].id);
      }
      return members.get(key);
    }
    for (const [i, r] of rows.entries()) {
      const external = norm(r['External Writer']) === 'yes';
      let externalId = null;
      if (external) {
        const email = norm(r['External Writer email']);
        if (!externalWriters.has(email)) {
          const match = await client.query('select id from public.external_writer where tenant_id=$1 and lower(trim(email))=$2', [TENANT, email]);
          requireThat(match.rows.length === 1, 'Missing or ambiguous external writer');
          externalWriters.set(email, match.rows[0].id);
        }
        externalId = externalWriters.get(email);
      }
      const payload = {
        tenant_id: TENANT, title: String(r.Title).trim(), category: r.Category, sla: r.SLA,
        contract: r.Contract, deadline: excelDate(r['Submission Deadline']),
        writer_deadline: excelDate(r['Writer Deadline']), editor_deadline: excelDate(r['Editor Deadline']),
        status: stages[0].key, assigned_writer_id: external ? null : await member(r.Writer),
        external_writer_id: externalId, review_owner_id: await member(r.Editor),
        notes: String(r.Notes).trim() || null, contributor_type: external ? 'paid' : 'gfi',
        case_study_required: false, copyright_required: false,
      };
      const matches = before.filter(b => norm(b.title) === norm(payload.title));
      requireThat(matches.length <= 1, `Row ${i + 2}: ambiguous existing title`);
      if (matches.length) assertMapping(matches[0], payload, i + 2);
      manifest.rows.push({ row: i + 2, payload, id: matches[0]?.id ?? null,
        result: matches.length ? 'skipped' : 'planned' });
    }
    requireThat(externalWriters.size === 3, 'Expected three reused external writers');
    manifest.planSha256 = hash(JSON.stringify(manifest.rows.map(r => r.payload)));
    manifest.reusedExternalWriters = externalWriters.size;
    manifest.resolvedMembers = members.size;
    manifest.planned = manifest.rows.filter(r => r.result === 'planned').length;
    manifest.skipped = 75 - manifest.planned;
    manifest.inserted = 0;
    save();
    if (apply) {
      requireThat(args.includes(`--review-sha256=${manifest.planSha256}`), 'Apply requires matching reviewed plan hash');
      for (const row of manifest.rows.filter(r => r.result === 'planned')) {
        const keys = Object.keys(row.payload);
        const { rows: inserted } = await client.query(
          `insert into public.article_brief (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})
           returning to_jsonb(article_brief) as record`, Object.values(row.payload));
        requireThat(inserted.length === 1, 'Insert did not return exactly one row');
        assertMapping(inserted[0].record, row.payload, row.row);
        row.id = inserted[0].record.id;
        row.result = 'inserted';
        manifest.inserted++;
      }
      const after = await readBriefs(client);
      const oldIds = new Set(before.map(b => b.id));
      requireThat(hash(JSON.stringify(after.filter(b => oldIds.has(b.id)))) === manifest.beforeSha256, 'Existing briefs changed');
      requireThat(after.length === before.length + manifest.inserted, 'Brief count mismatch');
      for (const row of manifest.rows) {
        const matches = after.filter(b => norm(b.title) === norm(row.payload.title));
        requireThat(matches.length === 1, 'Final duplicate/missing title');
        assertMapping(matches[0], row.payload, row.row);
      }
      manifest.existingUnchanged = before.length;
      manifest.totalAfter = after.length;
      manifest.state = 'verified-pending-commit';
      save();
      await client.query('COMMIT');
      manifest.state = 'committed';
    } else {
      await client.query('ROLLBACK');
      manifest.state = 'dry-run-complete';
    }
    save();
    console.log(JSON.stringify({ ...counts, mode: manifest.mode, state: manifest.state,
      existingBefore: before.length, planned: manifest.planned, inserted: manifest.inserted,
      skipped: manifest.skipped, errors: 0, resolvedMembers: members.size,
      reusedExternalWriters: externalWriters.size, planSha256: manifest.planSha256,
      existingUnchanged: manifest.existingUnchanged, totalAfter: manifest.totalAfter,
      privateManifest: file }, null, 2));
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    manifest.errors++;
    manifest.failure = String(error.message);
    manifest.state = manifest.state === 'verified-pending-commit' ? 'commit-not-confirmed' : 'failed-rolled-back';
    save();
    // Avoid dumping provider objects or connection details.
    console.error(`Import stopped; see private manifest ${file}`);
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
