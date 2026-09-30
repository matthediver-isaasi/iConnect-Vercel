/**
 * One-off data fix: Justice Rising "Countries of operation" value.
 *
 * The GSF org Justice Rising has its "Countries of operation" preference
 * value stored as the legacy label "Congo, Dem. Rep.", which
 * resolveCountryToIso2 cannot resolve, so the dashboard Region widget
 * buckets the org as "Unknown". The canonical label in shared/countries.js
 * is "Congo (Democratic Republic)" (ISO-2 CD, region Africa).
 *
 * This script is hard-pinned to:
 *   - GSF tenant       21296ad6-1350-483a-a90c-1b06ece70501
 *   - Justice Rising   c616f149-e82c-4127-9582-10d22c9f44c9
 *   - field            b799fad7-db74-443c-b461-93d30b7f4bba
 *
 * It replaces ONLY the "Congo, Dem. Rep." entry inside the stored value,
 * preserving the stored shape exactly (JSON-stringified array vs plain
 * string). Idempotent: re-running after the fix is a no-op.
 *
 * Usage:
 *   node scripts/fix-justice-rising-country.mjs           # dry-run (default)
 *   node scripts/fix-justice-rising-country.mjs --apply   # perform the update
 */
import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const ORG_ID = 'c616f149-e82c-4127-9582-10d22c9f44c9';
const FIELD_ID = 'b799fad7-db74-443c-b461-93d30b7f4bba';
const LEGACY_LABEL = 'Congo, Dem. Rep.';
const CANONICAL_LABEL = 'Congo (Democratic Republic)';

const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY env vars.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

function transformValue(stored) {
  // Preserve the stored shape exactly.
  if (typeof stored !== 'string') return { changed: false, next: stored };

  // Shape 1: JSON-stringified array (the shape observed in prod).
  const trimmed = stored.trim();
  if (trimmed.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(stored);
    } catch {
      return { changed: false, next: stored };
    }
    if (!Array.isArray(arr)) return { changed: false, next: stored };
    let changed = false;
    const nextArr = arr.map((entry) => {
      if (typeof entry === 'string' && entry.trim() === LEGACY_LABEL) {
        changed = true;
        return CANONICAL_LABEL;
      }
      return entry;
    });
    return { changed, next: changed ? JSON.stringify(nextArr) : stored };
  }

  // Shape 2: plain string.
  if (trimmed === LEGACY_LABEL) {
    return { changed: true, next: CANONICAL_LABEL };
  }
  return { changed: false, next: stored };
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN (pass --apply to write)'}`);

  // Confirm the org belongs to the pinned GSF tenant before touching anything.
  const { data: org, error: orgErr } = await supabase
    .from('organization')
    .select('id, name, tenant_id')
    .eq('id', ORG_ID)
    .single();
  if (orgErr || !org) {
    console.error('Could not load organization:', orgErr);
    process.exit(1);
  }
  if (org.tenant_id !== TENANT_ID) {
    console.error(
      `Org tenant mismatch: expected ${TENANT_ID}, got ${org.tenant_id}. Aborting.`,
    );
    process.exit(1);
  }
  console.log(`Org: ${org.name} (${org.id}) tenant=${org.tenant_id}`);

  const { data: rows, error: rowErr } = await supabase
    .from('organization_preference_value')
    .select('id, value, updated_at')
    .eq('organization_id', ORG_ID)
    .eq('field_id', FIELD_ID);
  if (rowErr) {
    console.error('Could not load preference value row:', rowErr);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.error('No organization_preference_value row found. Nothing to do.');
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`Expected exactly 1 row, found ${rows.length}. Aborting.`);
    process.exit(1);
  }

  const row = rows[0];
  console.log(`Row ${row.id}`);
  console.log(`  before: ${JSON.stringify(row.value)}`);

  const { changed, next } = transformValue(row.value);
  if (!changed) {
    console.log('  No legacy label found — value already fixed. No-op.');
    return;
  }
  console.log(`  after:  ${JSON.stringify(next)}`);

  if (!APPLY) {
    console.log('Dry-run complete. Re-run with --apply to write the change.');
    return;
  }

  const { error: updErr } = await supabase
    .from('organization_preference_value')
    .update({ value: next, updated_at: new Date().toISOString() })
    .eq('id', row.id);
  if (updErr) {
    console.error('Update failed:', updErr);
    process.exit(1);
  }

  // Read back to confirm.
  const { data: after, error: afterErr } = await supabase
    .from('organization_preference_value')
    .select('id, value, updated_at')
    .eq('id', row.id)
    .single();
  if (afterErr) {
    console.error('Read-back failed:', afterErr);
    process.exit(1);
  }
  console.log(`Applied. Stored value now: ${JSON.stringify(after.value)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
