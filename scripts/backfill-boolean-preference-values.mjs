/**
 * Task #1138 — One-off, idempotent backfill of boolean preference_value rows
 * that were written in non-canonical form (e.g. "1", "yes", "on", "True")
 * by the workflow `update_field` action before the boolean coercion was
 * added there. The UI now uses a true Switch toggle that only treats the
 * canonical 'true' string (or boolean true) as on; anything else renders
 * as off, so these legacy rows look stuck until rewritten.
 *
 * Scope:
 *   - organization_preference_value
 *   - member_preference_value
 *   - job_posting_preference_value
 *
 * Behaviour:
 *   - For each row whose field_id references a preference_field with
 *     field_type IN ('boolean','checkbox') and whose `value` is not
 *     already 'true' or 'false', run through coerceBooleanPreferenceValue.
 *   - Rewrite to the canonical string. Rows that don't coerce cleanly
 *     are left alone and reported in the summary.
 *   - Dry-run by default. Use --apply to write.
 *
 * Usage:
 *   node scripts/backfill-boolean-preference-values.mjs                 # dry-run, all tenants
 *   node scripts/backfill-boolean-preference-values.mjs --tenant=<uuid> # dry-run, single tenant (via field tenant_id)
 *   node scripts/backfill-boolean-preference-values.mjs --apply
 *   node scripts/backfill-boolean-preference-values.mjs --verbose
 */
import { createClient } from '@supabase/supabase-js';
import { coerceBooleanPreferenceValue } from '../api/_lib/booleanCoercion.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const APPLY = !!args.apply;
const TENANT_FILTER = args.tenant || null;
const VERBOSE = !!args.verbose;

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const TABLES = [
  'organization_preference_value',
  'member_preference_value',
  'job_posting_preference_value',
];

const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

async function loadBooleanFieldIds() {
  const PAGE = 1000;
  let from = 0;
  const ids = [];
  while (true) {
    let q = supabase
      .from('preference_field')
      .select('id, tenant_id, field_type, label')
      .in('field_type', ['boolean', 'checkbox'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (TENANT_FILTER) q = q.eq('tenant_id', TENANT_FILTER);
    const { data, error } = await q;
    if (error) throw new Error(`preference_field load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    ids.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

async function processTable(table, fieldIds) {
  const totals = { scanned: 0, alreadyCanonical: 0, rewritten: 0, unmapped: 0, errors: 0 };
  if (fieldIds.length === 0) return totals;

  log(`\n=== ${table} ${APPLY ? '(LIVE)' : '(dry-run)'} ===`);

  const CHUNK = 100;
  for (let i = 0; i < fieldIds.length; i += CHUNK) {
    const chunk = fieldIds.slice(i, i + CHUNK).map((f) => f.id);
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: rows, error } = await supabase
        .from(table)
        .select('id, field_id, value')
        .in('field_id', chunk)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        if (/Could not find the table/i.test(error.message || '')) {
          log(`  (table not present in this DB — skipping)`);
          return totals;
        }
        totals.errors++;
        console.error(`  load error: ${error.message}`);
        break;
      }
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        totals.scanned++;
        const raw = row.value;
        if (raw === 'true' || raw === 'false') {
          totals.alreadyCanonical++;
          continue;
        }
        const coerced = coerceBooleanPreferenceValue(raw);
        if (coerced === null) {
          totals.unmapped++;
          vlog(`  [unmapped] ${table}#${row.id} field=${row.field_id} value=${JSON.stringify(raw)}`);
          continue;
        }
        if (!APPLY) {
          totals.rewritten++;
          vlog(`  [dry] ${table}#${row.id} ${JSON.stringify(raw)} -> "${coerced}"`);
          continue;
        }
        const { error: upErr } = await supabase
          .from(table)
          .update({ value: coerced })
          .eq('id', row.id);
        if (upErr) {
          totals.errors++;
          console.error(`  [error] ${table}#${row.id}: ${upErr.message}`);
        } else {
          totals.rewritten++;
          vlog(`  ${table}#${row.id} ${JSON.stringify(raw)} -> "${coerced}"`);
        }
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  log(`  summary: ${JSON.stringify(totals)}`);
  return totals;
}

async function main() {
  log(`\n=== Backfill boolean preference values ${APPLY ? '(LIVE)' : '(dry-run)'} ===`);
  log(`Tenant filter: ${TENANT_FILTER || '(all)'}`);

  const fields = await loadBooleanFieldIds();
  log(`Loaded ${fields.length} boolean/checkbox preference_field row(s).`);
  if (fields.length === 0) {
    log('Nothing to do.');
    return;
  }

  const grand = { scanned: 0, alreadyCanonical: 0, rewritten: 0, unmapped: 0, errors: 0 };
  for (const t of TABLES) {
    const r = await processTable(t, fields);
    for (const k of Object.keys(grand)) grand[k] += r[k];
  }

  log('\n=== Grand summary ===');
  log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...grand }, null, 2));
  if (!APPLY) {
    log('\n(no rows were modified — re-run with --apply to perform updates)');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
