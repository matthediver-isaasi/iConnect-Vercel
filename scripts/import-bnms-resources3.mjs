/**
 * Task #1195 — One-off import (corrected batch 3): load the BNMS *videos* CSV
 * into the `resource` table for tenant BNMS (ff2df806-b321-4254-b651-3af11fccf1db).
 *
 * Background: the original "batch 3" run (Task #1192/#1192-era) was wrong — the
 * uploaded file was a byte-identical duplicate of the batch-2 *posters* file, so
 * the real batch-3 content (YouTube videos) was never imported. This script loads
 * the corrected, structurally-different videos dataset.
 *
 * Differences from scripts/import-bnms-resources2.mjs (batch 2 posters):
 *   - Source CSV columns: "Video URL" → target_url, "Date uploaded" → release_date.
 *   - is_public is derived from "Member Only": "No" → public (true),
 *     "Yes" → member-only (false). (batch-2 forced every row public.)
 *   - Date parser extended for DD-MMM-YY, D MMM YYYY (incl. 4-letter "Sept"),
 *     and d/m/yy (2-digit year), on top of the existing formats.
 *   - Within-file de-duplication by extracted YouTube video id (fallback
 *     normalized title) so the same video in watch?v= and youtu.be/ forms only
 *     produces one resource.
 *   - Extra "Collection" column is ignored.
 *   - Resource Type is uniformly "Videos" (already a subcategory on the tenant).
 *
 * Usage:
 *   node scripts/import-bnms-resources3.mjs --dry-run --create-missing-categories
 *   node scripts/import-bnms-resources3.mjs --create-missing-categories
 *   node scripts/import-bnms-resources3.mjs --tenant=<uuid> --csv=<path>
 *   node scripts/import-bnms-resources3.mjs --limit=5
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
const CSV_PATH = args.csv || './attached_assets/BNMS-batch3-correct_1780479260692.csv';
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

// ---------- YouTube id extraction (for within-file de-duplication) ----------

// Some source rows have scheme-less YouTube URLs (e.g. "youtube.com/watch?v=…")
// which would be treated as relative links if stored as-is. Prepend https://.
// Returns '' if the value is empty or clearly not a URL (e.g. a title pasted
// into the URL column).
function normalizeUrl(url) {
  if (!url) return '';
  let v = String(url).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(www\.)?(youtube\.com|youtu\.be)\//i.test(v)) return `https://${v}`;
  return ''; // not a usable URL
}

function extractYouTubeId(url) {
  if (!url) return null;
  const v = String(url).trim();
  // https://www.youtube.com/watch?v=ID  (with optional &list=…&index=…)
  let m = v.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  // https://youtu.be/ID
  m = v.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  // https://www.youtube.com/embed/ID
  m = v.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  return null;
}

// ---------- Date parsing ----------

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthIndex(name) {
  if (!name) return -1;
  // Accept 3-letter and 4-letter (e.g. "Sept") abbreviations.
  const n = name.slice(0, 3).toLowerCase();
  return MONTH_NAMES.findIndex((m) => m.toLowerCase() === n);
}

// Two-digit year → full year (00-49 → 2000-2049, 50-99 → 1950-1999).
function expandTwoDigitYear(yy) {
  const n = Number(yy);
  return n < 50 ? 2000 + n : 1900 + n;
}

// Excel 1900 serial day-number → ISO date.
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

  // Pure number → 4-digit year or Excel serial.
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 1900 && n <= 2100 && v.length === 4) {
      return new Date(Date.UTC(n, 0, 1)).toISOString();
    }
    if (n > 1000) {
      return excelSerialToIso(n);
    }
  }

  // dd/mm/yyyy  OR  d/m/yy (2-digit year)
  const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (dmy) {
    const [, dd, mm, yr] = dmy;
    const year = yr.length === 2 ? expandTwoDigitYear(yr) : Number(yr);
    return new Date(Date.UTC(year, Number(mm) - 1, Number(dd))).toISOString();
  }

  // D MMM YYYY / DD MMM YYYY (e.g. "2 Dec 2025", "1 Sept 2025")
  const dMonY = v.match(/^(\d{1,2})\s+([A-Za-z]{3,4})\.?\s+(\d{4})$/);
  if (dMonY) {
    const mi = monthIndex(dMonY[2]);
    if (mi >= 0) {
      return new Date(Date.UTC(Number(dMonY[3]), mi, Number(dMonY[1]))).toISOString();
    }
  }

  // DD-MMM-YY / D-MMM-YY (e.g. "11-Dec-25", "9-Dec-24")
  const dMonYY = v.match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{2})$/);
  if (dMonYY) {
    const mi = monthIndex(dMonYY[2]);
    if (mi >= 0) {
      return new Date(Date.UTC(expandTwoDigitYear(dMonYY[3]), mi, Number(dMonYY[1]))).toISOString();
    }
  }

  // MMM-YY (e.g. "Nov-25", "Jan-26")
  const mmYY = v.match(/^([A-Za-z]{3,4})-(\d{2})$/);
  if (mmYY) {
    const mi = monthIndex(mmYY[1]);
    if (mi >= 0) {
      return new Date(Date.UTC(expandTwoDigitYear(mmYY[2]), mi, 1)).toISOString();
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

  // Resource Type values used in column (every row uses "Videos" per task).
  const resourceTypeSubs = new Set(resourceTypeCat.subcategories || []);
  const missingResourceTypes = new Set();
  for (const r of rows) {
    const v = (r['Resource Type'] || '').trim();
    if (v && !resourceTypeSubs.has(v)) missingResourceTypes.add(v);
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
  } else {
    console.log('\nNo missing subcategories — all Resource Type / Focus Area values already exist.');
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

  // Transform rows (with within-file de-duplication).
  const transformed = [];
  const seenByVideoId = new Map(); // youtube id → index in transformed (usable)
  const seenByTitle = new Map(); // normalized title → index in transformed (usable)

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2;
    const title = (r['Title'] || '').trim();
    if (!title) {
      transformed.push({ rowNum, skip: 'empty title' });
      continue;
    }
    const rawUrl = (r['Video URL'] || '').trim();
    const target_url = normalizeUrl(rawUrl);
    if (!target_url) {
      transformed.push({ rowNum, title, skip: `invalid/missing video URL: "${rawUrl.slice(0, 60)}"` });
      continue;
    }
    const description = (r['Brief Description'] || '').replace(/\s+$/, '');
    const dateRaw = (r['Date uploaded'] || '').trim();
    const release_date = parseDate(dateRaw);
    if (dateRaw && !release_date) {
      transformed.push({ rowNum, title, skip: `unparseable date: "${dateRaw}"` });
      continue;
    }
    // is_public from "Member Only": "No" → public, "Yes" → member-only.
    const memberOnly = (r['Member Only'] || '').trim().toLowerCase();
    const is_public = memberOnly !== 'yes';

    const subs = new Set();
    const rtVal = (r['Resource Type'] || '').trim();
    if (rtVal) subs.add(rtVal);
    for (const h of focusAreaHeaders) {
      if ((r[h] || '').trim().toLowerCase() === 'x') {
        subs.add(focusAreaSubByHeader[h]);
      }
    }

    const videoId = extractYouTubeId(target_url);
    const normTitle = title.toLowerCase();

    // Within-file de-dup: collapse by YouTube id, fallback normalized title.
    const dupKeyId = videoId ? `id:${videoId}` : null;
    if (dupKeyId && seenByVideoId.has(dupKeyId)) {
      transformed.push({ rowNum, title, skip: `within-file duplicate (video id ${videoId})` });
      continue;
    }
    if (!videoId && seenByTitle.has(normTitle)) {
      transformed.push({ rowNum, title, skip: `within-file duplicate (title)` });
      continue;
    }

    const entry = {
      rowNum,
      title,
      target_url,
      description,
      release_date,
      is_public,
      subcategories: [...subs],
      videoId,
    };
    transformed.push(entry);
    if (dupKeyId) seenByVideoId.set(dupKeyId, entry);
    seenByTitle.set(normTitle, entry);
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

  // Skip breakdown.
  const skipReasons = {};
  for (const s of skipped) {
    const key = s.skip.startsWith('within-file duplicate')
      ? 'within-file duplicate'
      : s.skip.startsWith('unparseable date')
        ? 'unparseable date'
        : s.skip.startsWith('invalid/missing video URL')
          ? 'invalid/missing video URL'
          : s.skip;
    skipReasons[key] = (skipReasons[key] || 0) + 1;
  }

  console.log(`\nPlan: ${toInsert} insert, ${toUpdate} update, ${skipped.length} skipped (of ${rows.length} rows).`);
  console.log('Skip breakdown:', skipReasons);
  for (const s of skipped) {
    if (!s.skip.startsWith('empty title')) {
      console.log(`  skip row ${s.rowNum} "${s.title || ''}" — ${s.skip}`);
    }
  }

  // Show samples: one member-only, one public, plus first row.
  console.log('\nSample transformed rows:');
  const samplePublic = plans.find((p) => p.is_public);
  const sampleMemberOnly = plans.find((p) => !p.is_public);
  const samples = [plans[0], samplePublic, sampleMemberOnly].filter(
    (p, i, arr) => p && arr.indexOf(p) === i,
  ).slice(0, 3);
  for (const p of samples) {
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

  // Run async ops with bounded concurrency.
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
