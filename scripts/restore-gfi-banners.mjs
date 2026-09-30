/**
 * Restore 17 deleted GFI page banners from backup.
 *
 * Usage:
 *   node scripts/restore-gfi-banners.mjs [--dry-run]
 *
 * Reads the recovered JSON from the attached_assets backup file, validates
 * each row belongs to the GFI tenant, and upserts all 17 rows into the
 * live page_banner table using DEST_SUPABASE_URL / DEST_SUPABASE_KEY.
 *
 * Idempotent: uses onConflict:'id', ignoreDuplicates:true so re-running
 * never overwrites rows that may have been edited after restoration.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const GFI_TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const BACKUP_FILE = resolve(
  __dirname,
  '../attached_assets/Pasted--id-ff2e1c09-86de-4f84-9a66-332e6aabe51c-name-Team-enga_1782821547244.txt'
);

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// ── 1. Load backup ──────────────────────────────────────────────────────────
const raw = readFileSync(BACKUP_FILE, 'utf8');
const banners = JSON.parse(raw);
console.log(`Loaded ${banners.length} banners from backup file`);

if (banners.length !== 17) {
  console.error(`ERROR: Expected 17 banners, got ${banners.length}. Aborting.`);
  process.exit(1);
}

// ── 2. Validate tenant scope ─────────────────────────────────────────────────
const wrongTenant = banners.filter((b) => b.tenant_id !== GFI_TENANT_ID);
if (wrongTenant.length > 0) {
  console.error('ERROR: The following rows have an unexpected tenant_id:');
  wrongTenant.forEach((b) => console.error(`  id=${b.id}  tenant_id=${b.tenant_id}`));
  process.exit(1);
}
console.log(`All ${banners.length} rows have tenant_id = ${GFI_TENANT_ID} ✓`);

// ── 3. Prepare rows (cast display_order string → integer) ────────────────────
const rows = banners.map((b) => ({
  ...b,
  display_order: parseInt(b.display_order, 10),
}));

if (DRY_RUN) {
  console.log('\nDRY RUN — no changes written to the database.');
  rows.forEach((r) =>
    console.log(`  ${r.name} (${r.id})  active=${r.is_active}  order=${r.display_order}`)
  );
  process.exit(0);
}

// ── 4. Upsert ────────────────────────────────────────────────────────────────
console.log('\nUpserting rows into page_banner (ignoreDuplicates=true)…');
const { error: upsertError } = await supabase
  .from('page_banner')
  .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

if (upsertError) {
  console.error('ERROR during upsert:', JSON.stringify(upsertError, null, 2));
  process.exit(1);
}
console.log('Upsert succeeded.');

// ── 5. Verify ────────────────────────────────────────────────────────────────
const { data: restored, error: fetchError } = await supabase
  .from('page_banner')
  .select('id, name, is_active, display_order, associated_pages, hero_content')
  .eq('tenant_id', GFI_TENANT_ID)
  .order('name');

if (fetchError) {
  console.error('ERROR during verification query:', fetchError);
  process.exit(1);
}

console.log(`\nVerification — rows in page_banner for GFI tenant: ${restored.length}`);
if (restored.length !== 17) {
  console.error(`ERROR: Expected 17 rows after upsert but found ${restored.length}.`);
  process.exit(1);
}

restored.forEach((r) =>
  console.log(`  ${r.name.padEnd(25)} id=${r.id}  active=${r.is_active}  order=${r.display_order}`)
);

// Spot-check two key banners
const teamEngagement = restored.find((r) => r.id === 'ff2e1c09-86de-4f84-9a66-332e6aabe51c');
const uniDirectory = restored.find((r) => r.id === 'a064477b-60bf-478f-b3aa-80f437e6cac6');

console.log('\nSpot-check — Team engagement:');
console.log('  heading   :', teamEngagement?.hero_content?.heading);
console.log('  subheading:', teamEngagement?.hero_content?.subheading);

console.log('\nSpot-check — University Directory:');
console.log('  heading   :', uniDirectory?.hero_content?.heading);
console.log('  subheading:', uniDirectory?.hero_content?.subheading);

console.log('\nAll 17 GFI page banners restored successfully.');
