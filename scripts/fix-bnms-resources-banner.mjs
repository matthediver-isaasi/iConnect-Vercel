// Fix the BNMS "Resources banner" page_banner row so it shows on /Resources
// instead of Events pages.
//
// The row's associated_pages is ["portal_events", "PublicResources"]; it should
// be ["portal_resources", "PublicResources"]. This script replaces
// "portal_events" with "portal_resources" while keeping "PublicResources".
//
// Usage:
//   node scripts/fix-bnms-resources-banner.mjs           # dry run (default)
//   node scripts/fix-bnms-resources-banner.mjs --apply   # apply the change
//
// Idempotent: re-running after apply reports "already correct" and makes no changes.
// Hard-pinned to the BNMS tenant and the specific banner row.

import { createClient } from '@supabase/supabase-js';

const BNMS_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const BANNER_ID = '59e7b0b9-5ee2-4f0d-9de9-482bf1ef9136';

const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY env vars.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);

  const { data: banner, error } = await supabase
    .from('page_banner')
    .select('id, tenant_id, name, associated_pages')
    .eq('id', BANNER_ID)
    .single();

  if (error) {
    console.error('Failed to fetch banner:', error.message);
    process.exit(1);
  }

  if (banner.tenant_id !== BNMS_TENANT_ID) {
    console.error(`Banner tenant_id ${banner.tenant_id} does not match BNMS tenant ${BNMS_TENANT_ID}; aborting.`);
    process.exit(1);
  }

  const current = Array.isArray(banner.associated_pages) ? banner.associated_pages : [];
  console.log(`Banner: "${banner.name}" (${banner.id})`);
  console.log('Current associated_pages:', JSON.stringify(current));

  const next = current.filter((p) => p !== 'portal_events');
  if (!next.includes('portal_resources')) {
    next.push('portal_resources');
  }

  const changed =
    next.length !== current.length || next.some((p, i) => p !== current[i]);

  if (!changed) {
    console.log('Already correct — no changes needed.');
    return;
  }

  console.log('New associated_pages:    ', JSON.stringify(next));

  if (!APPLY) {
    console.log('Dry run — no changes written.');
    return;
  }

  const { error: updateError } = await supabase
    .from('page_banner')
    .update({ associated_pages: next })
    .eq('id', BANNER_ID)
    .eq('tenant_id', BNMS_TENANT_ID);

  if (updateError) {
    console.error('Update failed:', updateError.message);
    process.exit(1);
  }

  const { data: after } = await supabase
    .from('page_banner')
    .select('associated_pages')
    .eq('id', BANNER_ID)
    .single();

  console.log('Updated. associated_pages now:', JSON.stringify(after?.associated_pages));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
