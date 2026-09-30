#!/usr/bin/env node

/**
 * Delete iConnect Organisations
 *
 * One-off cleanup: bulk-delete a specific list of organisations from the iConnect
 * tenant. Names to delete come from `.local/tasks/orgs-to-delete.csv`. Matching is
 * case-insensitive, trimmed, and strictly scoped to the configured tenant id.
 *
 * Usage:
 *   node scripts/migrations/delete-iconnect-orgs.mjs              (dry-run, default)
 *   node scripts/migrations/delete-iconnect-orgs.mjs --apply      (actually commit)
 *
 * Env: requires DEST_DATABASE_URL (or DATABASE_URL) for connection.
 *
 * Dependent-row policy (per FK introspection of `organization` references):
 *   SET NULL (history is meaningful even without the org)
 *     - booking.organization_id
 *     - complex_event_booking.organization_id           (no FK constraint, soft ref)
 *     - discount_code.organization_id                    (org-targeted code becomes unrestricted)
 *     - form_submission.organization_id
 *     - form_submission.created_organization_id
 *     - fundraising_team_member.organization_id
 *     - i_edit_page.organization_id
 *     - i_edit_page_element.organization_id
 *     - job_posting.posted_by_organization_id
 *     - member.organization_id
 *     - voucher_transaction.organization_id              (already FK SET NULL)
 *   DELETE (NOT NULL column or pure org-scoped child data)
 *     - discount_code_usage     (NOT NULL)
 *     - organization_contact    (NOT NULL, per-org child rows)
 *     - program_ticket_transaction (NOT NULL)
 *     - voucher                 (NOT NULL)
 *   CASCADE (handled automatically by FK)
 *     - organisation_award_assignment
 *     - organization_preference_value
 *     - training_fund_transaction
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.resolve(__dirname, '../../.local/tasks/orgs-to-delete.csv');

const DB_URL = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;

const SET_NULL_TABLES = [
  ['booking', 'organization_id'],
  ['complex_event_booking', 'organization_id'],
  ['discount_code', 'organization_id'],
  ['form_submission', 'organization_id'],
  ['form_submission', 'created_organization_id'],
  ['fundraising_team_member', 'organization_id'],
  ['i_edit_page', 'organization_id'],
  ['i_edit_page_element', 'organization_id'],
  ['job_posting', 'posted_by_organization_id'],
  ['member', 'organization_id'],
  ['voucher_transaction', 'organization_id'],
];

const DELETE_TABLES = [
  ['discount_code_usage', 'organization_id'],
  ['organization_contact', 'organization_id'],
  ['program_ticket_transaction', 'organization_id'],
  ['voucher', 'organization_id'],
];

const CASCADE_TABLES = [
  ['organisation_award_assignment', 'organization_id'],
  ['organization_preference_value', 'organization_id'],
  ['training_fund_transaction', 'organization_id'],
];

function parseArgs() {
  const args = { apply: false, confirm: false, help: false, insecure: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--i-have-reviewed-the-dry-run') args.confirm = true;
    else if (arg === '--insecure-tls') args.insecure = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

// Windows-1252 punctuation chars that fall in 0x80-0x9F when reverse-mapped.
const CP1252_REVERSE = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F,
};

function toCp1252Bytes(s) {
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xFF) bytes.push(cp);
    else if (CP1252_REVERSE[cp] !== undefined) bytes.push(CP1252_REVERSE[cp]);
    else return null; // unmappable -> can't repair
  }
  return Buffer.from(bytes);
}

function repairMojibake(s) {
  // CSV rows are sometimes double- or triple-encoded UTF-8 (UTF-8 bytes
  // interpreted as Windows-1252). Each repair pass re-encodes as cp1252 then
  // decodes as utf-8. We try up to 2 passes so callers can match against the
  // original or any partially-repaired form held in the database.
  const out = new Set();
  let cur = s;
  for (let i = 0; i < 2; i++) {
    const bytes = toCp1252Bytes(cur);
    if (!bytes) break;
    const next = bytes.toString('utf8');
    if (next === cur || next.includes('\uFFFD')) break;
    out.add(next);
    cur = next;
  }
  return Array.from(out);
}

function loadCsvNames() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = raw.split(/\r?\n/);
  const seen = new Map(); // lower -> original
  for (let line of lines) {
    if (!line) continue;
    // Strip BOM
    line = line.replace(/^\uFEFF/, '');
    // Strip leading '#' (only on the first entry per task)
    if (line.startsWith('#')) line = line.slice(1);
    // Strip surrounding quotes (CSV quoting)
    line = line.trim();
    if (line.startsWith('"') && line.endsWith('"')) {
      line = line.slice(1, -1).replace(/""/g, '"');
    }
    line = line.trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (!seen.has(key)) seen.set(key, line);
  }
  return Array.from(seen.values());
}

function candidateKeys(name) {
  // Return possible match keys (lowercased, trimmed) for a CSV name, including
  // mojibake-repaired forms and a variant with a leading '#' (since one CSV
  // entry has '#' stripped per task instructions while the DB still keeps it).
  const keys = new Set();
  const variants = [name, '#' + name];
  for (const v of variants) {
    keys.add(v.trim().toLowerCase());
    for (const r of repairMojibake(v)) {
      keys.add(r.trim().toLowerCase());
    }
  }
  return Array.from(keys);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`Usage: node scripts/migrations/delete-iconnect-orgs.mjs [options]

Options:
  --dry-run                          (default) Show match + dependency report; no changes.
  --apply                            Actually delete. Requires --i-have-reviewed-the-dry-run.
  --i-have-reviewed-the-dry-run      Explicit confirmation that the dry-run was reviewed.
  --insecure-tls                     Disable TLS verification (local/dev only — NOT for prod).
  --help, -h                         Show this help.

Workflow:
  1. Run with no flags to produce the dry-run report.
  2. Review matched org IDs, unmatched names, ambiguous names, and dependent counts.
  3. Re-run with: --apply --i-have-reviewed-the-dry-run`);
    process.exit(0);
  }
  if (!DB_URL) {
    console.error('Error: DEST_DATABASE_URL or DATABASE_URL must be set.');
    process.exit(1);
  }
  if (args.apply && !args.confirm) {
    console.error('Error: --apply requires --i-have-reviewed-the-dry-run.');
    console.error('Run the script without --apply first to produce the dry-run report,');
    console.error('review it carefully, then re-run with both flags.');
    process.exit(1);
  }

  const mode = args.apply ? 'APPLY (changes will be committed)' : 'DRY-RUN (no changes)';
  console.log('=== Delete iConnect Organisations ===');
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`CSV:    ${CSV_PATH}`);
  console.log(`Mode:   ${mode}`);
  console.log('');

  const csvNames = loadCsvNames();
  console.log(`CSV names (deduped, case-insensitive): ${csvNames.length}`);

  // SSL: verify by default. --insecure-tls is opt-in for local/dev use only.
  const ssl = args.insecure ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const client = new Client({ connectionString: DB_URL, ssl });
  await client.connect();

  try {
    // Match against organization table for tenant
    const matchRes = await client.query(
      `SELECT id, name, LOWER(TRIM(name)) AS key
       FROM organization
       WHERE tenant_id = $1`,
      [TENANT_ID]
    );

    const orgsByKey = new Map(); // lowerKey -> [{id,name},...]
    for (const row of matchRes.rows) {
      const k = row.key;
      if (!orgsByKey.has(k)) orgsByKey.set(k, []);
      orgsByKey.get(k).push({ id: row.id, name: row.name });
    }

    const matched = []; // {csvName, id, name}
    const unmatched = [];
    const ambiguous = []; // {csvName, candidates}

    for (const csvName of csvNames) {
      const keys = candidateKeys(csvName);
      let hits = [];
      for (const k of keys) {
        const h = orgsByKey.get(k);
        if (h && h.length) { hits = h; break; }
      }
      if (hits.length === 0) {
        unmatched.push(csvName);
      } else if (hits.length > 1) {
        ambiguous.push({ csvName, candidates: hits });
        for (const h of hits) matched.push({ csvName, id: h.id, name: h.name });
      } else {
        matched.push({ csvName, id: hits[0].id, name: hits[0].name });
      }
    }

    const matchedIds = matched.map((m) => m.id);
    const uniqueIds = Array.from(new Set(matchedIds));

    console.log('\n--- Match report ---');
    console.log(`Matched orgs (rows):  ${matched.length}`);
    console.log(`Matched orgs (uniq):  ${uniqueIds.length}`);
    console.log(`Unmatched CSV names:  ${unmatched.length}`);
    console.log(`Ambiguous CSV names:  ${ambiguous.length}`);

    if (unmatched.length) {
      console.log('\nUnmatched CSV names:');
      for (const n of unmatched) console.log(`  - ${n}`);
    }
    if (ambiguous.length) {
      console.log('\nAmbiguous CSV names (multiple orgs with same name in tenant):');
      for (const a of ambiguous) {
        console.log(`  * ${a.csvName}`);
        for (const c of a.candidates) console.log(`      ${c.id}  ${c.name}`);
      }
    }

    if (uniqueIds.length === 0) {
      console.log('\nNothing to delete. Exiting.');
      await client.end();
      return;
    }

    // Full matched-org listing (id + name) so the dry-run report supports
    // explicit confirmation before destructive execution.
    console.log('\n--- Matched organisations (will be deleted) ---');
    const sortedMatched = [...matched].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    for (const m of sortedMatched) {
      console.log(`  ${m.id}  ${m.name}`);
    }

    // Live FK introspection: list ALL foreign keys referencing organization(id),
    // and verify every one is covered by an explicit policy (SET NULL, DELETE,
    // or relies on a CASCADE/SET NULL FK delete rule). Fail fast if any
    // dependent column is unaccounted for, so we never leave orphans behind.
    console.log('\n--- FK introspection ---');
    const fkRes = await client.query(`
      SELECT
        conrelid::regclass::text AS table_name,
        a.attname               AS column_name,
        c.confdeltype           AS delete_rule
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f'
        AND c.confrelid = 'organization'::regclass
      ORDER BY table_name, column_name;
    `);
    const policySet = new Set([
      ...SET_NULL_TABLES.map(([t, c]) => `${t}.${c}`),
      ...DELETE_TABLES.map(([t, c]) => `${t}.${c}`),
      ...CASCADE_TABLES.map(([t, c]) => `${t}.${c}`),
    ]);
    const unaccounted = [];
    for (const fk of fkRes.rows) {
      const key = `${fk.table_name}.${fk.column_name}`;
      const ruleLabel =
        fk.delete_rule === 'c' ? 'FK CASCADE'
        : fk.delete_rule === 'n' ? 'FK SET NULL'
        : fk.delete_rule === 'd' ? 'FK SET DEFAULT'
        : fk.delete_rule === 'r' ? 'FK RESTRICT'
        : 'FK NO ACTION';
      const policyLabel = policySet.has(key) ? 'covered' : 'MISSING';
      console.log(`  ${ruleLabel.padEnd(13)} ${key.padEnd(50)} ${policyLabel}`);
      if (!policySet.has(key)) {
        // FK delete rules that auto-resolve are safe to leave uncovered.
        if (fk.delete_rule !== 'c' && fk.delete_rule !== 'n') {
          unaccounted.push(key);
        }
      }
    }
    if (unaccounted.length) {
      console.error('\nERROR: Foreign keys reference organization(id) without an explicit cleanup policy:');
      for (const k of unaccounted) console.error(`  - ${k}`);
      console.error('Add each to SET_NULL_TABLES, DELETE_TABLES, or CASCADE_TABLES (with verified DB action).');
      await client.end();
      process.exit(2);
    }

    // Dependent-row counts
    console.log('\n--- Dependent row counts ---');
    const allTables = [
      ...SET_NULL_TABLES.map(([t, c]) => ({ t, c, action: 'SET NULL' })),
      ...DELETE_TABLES.map(([t, c]) => ({ t, c, action: 'DELETE' })),
      ...CASCADE_TABLES.map(([t, c]) => ({ t, c, action: 'CASCADE (auto)' })),
    ];
    const counts = {};
    for (const { t, c, action } of allTables) {
      const r = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${t} WHERE ${c} = ANY($1::uuid[])`,
        [uniqueIds]
      );
      counts[`${t}.${c}`] = { count: r.rows[0].n, action };
      console.log(`  ${action.padEnd(15)} ${t}.${c}: ${r.rows[0].n}`);
    }

    if (!args.apply) {
      console.log('\n[DRY-RUN] No changes made. Re-run with --apply to commit.');
      await client.end();
      return;
    }

    // APPLY: Wrap in transaction
    console.log('\n--- Applying changes ---');
    await client.query('BEGIN');
    try {
      // 1) NULL out FK columns
      for (const [t, c] of SET_NULL_TABLES) {
        const r = await client.query(
          `UPDATE ${t} SET ${c} = NULL WHERE ${c} = ANY($1::uuid[])`,
          [uniqueIds]
        );
        console.log(`  SET NULL ${t}.${c}: ${r.rowCount}`);
      }

      // 2) DELETE dependent rows where column is NOT NULL
      for (const [t, c] of DELETE_TABLES) {
        const r = await client.query(
          `DELETE FROM ${t} WHERE ${c} = ANY($1::uuid[])`,
          [uniqueIds]
        );
        console.log(`  DELETE   ${t}: ${r.rowCount}`);
      }

      // 3) DELETE the organisations themselves (tenant scoped for safety)
      const delRes = await client.query(
        `DELETE FROM organization
         WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [uniqueIds, TENANT_ID]
      );
      console.log(`  DELETE   organization: ${delRes.rowCount}`);

      await client.query('COMMIT');
      console.log('\n=== Summary ===');
      console.log(`CSV names:        ${csvNames.length}`);
      console.log(`Matched (uniq):   ${uniqueIds.length}`);
      console.log(`Unmatched:        ${unmatched.length}`);
      console.log(`Ambiguous names:  ${ambiguous.length}`);
      console.log(`Organisations deleted: ${delRes.rowCount}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('\nFAILED, transaction rolled back:', err.message);
      if (err.table) console.error(`  table: ${err.table}`);
      if (err.constraint) console.error(`  constraint: ${err.constraint}`);
      if (err.detail) console.error(`  detail: ${err.detail}`);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
