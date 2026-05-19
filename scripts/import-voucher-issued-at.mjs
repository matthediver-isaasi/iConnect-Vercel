// One-off import: update voucher.issued_at from a CSV provided in
// attached_assets/training_vouchers_creation_date_1779181302003.csv.
//
// CSV columns:
//   uuid       - voucher.id (UUID)
//   Issue date - date string in dd.mm.yy format (e.g. 05.06.25 = 2025-06-05)
//
// Each row's issued_at is set to <date>T09:00:00Z. The whole update runs
// inside one transaction; with --dry-run the transaction is rolled back.
//
// Usage:
//   DATABASE_URL=... node scripts/import-voucher-issued-at.mjs --dry-run
//   DATABASE_URL=... node scripts/import-voucher-issued-at.mjs
//   Add --allow-missing to commit even if some CSV UUIDs are not in the DB.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const CSV_PATH = path.resolve(
  'attached_assets/training_vouchers_creation_date_1779181302003.csv'
);
const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_MISSING = process.argv.includes('--allow-missing');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{2})$/;

function parseCsv(text) {
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
  // Skip header.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(',');
    if (parts.length < 2) {
      throw new Error(`Line ${i + 1}: expected 2 columns, got ${parts.length}: ${line}`);
    }
    const uuid = parts[0].trim();
    const dateStr = parts[1].trim();
    if (!UUID_RE.test(uuid)) {
      throw new Error(`Line ${i + 1}: invalid UUID "${uuid}"`);
    }
    const m = DATE_RE.exec(dateStr);
    if (!m) {
      throw new Error(`Line ${i + 1}: invalid date "${dateStr}" (expected dd.mm.yy)`);
    }
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const yy = parseInt(m[3], 10);
    const year = 2000 + yy;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      throw new Error(`Line ${i + 1}: out-of-range date "${dateStr}"`);
    }
    const iso = `${year.toString().padStart(4, '0')}-${m[2]}-${m[1]}T09:00:00.000Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()) || d.getUTCDate() !== dd || d.getUTCMonth() + 1 !== mm) {
      throw new Error(`Line ${i + 1}: invalid calendar date "${dateStr}"`);
    }
    rows.push({ id: uuid.toLowerCase(), issuedAt: iso });
  }
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  console.log(`Parsed ${rows.length} rows from ${CSV_PATH}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (rollback)' : 'LIVE (commit)'}`);

  // Detect duplicate UUIDs in the CSV.
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.id) && seen.get(r.id) !== r.issuedAt) {
      throw new Error(`Duplicate UUID with conflicting dates in CSV: ${r.id}`);
    }
    seen.set(r.id, r.issuedAt);
  }
  if (seen.size !== rows.length) {
    console.log(`Note: collapsed ${rows.length - seen.size} duplicate CSV row(s)`);
  }
  const dedup = Array.from(seen.entries()).map(([id, issuedAt]) => ({ id, issuedAt }));

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    const ids = dedup.map((r) => r.id);
    const existsRes = await client.query(
      'SELECT id FROM voucher WHERE id = ANY($1::uuid[])',
      [ids]
    );
    const existing = new Set(existsRes.rows.map((r) => r.id));
    const missing = ids.filter((id) => !existing.has(id));

    console.log(`CSV rows:        ${rows.length}`);
    console.log(`Unique UUIDs:    ${dedup.length}`);
    console.log(`Found in DB:     ${existing.size}`);
    console.log(`Missing from DB: ${missing.length}`);
    if (missing.length > 0) {
      console.log('Missing UUIDs:');
      for (const id of missing) console.log(`  - ${id}`);
      if (!ALLOW_MISSING) {
        console.error(
          '\nAborting because some UUIDs are missing. Re-run with --allow-missing to proceed.'
        );
        await client.query('ROLLBACK');
        process.exit(2);
      }
    }

    const toUpdate = dedup.filter((r) => existing.has(r.id));
    const values = [];
    const params = [];
    toUpdate.forEach((r, i) => {
      values.push(`($${i * 2 + 1}::uuid, $${i * 2 + 2}::timestamptz)`);
      params.push(r.id, r.issuedAt);
    });

    let updated = 0;
    if (values.length > 0) {
      const sql = `
        UPDATE voucher v
        SET issued_at = data.issued_at
        FROM (VALUES ${values.join(', ')}) AS data(id, issued_at)
        WHERE v.id = data.id
      `;
      const res = await client.query(sql, params);
      updated = res.rowCount;
    }
    console.log(`Updated rows:    ${updated}`);

    if (updated !== toUpdate.length) {
      console.error(
        `Mismatch: expected to update ${toUpdate.length} rows but UPDATE affected ${updated}. Rolling back.`
      );
      await client.query('ROLLBACK');
      process.exit(3);
    }

    // Spot-check a few rows.
    const sampleIds = toUpdate.slice(0, 5).map((r) => r.id);
    if (sampleIds.length > 0) {
      const sample = await client.query(
        'SELECT id, issued_at FROM voucher WHERE id = ANY($1::uuid[]) ORDER BY id',
        [sampleIds]
      );
      console.log('Spot-check (first 5):');
      for (const row of sample.rows) {
        const expected = toUpdate.find((r) => r.id === row.id)?.issuedAt;
        const got = new Date(row.issued_at).toISOString();
        const ok = got === new Date(expected).toISOString();
        console.log(`  ${row.id}  expected=${expected}  got=${got}  ${ok ? 'OK' : 'MISMATCH'}`);
      }
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN complete - transaction rolled back.');
    } else {
      await client.query('COMMIT');
      console.log('\nCommitted.');
    }

    console.log('\nSummary:');
    console.log(`  total CSV rows: ${rows.length}`);
    console.log(`  unique UUIDs:   ${dedup.length}`);
    console.log(`  matched:        ${toUpdate.length}`);
    console.log(`  updated:        ${updated}`);
    console.log(`  missing:        ${missing.length}`);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
