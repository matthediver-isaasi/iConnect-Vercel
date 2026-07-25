/**
 * Task #3059 — One-off, idempotent audit/backfill of stored country values.
 *
 * The dashboard LMIC filter and country breakdowns resolve stored country
 * values (canonical names, ISO-2 codes, and common World Bank-style
 * variants) to ISO-2 codes via shared/countries.js. Any stored value that
 * resolveCountryToIso2 CANNOT resolve silently fails the LMIC filter and
 * never appears in country breakdowns — the organisation is under-counted
 * with no visible error.
 *
 * This script:
 *   - Scans every `countries`- and `country`-typed preference field's
 *     stored values (organization / member / job_posting preference value
 *     tables) plus the system `organization.country` column.
 *   - Reports every value resolveCountryToIso2 cannot resolve, grouped by
 *     tenant, so admins can fix typos by hand.
 *   - With --apply, rewrites values that DO resolve but are not stored in
 *     canonical form (aliases like "Lao PDR", case/whitespace/apostrophe
 *     variants) to the canonical country name from shared/countries.js.
 *     Values already stored as canonical names are left untouched, as are
 *     valid ISO-2 codes (the resolver handles codes natively; rewriting
 *     them to names would change what admins see in record views).
 *     Unresolvable values are never modified. Idempotent: a second run
 *     finds nothing to rewrite.
 *
 * Usage:
 *   node scripts/audit-country-values.mjs                 # dry-run, all tenants
 *   node scripts/audit-country-values.mjs --tenant=<uuid> # dry-run, single tenant
 *   node scripts/audit-country-values.mjs --apply         # rewrite variants
 *   node scripts/audit-country-values.mjs --verbose       # per-row detail
 */
import { createClient } from '@supabase/supabase-js';
import { resolveCountryToIso2, getCountryByCode } from '../shared/countries.js';

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

const PREFERENCE_TABLES = [
  'organization_preference_value',
  'member_preference_value',
  'job_posting_preference_value',
];

const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

// tenantId -> Map(value -> count) of values the resolver can't handle.
const unresolvableByTenant = new Map();

function recordUnresolvable(tenantId, value) {
  const key = tenantId || '(unknown tenant)';
  if (!unresolvableByTenant.has(key)) unresolvableByTenant.set(key, new Map());
  const m = unresolvableByTenant.get(key);
  const v = String(value);
  m.set(v, (m.get(v) || 0) + 1);
}

// Is this stored string already in the form we consider canonical?
// Canonical = the exact country name from COUNTRIES, or a valid ISO-2
// code (upper or lower case codes both resolve; we only leave EXACT
// uppercase codes alone — "ke" is a variant and gets rewritten).
function canonicalFormOf(value) {
  if (typeof value !== 'string') value = String(value);
  const code = resolveCountryToIso2(value);
  if (code === null) return { code: null, canonical: null, isCanonical: false };
  if (value === code) return { code, canonical: value, isCanonical: true }; // exact ISO-2 code
  const name = getCountryByCode(code)?.name || null;
  return { code, canonical: name, isCanonical: value === name };
}

// Normalise one stored scalar. Returns { changed, next } and records
// unresolvable values against the tenant.
function normaliseScalar(value, tenantId) {
  if (value === null || value === undefined || value === '') {
    return { changed: false, next: value };
  }
  const { code, canonical, isCanonical } = canonicalFormOf(value);
  if (code === null) {
    recordUnresolvable(tenantId, value);
    return { changed: false, next: value };
  }
  if (isCanonical || !canonical) return { changed: false, next: value };
  return { changed: true, next: canonical };
}

// Preference values for `countries` fields are stored as JSON arrays
// (sometimes of strings, sometimes of {value,label} objects); `country`
// fields are plain strings. Handle all shapes, preserving structure.
function normaliseStoredValue(raw, tenantId) {
  if (raw === null || raw === undefined) return { changed: false, next: raw };
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof s === 'string' && (s.startsWith('[') || s.startsWith('{'))) {
    let parsed;
    try { parsed = JSON.parse(s); } catch { parsed = null; }
    if (Array.isArray(parsed)) {
      let changed = false;
      const next = parsed.map((item) => {
        if (item === null || item === undefined || item === '') return item;
        if (typeof item === 'object' && 'value' in item) {
          const r = normaliseScalar(item.value, tenantId);
          if (!r.changed) return item;
          changed = true;
          const out = { ...item, value: r.next };
          if ('label' in out) out.label = r.next;
          return out;
        }
        const r = normaliseScalar(item, tenantId);
        if (r.changed) changed = true;
        return r.next;
      });
      return { changed, next: changed ? JSON.stringify(next) : raw };
    }
    // Non-array JSON (unexpected) — leave alone, don't flag.
    return { changed: false, next: raw };
  }
  if (typeof s !== 'string') return { changed: false, next: raw };
  const r = normaliseScalar(s, tenantId);
  return { changed: r.changed, next: r.changed ? r.next : raw };
}

