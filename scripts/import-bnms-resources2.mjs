/**
 * Task #1192 — One-off import (batch 2): load the BNMS posters CSV into the
 * `resource` table for tenant BNMS (ff2df806-b321-4254-b651-3af11fccf1db).
 *
 * Differences from scripts/import-bnms-resources.mjs (Task #1087):
 *   - Source CSV is `;`-delimited (not comma).
 *   - Focus-area cells are marked with "X"/"x" (not "Yes").
 *   - Every row is imported as PUBLIC (is_public = true) regardless of the
 *     "Member Only" column (which is uniformly "Yes" in this file).
 *   - There is an extra "Collection" column (uniformly "Events") which is
 *     ignored.
 *   - Resource Type is uniformly "Posters"; create-missing adds "Posters" to
 *     the "Resource Type" category and "Artificial intelligence" to the
 *     "Focus Area" category.
 *
 * Usage:
 *   node scripts/import-bnms-resources2.mjs --dry-run --create-missing-categories
 *   node scripts/import-bnms-resources2.mjs --create-missing-categories
 *   node scripts/import-bnms-resources2.mjs --tenant=<uuid> --csv=<path>
 *   node scripts/import-bnms-resources2.mjs --limit=5
 *
 * Idempotent: matches existing rows on (tenant_id, target_url) and updates
 * them; if target_url is missing, falls back to (tenant_id, title).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const TENANT_ID = args.tenant || 'ff2df806-b321-4254-b651-3af11fccf1db';
const CSV_PATH = args.csv || './attached_assets/bnms-resources2_1780477749303.csv';
const DRY_RUN = !!args['dry-run'];
const LIMIT = args.limit ? Number(args.limit) : null;
const CREATE_MISSING = !!args['create-missing-categories'];

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

// Map CSV Focus Area header → exact category subcategory name (handle drift).
const FOCUS_AREA_ALIASES = {
  'Management and Workforce': 'Management & Workforce',
};

const RESOURCE_TYPE_CATEGORY = 'Resource Type';
const FOCUS_AREA_CATEGORY = 'Focus Area';

// Non-focus-area columns. Focus-area columns are everything after
// "Resource Type". Collection is ignored (uniformly "Events").
const META_COLUMNS = new Set([
  'Page URL', 'Menu Item', 'Resource URL', 'Title', 'Brief Description',
  'Date', 'Member Only', 'Collection', 'Resource Type',
]);

// ---------- Date parsing ----------

// Excel 1900 serial day-number → ISO date (yyyy-mm-dd).
// Accounts for the well-known Excel leap-year bug (treats 1900 as leap).
function excelSerialToIso(n) {
  // Excel epoch is 1899-12-30 to absorb the 1900 leap bug for serials >= 60.
  const ms = (n - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseDate(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;

  // Pure number → Excel serial.
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    // 4-digit year only (e.g. 2023).
    if (n >= 1900 && n <= 2100 && v.length === 4) {
      return new Date(Date.UTC(n, 0, 1)).toISOString();
    }
    // Otherwise treat as Excel serial.
    if (n > 1000) {
      return excelSerialToIso(n);
    }
  }

  // dd/mm/yyyy
  const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))).toISOString();
  }

  // MMM-YY (e.g. Jan-23)
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mmYY = v.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (mmYY) {
    const monthIdx = monthNames.indexOf(mmYY[1].slice(0,1).toUpperCase() + mmYY[1].slice(1,3).toLowerCase());
    if (monthIdx >= 0) {
      const yy = Number(mmYY[2]);
      // 00-49 → 2000-2049, 50-99 → 1950-1999 (matches Excel convention).
      const year = yy < 50 ? 2000 + yy : 1900 + yy;
      return new Date(Date.UTC(year, monthIdx, 1)).toISOString();
    }
  }

  // ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

// ---------- Main ----------

async function main() {
  const csvRaw = readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
  const rows = parse(csvRaw, { columns: true, skip_empty_lines: true, trim: true, delimiter: ';' });
  console.log(`Read ${rows.length} CSV rows from ${CSV_PATH}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const headers = Object.keys(rows[0] || {});
  // Focus Area columns = everything after "Resource Type" column.
  const rtIdx = headers.indexOf('Resource Type');
  const focusAreaHeaders = rtIdx >= 0 ? headers.slice(rtIdx + 1) : [];

  // Load categories for the tenant.
  const { data: cats, error: catErr } = await supabase
    .from('resource_category')
    .select('id, name, subcategories')
    .eq('tenant_id', TENANT_ID);
  if (catErr) throw catErr;

  const categoriesByName = new Map(cats.map((c) => [c.name, c]));
  const resourceTypeCat = categoriesByName.get(RESOURCE_TYPE_CATEGORY);
  const focusAreaCat = categoriesByName.get(FOCUS_AREA_CATEGORY);
  if (!resourceTypeCat) {
    console.error(`Tenant has no "${RESOURCE_TYPE_CATEGORY}" category — aborting.`);
    process.exit(1);
  }
  if (!focusAreaCat) {
    console.error(`Tenant has no "${FOCUS_AREA_CATEGORY}" category — aborting.`);
    process.exit(1);
  }

  // Resolve focus area column header → subcategory name (apply aliases),
  // and collect missing subcategory names.
  const focusAreaSubByHeader = {};
  const missingFocusAreas = new Set();
  const focusAreaSubs = new Set(focusAreaCat.subcategories || []);
  for (const h of focusAreaHeaders) {
    const mapped = FOCUS_AREA_ALIASES[h] || h;
    focusAreaSubByHeader[h] = mapped;
    if (!focusAreaSubs.has(mapped)) missingFocusAreas.add(mapped);
  }

  // Resource Type values used in column (every row uses "Posters" per task).
  const resourceTypeSubs = new Set(resourceTypeCat.subcategories || []);
  const missingResourceTypes = new Set();
  const usedResourceTypes = new Set();
  for (const r of rows) {
    const v = (r['Resource Type'] || '').trim();
    if (v) {
      usedResourceTypes.add(v);
      if (!resourceTypeSubs.has(v)) missingResourceTypes.add(v);
    }
  }

  if (missingFocusAreas.size || missingResourceTypes.size) {
    console.log('\nMissing subcategories:');
    if (missingResourceTypes.size) {
      console.log(`  On "${RESOURCE_TYPE_CATEGORY}":`, [...missingResourceTypes]);
    }
    if (missingFocusAreas.size) {
      console.log(`  On "${FOCUS_AREA_CATEGORY}":`, [...missingFocusAreas]);
    }
    if (!CREATE_MISSING) {
      console.error('\nAborting. Re-run with --create-missing-categories to add them, or update CategoryManagement first.');
      process.exit(1);
    }
    if (DRY_RUN) {
      console.log('  (dry-run — would add these to the categories)');
    } else {
      // Add and persist.
      if (missingResourceTypes.size) {
        const newSubs = [...new Set([...(resourceTypeCat.subcategories || []), ...missingResourceTypes])]
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        const { error } = await supabase
          .from('resource_category')
          .update({ subcategories: newSubs })
          .eq('id', resourceTypeCat.id);
        if (error) throw error;
        console.log(`  Added to "${RESOURCE_TYPE_CATEGORY}": ${[...missingResourceTypes].join(', ')}`);
      }
      if (missingFocusAreas.size) {
        const newSubs = [...new Set([...(focusAreaCat.subcategories || []), ...missingFocusAreas])]
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        const { error } = await supabase
          .from('resource_category')
          .update({ subcategories: newSubs })
          .eq('id', focusAreaCat.id);
        if (error) throw error;
        console.log(`  Added to "${FOCUS_AREA_CATEGORY}": ${[...missingFocusAreas].join(', ')}`);
      }
    }
  }

  // Load existing resources for the tenant to support idempotent upsert.
  const { data: existing, error: exErr } = await supabase
    .from('resource')
    .select('id, title, target_url')
    .eq('tenant_id', TENANT_ID);
  if (exErr) throw exErr;
  const byTargetUrl = new Map();
  const byTitle = new Map();
  for (const e of existing) {
    if (e.target_url) byTargetUrl.set(e.target_url, e);
    if (e.title) byTitle.set(e.title.trim().toLowerCase(), e);
  }

  // Transform rows.
  const transformed = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2;
    const title = (r['Title'] || '').trim();
    if (!title) {
      transformed.push({ rowNum, skip: 'empty title' });
      continue;
    }
    const target_url = (r['Resource URL'] || '').trim();
    const description = (r['Brief Description'] || '').replace(/\s+$/, '');
    const dateRaw = (r['Date'] || '').trim();
    const release_date = parseDate(dateRaw);
    if (dateRaw && !release_date) {
      transformed.push({ rowNum, title, skip: `unparseable date: "${dateRaw}"` });
      continue;
    }
    // Per task: import ALL rows as PUBLIC regardless of "Member Only".
    const is_public = true;

    const subs = new Set();
    const rtVal = (r['Resource Type'] || '').trim();
    if (rtVal) subs.add(rtVal);
    for (const h of focusAreaHeaders) {
      if ((r[h] || '').trim().toLowerCase() === 'x') {
        subs.add(focusAreaSubByHeader[h]);
      }
    }

    transformed.push({
      rowNum,
      title,
      target_url,
      description,
      release_date,
      is_public,
      subcategories: [...subs],
    });
  }

  const usable = transformed.filter((t) => !t.skip);
  const skipped = transformed.filter((t) => t.skip);
  const slice = LIMIT ? usable.slice(0, LIMIT) : usable;

  // Decide insert vs update for each.
  let toInsert = 0, toUpdate = 0;
  const plans = slice.map((t) => {
    let match = t.target_url ? byTargetUrl.get(t.target_url) : null;
    if (!match) match = byTitle.get(t.title.trim().toLowerCase());
    if (match) toUpdate++;
    else toInsert++;
    return { ...t, existingId: match?.id || null };
  });

  console.log(`\nPlan: ${toInsert} insert, ${toUpdate} update, ${skipped.length} skipped (of ${rows.length} rows).`);
  if (skipped.length) {
    for (const s of skipped) console.log(`  skip row ${s.rowNum} "${s.title || ''}" — ${s.skip}`);
  }

  // Show 3 sample transforms.
  console.log('\nSample transformed rows:');
  for (const p of plans.slice(0, 3)) {
    console.log(JSON.stringify({
      rowNum: p.rowNum,
      title: p.title,
      target_url: p.target_url,
      release_date: p.release_date,
      is_public: p.is_public,
      subcategories: p.subcategories,
      description: p.description.slice(0, 80) + (p.description.length > 80 ? '…' : ''),
      action: p.existingId ? `update ${p.existingId}` : 'insert',
    }, null, 2));
  }

  if (DRY_RUN) {
    console.log('\nDry run — no writes performed.');
    return;
  }

  const totals = { inserted: 0, updated: 0, errors: 0 };
  const toPayload = (p) => ({
    tenant_id: TENANT_ID,
    title: p.title,
    description: p.description,
    target_url: p.target_url,
    resource_type: 'external_link',
    open_in_new_tab: true,
    release_date: p.release_date,
    is_public: p.is_public,
    subcategories: p.subcategories,
    status: 'active',
    allowed_role_ids: [],
    linked_events: [],
    tags: [],
    author_id: '',
    author_name: '',
    image_url: '',
    folder_id: null,
  });

  // Run async ops with bounded concurrency so large imports finish quickly
  // without exhausting the connection pool.
  const CONCURRENCY = 20;
  async function runPooled(items, worker) {
    let idx = 0;
    const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (idx < items.length) {
        const my = idx++;
        await worker(items[my]);
      }
    });
    await Promise.all(runners);
  }

  await runPooled(plans, async (p) => {
    const payload = toPayload(p);
    if (p.existingId) {
      const { error } = await supabase.from('resource').update(payload).eq('id', p.existingId);
      if (error) {
        totals.errors++;
        console.error(`  row ${p.rowNum} update failed: ${error.message}`);
      } else {
        totals.updated++;
      }
    } else {
      const { error } = await supabase.from('resource').insert(payload);
      if (error) {
        totals.errors++;
        console.error(`  row ${p.rowNum} insert failed: ${error.message}`);
      } else {
        totals.inserted++;
      }
    }
  });

  console.log('\n=== Summary ===');
  console.log(`Rows read:    ${rows.length}`);
  console.log(`Inserted:     ${totals.inserted}`);
  console.log(`Updated:      ${totals.updated}`);
  console.log(`Skipped:      ${skipped.length}`);
  console.log(`Errors:       ${totals.errors}`);
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
