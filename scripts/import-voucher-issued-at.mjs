// One-off import: update voucher.issued_at from a CSV provided in
// attached_assets/training_vouchers_creation_date_1779181302003.csv.
//
// CSV columns:
//   uuid       - voucher.id (UUID)
//   Issue date - date string in dd.mm.yy format (e.g. 05.06.25 = 2025-06-05)
//
// Each row's issued_at is set to <date>T09:00:00.000Z.
//
// This script uses @supabase/supabase-js (HTTPS REST) instead of the raw
// pg client, because the Supabase direct Postgres host is IPv6-only and is
// unreachable from the Replit workspace (see replit.md → "Database
// connection"). It resolves credentials from DEST_* first, then DEV_*,
// then plain SUPABASE_*.
//
// Usage:
//   node scripts/import-voucher-issued-at.mjs --dry-run
//   node scripts/import-voucher-issued-at.mjs
//   Add --allow-missing to commit even if some CSV UUIDs are not in the DB.

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const CSV_PATH = path.resolve(
  'attached_assets/training_vouchers_creation_date_1779181302003.csv'
);
const DRY_RUN = process.argv.includes('--dry-run');
const ALLOW_MISSING = process.argv.includes('--allow-missing');
const CHUNK_SIZE = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{2})$/;

function resolveSupabaseCreds() {
  const url =
    process.env.DEST_SUPABASE_URL ||
    process.env.DEV_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const key =
    process.env.DEST_SUPABASE_KEY ||
    process.env.DEST_SUPABASE_SERVICE_KEY ||
    process.env.DEV_SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error(
      'Missing Supabase credentials. Set DEST_SUPABASE_URL + DEST_SUPABASE_KEY (preferred) ' +
        'or DEV_SUPABASE_URL + DEV_SUPABASE_SERVICE_KEY. See replit.md → "Database connection".'
    );
    process.exit(1);
  }
  return { url, key };
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = [];
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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const { url, key } = resolveSupabaseCreds();
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log(`Supabase host: ${new URL(url).host}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (writes will be committed)'}`);
  console.log(`CSV: ${CSV_PATH}`);

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  console.log(`Parsed ${rows.length} rows`);

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

  // Precheck: which UUIDs exist in voucher table?
  const ids = dedup.map((r) => r.id);
  const existing = new Set();
  for (const batch of chunk(ids, 200)) {
    const { data, error } = await supabase
      .from('voucher')
      .select('id')
      .in('id', batch);
    if (error) throw new Error(`Precheck failed: ${error.message}`);
    for (const row of data) existing.add(row.id);
  }
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
      process.exit(2);
    }
  }

  const toUpdate = dedup.filter((r) => existing.has(r.id));

  let updated = 0;
  if (DRY_RUN) {
    updated = toUpdate.length;
    console.log(`Would update ${updated} rows (dry-run, no writes sent).`);
  } else {
    for (const batch of chunk(toUpdate, CHUNK_SIZE)) {
      for (const r of batch) {
        const { data, error } = await supabase
          .from('voucher')
          .update({ issued_at: r.issuedAt })
          .eq('id', r.id)
          .select('id');
        if (error) throw new Error(`Update failed for ${r.id}: ${error.message}`);
        if (!data || data.length === 0) {
          throw new Error(`Update for ${r.id} returned no rows (RLS or vanished row?)`);
        }
        updated += data.length;
      }
      process.stdout.write(`  updated ${updated}/${toUpdate.length}\r`);
    }
    process.stdout.write('\n');
  }

  console.log(`Updated rows: ${updated}${DRY_RUN ? ' (would update — dry-run)' : ''}`);

  if (updated !== toUpdate.length) {
    console.error(
      `Mismatch: expected to update ${toUpdate.length} rows but only ${updated} were written.`
    );
    process.exit(3);
  }

  // Spot-check the first 5 rows.
  const sampleIds = toUpdate.slice(0, 5).map((r) => r.id);
  if (sampleIds.length > 0) {
    const { data: sample, error: sampleErr } = await supabase
      .from('voucher')
      .select('id, issued_at')
      .in('id', sampleIds);
    if (sampleErr) throw new Error(`Spot-check failed: ${sampleErr.message}`);
    sample.sort((a, b) => a.id.localeCompare(b.id));
    console.log('Spot-check (first 5):');
    let mismatches = 0;
    for (const row of sample) {
      const expected = toUpdate.find((r) => r.id === row.id)?.issuedAt;
      const got = row.issued_at ? new Date(row.issued_at).toISOString() : null;
      const expIso = expected ? new Date(expected).toISOString() : null;
      const ok = DRY_RUN ? true : got === expIso;
      if (!ok) mismatches++;
      console.log(
        `  ${row.id}  expected=${expected}  got=${got}  ${DRY_RUN ? '(dry-run)' : ok ? 'OK' : 'MISMATCH'}`
      );
    }
    if (!DRY_RUN && mismatches > 0) {
      console.error(`Spot-check found ${mismatches} mismatch(es).`);
      process.exit(4);
    }
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN complete - no rows written.');
  } else {
    console.log('\nCommitted.');
  }

  console.log('\nSummary:');
  console.log(`  total CSV rows: ${rows.length}`);
  console.log(`  unique UUIDs:   ${dedup.length}`);
  console.log(`  matched:        ${toUpdate.length}`);
  console.log(`  updated:        ${updated}`);
  console.log(`  missing:        ${missing.length}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
