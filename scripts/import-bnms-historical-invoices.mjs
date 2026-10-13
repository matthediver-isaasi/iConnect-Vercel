// Default is a read-only preview. --apply explicitly writes metadata to DEST only.
// No app services imported: no provider calls, payment collection, or renewal hooks.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export function prepareRows(input) {
  const seen = new Map();
  const numbers = new Set();
  return input.map(row => {
    if (!/^[0-9a-f-]{36}$/i.test(row.member_id)) throw new Error(`Invalid member at row ${row.source_row}`);
    const number = row.invoice_number.trim();
    const overpayment = /^(sales )?overpayment$/i.test(number);
    const record_kind = overpayment ? 'overpayment' : row.amount_minor < 0 || /^(CN|CRN|CREDIT)[- ]/i.test(number) ? 'credit' : 'invoice';
    let source_key = `invoice:${number.toUpperCase()}`;
    if (overpayment) {
      const fingerprint = createHash('sha256').update(JSON.stringify([
        row.member_id, number.toUpperCase(), row.invoice_date, row.amount_minor, row.description,
      ])).digest('hex');
      const occurrence = (seen.get(fingerprint) || 0) + 1;
      seen.set(fingerprint, occurrence);
      source_key = `overpayment:${fingerprint}:${occurrence}`;
    } else {
      if (numbers.has(source_key)) throw new Error(`Duplicate invoice reference at row ${row.source_row}`);
      numbers.add(source_key);
    }
    return { ...row, invoice_number: number, record_kind, source_key };
  });
}
const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;
export async function existingNumbers(db, rows) {
  const { rows: columns } = await db.query(`SELECT table_name,column_name
    FROM information_schema.columns c WHERE table_schema='public'
    AND column_name IN ('xero_invoice_number','accounting_invoice_number','invoice_number','provider_invoice_number')
    AND table_name <> 'historical_member_invoice'
    AND EXISTS (SELECT 1 FROM information_schema.columns t
      WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.column_name='tenant_id')`);
  const result = new Map();
  const numbers = rows.filter(r => r.record_kind !== 'overpayment').map(r => r.invoice_number.toUpperCase());
  for (const { table_name, column_name } of columns) {
    const { rows: matches } = await db.query(`SELECT DISTINCT upper(btrim(${quoteIdentifier(column_name)}::text)) AS number
      FROM public.${quoteIdentifier(table_name)} WHERE tenant_id=$1
      AND upper(btrim(${quoteIdentifier(column_name)}::text))=ANY($2::text[])`, [TENANT, numbers]);
    for (const match of matches) result.set(match.number, table_name);
  }
  return result;
}

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = args.find(arg => !arg.startsWith('--'));
  if (!file) throw new Error('Workbook path required; use --apply only after reviewing preview');
  const parsed = spawnSync('python', ['scripts/lib/read-bnms-historical-invoices.py', file], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (parsed.status !== 0) throw new Error(parsed.stderr || 'Workbook parsing failed');
  const input = JSON.parse(parsed.stdout);
  const db = await connectDestination();
  try {
    await importHistoricalInvoices(db, input, { apply });
  } finally {
    await db.end();
  }
}

