/**
 * Task #2143 — One-off import: load the BNMS "Spring Meeting 2026" resources
 * spreadsheet into the `resource` table for tenant BNMS
 * (ff2df806-b321-4254-b651-3af11fccf1db).
 *
 * Adapts scripts/import-bnms-resources.mjs / import-bnms-resources2.mjs.
 *
 * Source: attached_assets/Spring_Meeting_2026_resources_1782996382352.xlsx,
 * sheet "Resources" (the "Lists" sheet is ignored). 308 data rows + header.
 *
 * Column layout (shifted +1 vs the earlier import because of the leading
 * "Collection" column):
 *   A Collection        -> subcategory "Spring Meeting 2026" (Collection cat)
 *   B Resource URL       -> target_url (resource_type always 'external_link')
 *   C Title              -> title
 *   D Brief Description  -> description (trailing whitespace/newlines trimmed)
 *   E Date               -> release_date (Excel serial 46133 ~ 2026-04-21)
 *   F Member Only        -> is_public: "Yes" => false (all rows are "Yes")
 *   G Resource Type      -> subcategory ("Presentation" | "Posters")
 *   H..AL Focus Area cols-> for each cell == "Yes", the column header is added
 *                           to subcategories (Focus Area cat), canonicalised.
 *
 * Two Focus Area headers must be canonicalised to the existing subcategory
 * names before writing:
 *   "Management and Workforce" -> "Management & Workforce"
 *   "Artificial Intelligence"  -> "Artificial intelligence"
 *
 * Usage:
 *   node scripts/import-bnms-spring-meeting-2026-resources.mjs --dry-run
 *   node scripts/import-bnms-spring-meeting-2026-resources.mjs
 *   node scripts/import-bnms-spring-meeting-2026-resources.mjs --tenant=<uuid> --xlsx=<path>
 *   node scripts/import-bnms-spring-meeting-2026-resources.mjs --limit=5
 *   node scripts/import-bnms-spring-meeting-2026-resources.mjs --create-missing-categories
 *
 * Idempotent: matches existing rows on (tenant_id, target_url) and updates
 * them; if target_url is missing, falls back to (tenant_id, title).
 */
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const TENANT_ID = args.tenant || 'ff2df806-b321-4254-b651-3af11fccf1db';
const XLSX_PATH = args.xlsx || './attached_assets/Spring_Meeting_2026_resources_1782996382352.xlsx';
const SHEET_NAME = args.sheet || 'Resources';
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

// Fixed column indices for this spreadsheet layout.
const COL = {
  collection: 0,
  url: 1,
  title: 2,
  description: 3,
  date: 4,
  memberOnly: 5,
  resourceType: 6,
  firstFocusArea: 7,
};

// Map spreadsheet Focus Area header -> exact existing subcategory name.
const FOCUS_AREA_ALIASES = {
  'Management and Workforce': 'Management & Workforce',
  'Artificial Intelligence': 'Artificial intelligence',
};

const COLLECTION_CATEGORY = 'Collection';
const RESOURCE_TYPE_CATEGORY = 'Resource Type';
const FOCUS_AREA_CATEGORY = 'Focus Area';

// ---------- Date parsing ----------