async function loadCountryFields() {
  const PAGE = 1000;
  let from = 0;
  const fields = [];
  while (true) {
    let q = supabase
      .from('preference_field')
      .select('id, tenant_id, field_type, label')
      .in('field_type', ['countries', 'country'])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (TENANT_FILTER) q = q.eq('tenant_id', TENANT_FILTER);
    const { data, error } = await q;
    if (error) throw new Error(`preference_field load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    fields.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return fields;
}

async function processPreferenceTable(table, fields) {
  const totals = { scanned: 0, alreadyCanonical: 0, rewritten: 0, unresolvable: 0, errors: 0 };
  if (fields.length === 0) return totals;
  const tenantByFieldId = new Map(fields.map((f) => [f.id, f.tenant_id]));

  log(`\n=== ${table} ${APPLY ? '(LIVE)' : '(dry-run)'} ===`);

  const CHUNK = 100;
  const fieldIds = fields.map((f) => f.id);
  for (let i = 0; i < fieldIds.length; i += CHUNK) {
    const chunk = fieldIds.slice(i, i + CHUNK);
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
          log('  (table not present in this DB — skipping)');
          return totals;
        }
        totals.errors++;
        console.error(`  load error: ${error.message}`);
        break;
      }
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        totals.scanned++;
        const tenantId = tenantByFieldId.get(row.field_id) || null;
        const before = unresolvableTotal();
        const { changed, next } = normaliseStoredValue(row.value, tenantId);
        totals.unresolvable += unresolvableTotal() - before;
        if (!changed) {
          totals.alreadyCanonical++;
          continue;
        }
        if (!APPLY) {
          totals.rewritten++;
          vlog(`  [dry] ${table}#${row.id} ${JSON.stringify(row.value)} -> ${JSON.stringify(next)}`);
          continue;
        }
        const { error: upErr } = await supabase
          .from(table)
          .update({ value: next })
          .eq('id', row.id);
        if (upErr) {
          totals.errors++;
          console.error(`  [error] ${table}#${row.id}: ${upErr.message}`);
        } else {
          totals.rewritten++;
          vlog(`  ${table}#${row.id} ${JSON.stringify(row.value)} -> ${JSON.stringify(next)}`);
        }
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }
  log(`  summary: ${JSON.stringify(totals)}`);
  return totals;
}

async function processOrganizationCountryColumn() {
  const totals = { scanned: 0, alreadyCanonical: 0, rewritten: 0, unresolvable: 0, errors: 0 };
  log(`\n=== organization.country ${APPLY ? '(LIVE)' : '(dry-run)'} ===`);

  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = supabase
      .from('organization')
      .select('id, tenant_id, country')
      .not('country', 'is', null)
      .neq('country', '')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (TENANT_FILTER) q = q.eq('tenant_id', TENANT_FILTER);
    const { data: rows, error } = await q;
    if (error) {
      if (/column .*country.* does not exist/i.test(error.message || '')) {
        log('  (organization has no `country` column in this DB — skipping)');
        return totals;
      }
      totals.errors++;
      console.error(`  load error: ${error.message}`);
      break;
    }
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      totals.scanned++;
      const before = unresolvableTotal();
      const { changed, next } = normaliseScalar(row.country.trim(), row.tenant_id);
      totals.unresolvable += unresolvableTotal() - before;
      if (!changed) {
        totals.alreadyCanonical++;
        continue;
      }
      if (!APPLY) {
        totals.rewritten++;
        vlog(`  [dry] organization#${row.id} ${JSON.stringify(row.country)} -> ${JSON.stringify(next)}`);
        continue;
      }
      const { error: upErr } = await supabase
        .from('organization')
        .update({ country: next })
        .eq('id', row.id);
      if (upErr) {
        totals.errors++;
        console.error(`  [error] organization#${row.id}: ${upErr.message}`);
      } else {
        totals.rewritten++;
        vlog(`  organization#${row.id} ${JSON.stringify(row.country)} -> ${JSON.stringify(next)}`);
      }
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  log(`  summary: ${JSON.stringify(totals)}`);
  return totals;
}

function unresolvableTotal() {
  let n = 0;
  for (const m of unresolvableByTenant.values()) {
    for (const c of m.values()) n += c;
  }
  return n;
}

async function main() {
  log(`\n=== Audit stored country values ${APPLY ? '(LIVE)' : '(dry-run)'} ===`);
  log(`Tenant filter: ${TENANT_FILTER || '(all)'}`);

  const fields = await loadCountryFields();
  log(`Loaded ${fields.length} country/countries preference_field row(s).`);

  const grand = { scanned: 0, alreadyCanonical: 0, rewritten: 0, unresolvable: 0, errors: 0 };
  for (const t of PREFERENCE_TABLES) {
    const r = await processPreferenceTable(t, fields);
    for (const k of Object.keys(grand)) grand[k] += r[k];
  }
  const orgTotals = await processOrganizationCountryColumn();
  for (const k of Object.keys(grand)) grand[k] += orgTotals[k];

  log('\n=== Unresolvable values by tenant ===');
  if (unresolvableByTenant.size === 0) {
    log('(none — every stored country value resolves)');
  } else {
    for (const [tenantId, values] of unresolvableByTenant) {
      log(`\nTenant ${tenantId}:`);
      const sorted = [...values.entries()].sort((a, b) => b[1] - a[1]);
      for (const [value, count] of sorted) {
        log(`  ${JSON.stringify(value)}  x${count}`);
      }
    }
    log('\nThese values never match the LMIC filter or country breakdowns.');
    log('Fix them by hand in the record UI, or add an alias to NAME_ALIASES');
    log('in shared/countries.js and re-run with --apply.');
  }

  log('\n=== Grand summary ===');
  log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...grand }, null, 2));
  if (!APPLY) {
    log('\n(no rows were modified — re-run with --apply to rewrite resolvable variants)');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