export async function importHistoricalInvoices(db, input, { apply = false, log = console.log } = {}) {
  const rows = prepareRows(input.rows);
  const stats = { sourceRows: rows.length, imported: 0, existing: 0, replayed: 0, kinds: {}, before2025: 0, currency: 'not supplied', status: 'not supplied' };
  try {
    await db.query('BEGIN READ ONLY');
    const members = await db.query(`SELECT m.id FROM member m LEFT JOIN organization o ON o.id=m.organization_id
      WHERE m.id=ANY($1::uuid[]) AND coalesce(m.tenant_id,o.tenant_id)=$2`, [rows.map(r => r.member_id), TENANT]);
    const memberIds = new Set(members.rows.map(r => r.id));
    if (rows.some(r => !memberIds.has(r.member_id))) throw new Error('Missing or wrong-tenant member: import stopped');
    const company = await db.query('SELECT tenant_id FROM xero_token WHERE app_tenant_id=$1', [TENANT]);
    if (company.rows.length !== 1 || !company.rows[0].tenant_id || company.rows[0].tenant_id === 'PENDING_SELECTION') {
      throw new Error('A single established Xero company is required to pin document identity');
    }
    const existing = await existingNumbers(db, rows);
    const archiveExists = (await db.query("SELECT to_regclass('public.historical_member_invoice') AS name")).rows[0].name;
    const archived = archiveExists ? new Set((await db.query(`SELECT source_key FROM historical_member_invoice
      WHERE tenant_id=$1 AND source_key=ANY($2::text[])`, [TENANT, rows.map(row => row.source_key)])).rows.map(row => row.source_key)) : new Set();
    await db.query('COMMIT');
    if (!apply) {
      for (const row of rows) {
        const exists = archived.has(row.source_key) || (row.record_kind !== 'overpayment' && existing.has(row.invoice_number.toUpperCase()));
        stats[exists ? 'existing' : 'imported']++;
        if (!exists) {
          stats.kinds[row.record_kind] = (stats.kinds[row.record_kind] || 0) + 1;
          if (row.invoice_date < '2025-01-01') stats.before2025++;
        }
      }
      log(JSON.stringify({ mode: 'preview', ...stats, imported: undefined, proposedNew: stats.imported }, null, 2));
      return stats;
    }
    const imported = await db.query(`INSERT INTO historical_invoice_import (tenant_id,source_sha256,worksheet)
      VALUES ($1,$2,$3) ON CONFLICT (tenant_id,source_sha256,worksheet) DO NOTHING RETURNING id`,
    [TENANT, input.source_sha256, input.worksheet]);
    const importId = imported.rows[0]?.id || (await db.query(`SELECT id FROM historical_invoice_import
      WHERE tenant_id=$1 AND source_sha256=$2 AND worksheet=$3`, [TENANT, input.source_sha256, input.worksheet])).rows[0].id;
    for (let offset = 0; offset < rows.length; offset += 200) {
      await db.query('BEGIN');
      // Transaction-scoped: safe on pooled connections as well as direct PostgreSQL.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('bnms-historical-invoice-import'))");
      // Recheck references for every batch, not just at the initial preview.
      const batch = rows.slice(offset, offset + 200);
      const journal = await db.query('SELECT source_row FROM historical_invoice_import_row WHERE import_id=$1 AND source_row=ANY($2::int[])',
        [importId, batch.map(row => row.source_row)]);
      const done = new Set(journal.rows.map(row => row.source_row));
      stats.replayed += done.size;
      const pending = batch.filter(row => !done.has(row.source_row));
      if (!pending.length) {
        await db.query('COMMIT');
        continue;
      }
      const liveExisting = await existingNumbers(db, pending);
      const candidates = pending.filter(row => row.record_kind === 'overpayment' || !liveExisting.has(row.invoice_number.toUpperCase()));
      const fields = `member_id uuid, source_row int, source_key text, invoice_number text, invoice_date date,
        amount_minor bigint, description text, record_kind text`;
      const payload = JSON.stringify(candidates);
      const validMembers = await db.query(`SELECT count(*)::int AS count FROM jsonb_to_recordset($1::jsonb) AS r(${fields})
        JOIN member m ON m.id=r.member_id LEFT JOIN organization o ON o.id=m.organization_id
        WHERE coalesce(m.tenant_id,o.tenant_id)=$2`, [payload, TENANT]);
      if (validMembers.rows[0].count !== candidates.length) throw new Error('Member tenancy changed: batch stopped');
      const conflicts = await db.query(`SELECT r.source_row FROM jsonb_to_recordset($1::jsonb) AS r(${fields})
        JOIN historical_member_invoice h ON h.tenant_id=$2 AND h.source_key=r.source_key
        WHERE (h.member_id,h.invoice_number,h.invoice_date,h.amount_minor,h.description,h.record_kind)
          IS DISTINCT FROM (r.member_id,r.invoice_number,r.invoice_date,r.amount_minor,r.description,r.record_kind)`, [payload, TENANT]);
      if (conflicts.rowCount) throw new Error(`Historical identity conflict at worksheet row ${conflicts.rows[0].source_row}`);
      const insert = await db.query(`INSERT INTO historical_member_invoice
        (tenant_id,member_id,import_id,source_row,source_key,invoice_number,invoice_date,amount_minor,description,record_kind,xero_company_id)
        SELECT $2,r.member_id,$3,r.source_row,r.source_key,r.invoice_number,r.invoice_date,r.amount_minor,r.description,r.record_kind,$4
        FROM jsonb_to_recordset($1::jsonb) AS r(${fields})
        ON CONFLICT (tenant_id,source_key) DO NOTHING RETURNING source_key`,
      [payload, TENANT, importId, company.rows[0].tenant_id]);
      const newKeys = new Set(insert.rows.map(row => row.source_key));
      const entries = pending.map(row => ({
        source_row: row.source_row,
        outcome: newKeys.has(row.source_key) ? 'imported' : 'existing',
        detail: newKeys.has(row.source_key) ? 'historical metadata only'
          : liveExisting.get(row.invoice_number.toUpperCase()) || 'historical_member_invoice',
      }));
      await db.query(`INSERT INTO historical_invoice_import_row(import_id,source_row,outcome,detail)
        SELECT $1,r.source_row,r.outcome,r.detail FROM jsonb_to_recordset($2::jsonb)
        AS r(source_row int,outcome text,detail text)`, [importId, JSON.stringify(entries)]);
      for (const row of pending) {
        const outcome = newKeys.has(row.source_key) ? 'imported' : 'existing';
        stats[outcome]++;
        if (outcome === 'imported') {
          stats.kinds[row.record_kind] = (stats.kinds[row.record_kind] || 0) + 1;
          if (row.invoice_date < '2025-01-01') stats.before2025++;
        }
      }
      await db.query('COMMIT');
      log(JSON.stringify({ processed: Math.min(offset + 200, rows.length), ...stats }));
    }
    log(JSON.stringify({ mode: 'applied', ...stats }, null, 2));
    return stats;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
