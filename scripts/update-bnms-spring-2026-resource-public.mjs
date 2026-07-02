/**
 * Task #2174 — One-off update: set `is_public = true` on the BNMS
 * "Spring Meeting 2026" resources that Task #2143 imported (and #2146 flipped
 * to resource_type='download').
 *
 * These 308 resources were imported as member-only (is_public=false, because
 * their "Member Only" spreadsheet column was "Yes"), but they now need to be
 * publicly visible on the tenant's public Resources page.
 *
 * Target rows: `resource` rows for tenant BNMS
 * (ff2df806-b321-4254-b651-3af11fccf1db) whose `subcategories` array contains
 * the Collection tag "Spring Meeting 2026" AND whose current `is_public`
 * is not already true. Expected match count: up to 308.
 *
 * Optional `--xlsx=` fallback: if the subcategory match count is unexpected,
 * pass the spreadsheet path to instead match on its `target_url` set (still
 * scoped to tenant + is_public not already true).
 *
 * Usage:
 *   node scripts/update-bnms-spring-2026-resource-public.mjs --dry-run
 *   node scripts/update-bnms-spring-2026-resource-public.mjs
 *   node scripts/update-bnms-spring-2026-resource-public.mjs --tenant=<uuid>
 *   node scripts/update-bnms-spring-2026-resource-public.mjs --limit=5
 *   node scripts/update-bnms-spring-2026-resource-public.mjs --xlsx=<path>
 *
 * Idempotent: only rows still at is_public!=true are updated; re-runs match
 * fewer/zero rows once flipped to true.
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
const DRY_RUN = !!args['dry-run'];
const LIMIT = args.limit ? Number(args.limit) : null;
const XLSX_PATH = args.xlsx || null;
const COLLECTION_TAG = 'Spring Meeting 2026';
const EXPECTED = 308;

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

// Page through all resources for the tenant (PostgREST caps at 1000 rows and
// this tenant has well over 1000 resources).
async function loadAllResources() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await supabase
      .from('resource')
      .select('id, title, target_url, is_public, subcategories')
      .eq('tenant_id', TENANT_ID)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(page || []));
    if (!page || page.length < PAGE) break;
  }
  return all;
}

// Load the spreadsheet's target_url set for the optional fallback matcher.
function loadXlsxTargetUrls(path) {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets['Resources'] || wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const URL_COL = 1; // column B "Resource URL" (matches the import script)
  const urls = new Set();
  for (const r of matrix.slice(1)) {
    const u = String(r[URL_COL] || '').trim();
    if (u) urls.add(u);
  }
  return urls;
}

async function main() {
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Matching: is_public != true -> true`);

  const resources = await loadAllResources();
  console.log(`Loaded ${resources.length} resources for tenant.`);

  let matched;
  if (XLSX_PATH) {
    const urls = loadXlsxTargetUrls(XLSX_PATH);
    console.log(`XLSX fallback: matching on ${urls.size} target_url(s) from ${XLSX_PATH}`);
    matched = resources.filter(
      (r) => r.is_public !== true && r.target_url && urls.has(r.target_url),
    );
  } else {
    matched = resources.filter(
      (r) =>
        r.is_public !== true &&
        Array.isArray(r.subcategories) &&
        r.subcategories.includes(COLLECTION_TAG),
    );
  }

  console.log(`\nMatched ${matched.length} rows (expected up to ${EXPECTED}).`);
  if (matched.length > EXPECTED) {
    console.log(
      `  NOTE: match count exceeds expected ${EXPECTED}. Review before writing` +
        (XLSX_PATH ? '.' : ', or re-run with --xlsx=<path> to match on target_url set.'),
    );
  }

  console.log('\nSample matched rows:');
  for (const r of matched.slice(0, 3)) {
    console.log(
      JSON.stringify(
        {
          id: r.id,
          title: r.title,
          target_url: r.target_url,
          current_is_public: r.is_public,
          new_is_public: true,
        },
        null,
        2,
      ),
    );
  }

  const slice = LIMIT ? matched.slice(0, LIMIT) : matched;

  if (DRY_RUN) {
    console.log(`\nDry run — no writes performed. Would update ${slice.length} rows.`);
    return;
  }

  const totals = { updated: 0, errors: 0 };
  const CONCURRENCY = 20;
  let idx = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, slice.length) }, async () => {
    while (idx < slice.length) {
      const r = slice[idx++];
      const { error } = await supabase
        .from('resource')
        .update({ is_public: true })
        .eq('id', r.id);
      if (error) {
        totals.errors++;
        console.error(`  update failed for ${r.id} "${r.title}": ${error.message}`);
      } else {
        totals.updated++;
      }
    }
  });
  await Promise.all(runners);

  console.log('\n=== Summary ===');
  console.log(`Matched:  ${matched.length}`);
  console.log(`Updated:  ${totals.updated}`);
  console.log(`Skipped:  ${matched.length - slice.length}`);
  console.log(`Errors:   ${totals.errors}`);
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
