// No application services/provider calls. Preview is a repeatable-read READ ONLY
// transaction; apply requires the exact reviewed plan hash and private before-images.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { TENANT, prepareRows } from './import-bnms-historical-invoices.mjs';

export const ORIGINAL_SHA = '46c023ea8aa8a4c54bb7d4e86decdb8ad05dcba204127efa4c1cc4197620872d';
export const SHEETS = ['To import good', 'Import foreign'];
export const PRIVATE = 'private/bnms-invoice-status-import';
const DEFAULT_FILE = 'attached_assets/Final_BNMS_invoices_import_13.10.26_WITH_STATUS_1792392617933.xlsx';
const ORIGINAL_FILE = 'attached_assets/Final_BNMS_invoices_to_import_01.01.25_to_date_-_import_13.10_1791914288756.xlsx';
const metadata = ['member_id', 'invoice_number', 'invoice_date', 'amount_minor', 'description', 'record_kind'];
const qi = value => `"${value.replaceAll('"', '""')}"`;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equalField = (a, b, field) => String(a[field]) === String(b[field]);
const differences = (a, b) => metadata.filter(field => !equalField(a, b, field));
const ref = row => ({ worksheet: row.worksheet, source_row: row.source_row, source_key: row.source_key });

export function readWorkbook(file, status = true) {
  return SHEETS.map(worksheet => {
    const p = spawnSync('python', ['scripts/lib/read-bnms-historical-invoices.py', file, worksheet, ...(status ? ['--status'] : [])],
      { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
    if (p.status !== 0) throw Error(`Workbook parsing failed (${worksheet}): ${p.stderr}`);
    const input = JSON.parse(p.stdout);
    return { ...input, rows: prepareRows(input.rows).map(row => ({ ...row, worksheet })) };
  });
}

// Pure reconciliation: every conflict is explicit and blocks the entire apply.
export function reconcile(inputs, originals, snapshot) {
  const conflicts = [], rows = [], originalComparison = { unchanged: 0, added: 0, removed: 0, changed: 0 };
  let verifiedPreExistingOverlaps = 0;
  const archived = new Map(snapshot.archive.map(row => [row.source_key, row]));
  const inputKeys = new Set();
  const conflict = (row, reason, fields = []) => conflicts.push({ ...ref(row), reason, fields });
  const operationalDetails = matches => matches.map(o => ({
    table: o.table, column: o.column, status_column: o.status_column || null, status: o.status,
    // This is a literal comparison, NOT authority to mutate operational finance.
    status_comparison: o.status == null ? 'unavailable' : null,
  }));
  for (const input of inputs) {
    const original = originals.find(sheet => sheet.worksheet === input.worksheet);
    if (!original || original.source_sha256 !== ORIGINAL_SHA) throw Error('Pinned original workbook is required');
    const prior = snapshot.imports.filter(i => i.source_sha256 === ORIGINAL_SHA && i.worksheet === input.worksheet);
    if (prior.length !== 1) throw Error(`Exactly one original import required for ${input.worksheet}`);
    const journal = snapshot.journal.filter(j => j.import_id === prior[0].id);
    if (journal.length !== original.rows.length) throw Error(`Incomplete original journal for ${input.worksheet}`);
    const byKey = new Map(original.rows.map(row => [row.source_key, row]));
    const currentKeys = new Set(input.rows.map(row => row.source_key));
    for (const archive of snapshot.archive.filter(a => a.import_id === prior[0].id)) {
      if (!byKey.has(archive.source_key)) conflict({ ...archive, worksheet: input.worksheet }, 'unexpected_original_archive_key');
    }
    for (const old of original.rows) {
      if (!currentKeys.has(old.source_key)) {
        originalComparison.removed++;
        conflict(old, 'original_row_removed');
      }
      const entry = journal.find(j => j.source_row === old.source_row);
      const archive = archived.get(old.source_key);
      const operational = snapshot.operational.filter(o => o.number === old.invoice_number.toUpperCase());
      if (!entry) conflict(old, 'missing_original_journal');
      else if (entry.outcome === 'imported') {
        if (!archive || archive.import_id !== prior[0].id || archive.source_row !== old.source_row || differences(old, archive).length) {
          conflict(old, 'original_archive_or_journal_drift');
        }
      } else if (entry.outcome === 'existing') {
        if (entry.detail === 'historical_member_invoice') {
          if (!archive || differences(old, archive).length) conflict(old, 'skipped_archive_missing_or_changed');
        } else if (old.record_kind === 'overpayment' || !operational.some(o => o.table === entry.detail)) {
          conflict(old, 'skipped_operational_reference_missing');
        }
      } else conflict(old, 'invalid_original_journal_outcome');
    }
    for (const row of input.rows) {
      if (!['paid', 'outstanding'].includes(row.status)) throw Error(`Invalid status at ${input.worksheet}:${row.source_row}`);
      if (inputKeys.has(row.source_key)) conflict(row, 'duplicate_cross_sheet_key');
      inputKeys.add(row.source_key);
      const old = byKey.get(row.source_key);
      if (old) {
        const fields = differences(old, row);
        if (fields.length) { originalComparison.changed++; conflict(row, 'original_metadata_changed', fields); }
        else originalComparison.unchanged++;
        // Identical overpayment occurrences cannot be safely reassigned by status.
        if (row.record_kind === 'overpayment' && old.source_row !== row.source_row) conflict(row, 'overpayment_occurrence_moved');
      } else {
        originalComparison.added++;
        // A changed overpayment fingerprint is not permission to create a replacement.
        if (row.record_kind === 'overpayment' && original.rows.some(o => o.record_kind === 'overpayment' && o.source_row === row.source_row)) {
          conflict(row, 'overpayment_identity_changed');
        }
      }
      const archive = archived.get(row.source_key);
      const operational = row.record_kind === 'overpayment' ? [] : snapshot.operational.filter(o => o.number === row.invoice_number.toUpperCase());
      const details = operationalDetails(operational).map(o => ({ ...o, status_comparison: o.status_comparison ||
        (String(o.status).toLowerCase() === row.status ? 'match' : 'mismatch') }));
      if (archive) {
        const fields = differences(archive, row);
        if (fields.length || archive.xero_company_id !== snapshot.company) conflict(row, 'archive_metadata_conflict', fields);
        if (operational.length) {
          const originalEntry = old && journal.find(j => j.source_row === old.source_row);
          const verifiedOriginalArchive = old && originalEntry?.outcome === 'imported'
            && archive.import_id === prior[0].id && archive.source_row === old.source_row
            && !differences(old, archive).length && !differences(old, row).length
            && archive.xero_company_id === snapshot.company;
          // A verified pre-existing mirror is not a new duplicate: only this
          // archive's workbook status may change, never the operational record.
          if (verifiedOriginalArchive) verifiedPreExistingOverlaps++;
          else conflict(row, 'archive_operational_overlap');
        }
        rows.push({ ...row, action: archive.status === row.status ? 'unchanged' : 'status_update', id: archive.id,
          before_status: archive.status, ...(details.length ? { operational: details } : {}) });
      } else if (operational.length) {
        rows.push({ ...row, action: 'operational_skip', operational: details });
      } else {
        if (old) conflict(row, 'original_reference_unaccounted_for');
        rows.push({ ...row, action: 'new' });
      }
    }
  }
  const counts = {}, statuses = {}, kinds = {}, historicalKinds = {}, historicalStatuses = {};
  for (const row of rows) {
    counts[row.action] = (counts[row.action] || 0) + 1;
    statuses[row.status] = (statuses[row.status] || 0) + 1;
    kinds[row.record_kind] = (kinds[row.record_kind] || 0) + 1;
    if (['status_update', 'unchanged'].includes(row.action)) {
      historicalKinds[row.record_kind] = (historicalKinds[row.record_kind] || 0) + 1;
      historicalStatuses[row.status] = (historicalStatuses[row.status] || 0) + 1;
    }
  }
  const operationalStatusComparisons = { match: 0, mismatch: 0, unavailable: 0 };
  for (const row of rows) for (const o of row.operational || []) operationalStatusComparisons[o.status_comparison]++;
  const summary = { sourceRows: rows.length, counts, statuses, kinds, historicalKinds, historicalStatuses, originalComparison,
    conflicts: conflicts.length, verifiedPreExistingOverlaps, operationalStatusComparisons };
  const body = { tenant: TENANT, sources: inputs.map(i => ({ worksheet: i.worksheet, sha256: i.source_sha256 })),
    summary, conflicts, rows };
  return { ...body, planHash: hash(body) };
}

export async function loadSnapshot(db, rows, { lock = false } = {}) {
  const { rows: columns } = await db.query(`SELECT c.table_name,c.column_name,
    (SELECT s.column_name FROM information_schema.columns s WHERE s.table_schema='public'
      AND s.table_name=c.table_name AND
        (s.column_name IN ('payment_status','invoice_status','xero_invoice_status','accounting_invoice_status','provider_status')
          OR (s.column_name='status' AND c.table_name ~ '(invoice|credit|payment)'))
      ORDER BY CASE s.column_name WHEN 'payment_status' THEN 1 WHEN 'invoice_status' THEN 2
        WHEN 'xero_invoice_status' THEN 3 WHEN 'accounting_invoice_status' THEN 4 WHEN 'provider_status' THEN 5 ELSE 6 END LIMIT 1) AS status_column
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
    WHERE c.table_schema='public' AND c.table_name <> 'historical_member_invoice'
      AND c.column_name IN ('xero_invoice_number','accounting_invoice_number','invoice_number','provider_invoice_number')
      AND EXISTS (SELECT 1 FROM information_schema.columns x
        WHERE x.table_schema='public' AND x.table_name=c.table_name AND x.column_name='tenant_id')
    ORDER BY c.table_name,c.column_name`);
  if (lock) {
    // Block concurrent operational inserts/renumbers for the duration of reconciliation.
    const tables = [...new Set(['historical_member_invoice', 'historical_invoice_import', 'historical_invoice_import_row',
      'member', 'organization', 'xero_token', ...columns.map(c => c.table_name)])].sort();
    for (const table of tables) await db.query(`LOCK TABLE public.${qi(table)} IN SHARE ROW EXCLUSIVE MODE`);
  }
  const companies = (await db.query('SELECT tenant_id FROM xero_token WHERE app_tenant_id=$1', [TENANT])).rows;
  if (companies.length !== 1 || !companies[0].tenant_id || companies[0].tenant_id === 'PENDING_SELECTION') throw Error('Single established Xero company required');
  const members = (await db.query(`SELECT m.id FROM member m LEFT JOIN organization o ON o.id=m.organization_id
    WHERE m.id=ANY($1::uuid[]) AND coalesce(m.tenant_id,o.tenant_id)=$2`, [rows.map(r => r.member_id), TENANT])).rows;
  const ids = new Set(members.map(m => m.id));
  if (rows.some(row => !ids.has(row.member_id))) throw Error('Missing or wrong-tenant member');
  const imports = (await db.query('SELECT * FROM historical_invoice_import WHERE tenant_id=$1 ORDER BY id', [TENANT])).rows;
  const journal = (await db.query(`SELECT j.* FROM historical_invoice_import_row j JOIN historical_invoice_import i ON i.id=j.import_id
    WHERE i.tenant_id=$1 ORDER BY j.import_id,j.source_row`, [TENANT])).rows;
  const archive = (await db.query(`SELECT h.*, to_char(invoice_date,'YYYY-MM-DD') AS invoice_date
    FROM historical_member_invoice h WHERE tenant_id=$1 ORDER BY source_key`, [TENANT])).rows;
  const operational = [];
  const numbers = rows.filter(r => r.record_kind !== 'overpayment').map(r => r.invoice_number.toUpperCase());
  for (const c of columns) {
    const matches = (await db.query(`SELECT DISTINCT upper(btrim(${qi(c.column_name)}::text)) AS number,
      ${c.status_column ? `${qi(c.status_column)}::text` : 'NULL::text'} AS status FROM public.${qi(c.table_name)}
      WHERE tenant_id=$1 AND upper(btrim(${qi(c.column_name)}::text))=ANY($2::text[]) ORDER BY number,status`,
    [TENANT, numbers])).rows;
    for (const match of matches) operational.push({ ...match, table: c.table_name, column: c.column_name, status_column: c.status_column });
  }
  return { company: companies[0].tenant_id, imports, journal, archive, operational };
}

function privateFile(name, value) {
  mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
  const file = resolve(PRIVATE, name);
  writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  return file;
}

export async function importStatuses(db, inputs, originals, { apply = false, expectedPlan, beforeImages = privateFile } = {}) {
  try {
    await db.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (apply) await db.query("SELECT pg_advisory_xact_lock(hashtext('bnms-historical-invoice-import'))");
    const snapshot = await loadSnapshot(db, [...inputs, ...originals].flatMap(i => i.rows), { lock: apply });
    const plan = reconcile(inputs, originals, snapshot);
    if (!apply) { await db.query('COMMIT'); return plan; }
    if (!expectedPlan || plan.planHash !== expectedPlan) throw Error('Reviewed plan hash required; stale or missing approval');
    if (plan.conflicts.length) throw Error('Reconciliation conflicts block apply');
    const mutations = plan.rows.filter(r => ['new', 'status_update'].includes(r.action));
    if (!mutations.length) { await db.query('COMMIT'); return plan; }
    // Exclusive file creation must succeed BEFORE any database write.
    await beforeImages(`before-${plan.planHash}-${Date.now()}.json`, { plan, snapshot });
    const importIds = new Map();
    for (const input of inputs) {
      const result = await db.query(`INSERT INTO historical_invoice_import(tenant_id,source_sha256,worksheet)
        VALUES($1,$2,$3) ON CONFLICT(tenant_id,source_sha256,worksheet) DO UPDATE SET worksheet=excluded.worksheet RETURNING id`,
      [TENANT, input.source_sha256, input.worksheet]);
      importIds.set(input.worksheet, result.rows[0].id);
    }
    const archiveById = new Map(snapshot.archive.map(row => [row.id, row]));
    const updates = mutations.filter(row => row.action === 'status_update').map(row => {
      const before = archiveById.get(row.id);
      return { ...row, import_id: before.import_id, archive_source_row: before.source_row, xero_company_id: before.xero_company_id };
    });
    // Bound payload size, not transaction scope: every batch still commits or
    // rolls back together. CAS checks the entire pinned identity and old status.
    for (let offset = 0; offset < updates.length; offset += 1000) {
      const batch = updates.slice(offset, offset + 1000);
      const updated = await db.query(`UPDATE historical_member_invoice h SET status=r.status
        FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,source_key text,member_id uuid,import_id uuid,
          archive_source_row int,invoice_number text,invoice_date date,amount_minor bigint,
          description text,record_kind text,xero_company_id text,status text,before_status text)
        WHERE h.tenant_id=$2 AND h.id=r.id AND
          (h.source_key,h.member_id,h.import_id,h.source_row,h.invoice_number,h.invoice_date,
            h.amount_minor,h.description,h.record_kind,h.xero_company_id,h.status)
          IS NOT DISTINCT FROM
          (r.source_key,r.member_id,r.import_id,r.archive_source_row,r.invoice_number,r.invoice_date,
            r.amount_minor,r.description,r.record_kind,r.xero_company_id,r.before_status)
        RETURNING h.id`, [JSON.stringify(batch), TENANT]);
      if (updated.rowCount !== batch.length) throw Error('Concurrent historical identity or status change');
    }
    const additions = mutations.filter(row => row.action === 'new').map(row => ({
      ...row, import_id: importIds.get(row.worksheet),
    }));
    for (let offset = 0; offset < additions.length; offset += 1000) {
      const batch = additions.slice(offset, offset + 1000);
      const inserted = await db.query(`INSERT INTO historical_member_invoice(tenant_id,member_id,import_id,source_row,source_key,
        invoice_number,invoice_date,amount_minor,description,record_kind,xero_company_id,status)
        SELECT $2,r.member_id,r.import_id,r.source_row,r.source_key,r.invoice_number,r.invoice_date,
          r.amount_minor,r.description,r.record_kind,$3,r.status
        FROM jsonb_to_recordset($1::jsonb) AS r(member_id uuid,import_id uuid,source_row int,source_key text,
          invoice_number text,invoice_date date,amount_minor bigint,description text,record_kind text,status text)
        RETURNING id`, [JSON.stringify(batch), TENANT, snapshot.company]);
      if (inserted.rowCount !== batch.length) throw Error('Historical insert count mismatch');
    }
    // The journal was loaded under the same table locks. Validate it in memory,
    // then insert only missing entries in batches, with no per-row round trips.
    const priorJournal = new Map(snapshot.journal.map(row => [`${row.import_id}:${row.source_row}`, row]));
    const pendingJournal = [];
    for (const row of plan.rows) {
      const detail = row.action === 'new' ? 'historical metadata only' : row.action === 'operational_skip'
        ? row.operational.map(o => o.table).sort()[0] : 'historical_member_invoice';
      const outcome = row.action === 'new' ? 'imported' : 'existing';
      const id = importIds.get(row.worksheet);
      const existing = priorJournal.get(`${id}:${row.source_row}`);
      if (existing) {
        // Replay is allowed; imported rows become unchanged after their first run.
        if (existing.detail !== detail && !(existing.outcome === 'imported' && detail === 'historical_member_invoice')) throw Error('Status import journal conflict');
      } else pendingJournal.push({ import_id: id, source_row: row.source_row, outcome, detail });
    }
    for (let offset = 0; offset < pendingJournal.length; offset += 1000) {
      const batch = pendingJournal.slice(offset, offset + 1000);
      const inserted = await db.query(`INSERT INTO historical_invoice_import_row(import_id,source_row,outcome,detail)
        SELECT r.import_id,r.source_row,r.outcome,r.detail FROM jsonb_to_recordset($1::jsonb)
          AS r(import_id uuid,source_row int,outcome text,detail text) RETURNING source_row`, [JSON.stringify(batch)]);
      if (inserted.rowCount !== batch.length) throw Error('Status import journal count mismatch');
    }
    await db.query('COMMIT');
    return plan;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  for (const arg of args) if (arg.startsWith('--') && arg !== '--apply' && !arg.startsWith('--expect-plan=')) throw Error('Unknown option');
  const inputs = readWorkbook(args.find(a => !a.startsWith('--')) || DEFAULT_FILE);
  const originals = readWorkbook(ORIGINAL_FILE, false);
  const db = await connectDestination();
  try {
    const apply = args.includes('--apply');
    const plan = await importStatuses(db, inputs, originals, { apply, expectedPlan: args.find(a => a.startsWith('--expect-plan='))?.split('=')[1] });
    const report = privateFile(`preview-${plan.planHash}-${Date.now()}.json`, plan);
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'read-only preview', planHash: plan.planHash, ...plan.summary, privateReport: report }, null, 2));
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