// Excel 1900 serial day-number -> ISO date. Uses 1899-12-30 epoch to absorb
// the well-known Excel 1900 leap-year bug for serials >= 60.
function excelSerialToIso(n) {
  const ms = (n - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseDate(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;

  // Pure number -> Excel serial.
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    // 4-digit year only (e.g. 2023).
    if (n >= 1900 && n <= 2100 && v.length === 4) {
      return new Date(Date.UTC(n, 0, 1)).toISOString();
    }
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

  // ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

// ---------- Main ----------

async function main() {
  const wb = XLSX.readFile(XLSX_PATH);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    console.error(`Sheet "${SHEET_NAME}" not found in ${XLSX_PATH}. Sheets: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const header = matrix[0] || [];
  // Data rows = those with a URL or a Title (drops trailing blank rows).
  const rows = matrix.slice(1).filter(
    (r) => String(r[COL.url] || '').trim() || String(r[COL.title] || '').trim(),
  );

  console.log(`Read ${rows.length} data rows from ${XLSX_PATH} [${SHEET_NAME}]`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // Focus Area columns = everything from firstFocusArea to end of header.
  const focusAreaHeaders = header.slice(COL.firstFocusArea).map((h) => String(h || '').trim());

  // Load categories for the tenant.
  const { data: cats, error: catErr } = await supabase
    .from('resource_category')
    .select('id, name, subcategories')
    .eq('tenant_id', TENANT_ID);
  if (catErr) throw catErr;

  const categoriesByName = new Map(cats.map((c) => [c.name, c]));
  const collectionCat = categoriesByName.get(COLLECTION_CATEGORY);
  const resourceTypeCat = categoriesByName.get(RESOURCE_TYPE_CATEGORY);
  const focusAreaCat = categoriesByName.get(FOCUS_AREA_CATEGORY);
  for (const [label, cat] of [
    [COLLECTION_CATEGORY, collectionCat],
    [RESOURCE_TYPE_CATEGORY, resourceTypeCat],
    [FOCUS_AREA_CATEGORY, focusAreaCat],
  ]) {
    if (!cat) {
      console.error(`Tenant has no "${label}" category — aborting.`);
      process.exit(1);
    }
  }

  // Resolve focus-area header -> canonical subcategory name.
  const focusAreaSubByHeader = {};
  for (const h of focusAreaHeaders) {
    focusAreaSubByHeader[h] = FOCUS_AREA_ALIASES[h] || h;
  }

  const collectionSubs = new Set(collectionCat.subcategories || []);
  const resourceTypeSubs = new Set(resourceTypeCat.subcategories || []);
  const focusAreaSubs = new Set(focusAreaCat.subcategories || []);

  // ---- Transform rows ----
  const transformed = [];
  // Track which subcategories are actually USED so we only verify those.
  const usedCollection = new Set();
  const usedResourceType = new Set();
  const usedFocusArea = new Set();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2; // account for header row
    const title = String(r[COL.title] || '').trim();
    if (!title) {
      transformed.push({ rowNum, skip: 'empty title' });
      continue;
    }
    const target_url = String(r[COL.url] || '').trim();
    const description = String(r[COL.description] || '').replace(/\s+$/, '');
    const dateRaw = String(r[COL.date] ?? '').trim();
    const release_date = parseDate(dateRaw);
    if (dateRaw && !release_date) {
      transformed.push({ rowNum, title, skip: `unparseable date: "${dateRaw}"` });
      continue;
    }
    const memberOnly = String(r[COL.memberOnly] || '').trim().toLowerCase();
    const is_public = memberOnly !== 'yes';

    const subs = new Set();

    // Collection (column A).
    const collectionVal = String(r[COL.collection] || '').trim();
    if (collectionVal) {
      subs.add(collectionVal);
      usedCollection.add(collectionVal);
    }

    // Resource Type (column G).
    const rtVal = String(r[COL.resourceType] || '').trim();
    if (rtVal) {
      subs.add(rtVal);
      usedResourceType.add(rtVal);
    }

    // Focus Areas (columns H..).
    for (let c = 0; c < focusAreaHeaders.length; c++) {
      const cell = String(r[COL.firstFocusArea + c] || '').trim().toLowerCase();
      if (cell === 'yes') {
        const mapped = focusAreaSubByHeader[focusAreaHeaders[c]];
        subs.add(mapped);
        usedFocusArea.add(mapped);
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

  // ---- Verify every used subcategory exists (after canonicalisation) ----
  const missing = { collection: [], resourceType: [], focusArea: [] };
  for (const v of usedCollection) if (!collectionSubs.has(v)) missing.collection.push(v);
  for (const v of usedResourceType) if (!resourceTypeSubs.has(v)) missing.resourceType.push(v);
  for (const v of usedFocusArea) if (!focusAreaSubs.has(v)) missing.focusArea.push(v);

  const anyMissing = missing.collection.length || missing.resourceType.length || missing.focusArea.length;
  if (anyMissing) {
    console.log('\nMissing subcategories (after canonicalisation):');
    if (missing.collection.length) console.log(`  On "${COLLECTION_CATEGORY}":`, missing.collection);
    if (missing.resourceType.length) console.log(`  On "${RESOURCE_TYPE_CATEGORY}":`, missing.resourceType);
    if (missing.focusArea.length) console.log(`  On "${FOCUS_AREA_CATEGORY}":`, missing.focusArea);

    if (!CREATE_MISSING) {
      console.error('\nAborting. Re-run with --create-missing-categories to add them, or update CategoryManagement first.');
      process.exit(1);
    }
    if (DRY_RUN) {
      console.log('  (dry-run — would add these to the categories)');
    } else {
      const addTo = async (cat, names) => {
        if (!names.length) return;
        const newSubs = [...new Set([...(cat.subcategories || []), ...names])]
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        const { error } = await supabase
          .from('resource_category')
          .update({ subcategories: newSubs })
          .eq('id', cat.id);
        if (error) throw error;
        console.log(`  Added to "${cat.name}": ${names.join(', ')}`);
      };
      await addTo(collectionCat, missing.collection);
      await addTo(resourceTypeCat, missing.resourceType);
      await addTo(focusAreaCat, missing.focusArea);
    }
  } else {
    console.log('\nAll used subcategories already exist on the tenant. No category changes needed.');
  }

  // ---- Load existing resources for idempotent upsert ----
  // PostgREST caps a single response at 1000 rows; this tenant already has
  // well over 1000 resources, so page through them all or idempotency breaks
  // (uninserted-looking rows would be re-inserted as duplicates on re-run).
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: exErr } = await supabase
      .from('resource')
      .select('id, title, target_url')
      .eq('tenant_id', TENANT_ID)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (exErr) throw exErr;
    existing.push(...(page || []));
    if (!page || page.length < PAGE) break;
  }
  const byTargetUrl = new Map();
  const byTitle = new Map();
  for (const e of existing) {
    if (e.target_url) byTargetUrl.set(e.target_url, e);
    if (e.title) byTitle.set(e.title.trim().toLowerCase(), e);
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

  // Show 3 sample transforms with FULL subcategories arrays.
  console.log('\nSample transformed rows:');
  for (const p of plans.slice(0, 3)) {
    console.log(JSON.stringify({
      rowNum: p.rowNum,
      title: p.title,
      target_url: p.target_url,
      release_date: p.release_date,
      is_public: p.is_public,
      subcategories: p.subcategories,
      description: p.description.slice(0, 100) + (p.description.length > 100 ? '…' : ''),
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

  // Bounded concurrency so large imports finish quickly without exhausting
  // the connection pool.
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
