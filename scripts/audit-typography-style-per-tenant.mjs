/**
 * Audit: typography_style row count + max(updated_at) per tenant_id.
 *
 * This is a deliberately cross-tenant READ-ONLY audit, intended to be run
 * before and after tenant-scoped seed/migration work on `typography_style`
 * (e.g. task #939's `scripts/seed-bnms-typography.mjs`) to verify
 * tenant isolation: every tenant_id other than the one being seeded MUST
 * show an identical `count` and `max(updated_at)` between baseline and
 * post-seed runs.
 *
 * It performs no writes. Service-role credentials are required only to
 * read the aggregate; no row content is read or printed beyond
 * (tenant_id, updated_at) needed to compute the aggregate.
 *
 * Usage:
 *   node scripts/audit-typography-style-per-tenant.mjs               # human-readable
 *   node scripts/audit-typography-style-per-tenant.mjs --json        # JSON for diffing
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}

const asJson = process.argv.includes('--json');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const { data, error } = await supabase
  .from('typography_style')
  .select('tenant_id, updated_at');

if (error) {
  console.error(error);
  process.exit(1);
}

const agg = {};
for (const row of data) {
  const t = row.tenant_id || 'NULL';
  if (!agg[t]) agg[t] = { count: 0, max_updated_at: null };
  agg[t].count++;
  if (!agg[t].max_updated_at || (row.updated_at && row.updated_at > agg[t].max_updated_at)) {
    agg[t].max_updated_at = row.updated_at;
  }
}

if (asJson) {
  console.log(JSON.stringify(agg, null, 2));
} else {
  console.log('typography_style per-tenant audit:');
  for (const [t, v] of Object.entries(agg).sort()) {
    console.log(`  ${t}: count=${v.count} max_updated_at=${v.max_updated_at}`);
  }
}
