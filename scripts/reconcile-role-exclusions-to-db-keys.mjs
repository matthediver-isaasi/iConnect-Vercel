// Task #3349: one-off, idempotent reconciliation of role.excluded_features
// entries onto the tenant's current role_access_item keys.
//
// For each role, any excluded_features entry whose legacy alias
// (LEGACY_TO_NEW_MAPPING) resolves to a key that exists in role_access_item
// is rewritten to that DB key, so stored data converges on the DB keys going
// forward. Entries with no alias mapping (or whose alias is not present in
// the DB tree) are left untouched. Duplicates after rewriting are removed
// (order preserved). Enforcement already unions old/new matching, so this is
// a data-hygiene convergence, not a behavior prerequisite.
//
// Targets the PRODUCTION (DEST) database only, via DEST_SUPABASE_URL/KEY.
//
// Usage:
//   npx tsx scripts/reconcile-role-exclusions-to-db-keys.mjs           # dry run
//   npx tsx scripts/reconcile-role-exclusions-to-db-keys.mjs --apply   # write
import { createClient } from '@supabase/supabase-js';
import { LEGACY_TO_NEW_MAPPING } from '../client/src/lib/roleAccessMap.ts';

const APPLY = process.argv.includes('--apply');

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('DEST_SUPABASE_URL / DEST_SUPABASE_KEY are required (production DEST database).');
  process.exit(1);
}
const db = createClient(url, key);

const { data: items, error: itemsErr } = await db
  .from('role_access_item')
  .select('item_key,is_active');
if (itemsErr) throw itemsErr;
const dbKeys = new Set((items || []).filter((i) => i.is_active !== false).map((i) => i.item_key));
console.log(`role_access_item active keys: ${dbKeys.size}${dbKeys.size === 0 ? ' (empty table — nothing to reconcile)' : ''}`);
if (dbKeys.size === 0) process.exit(0);

// Page-limit safe role fetch (PostgREST caps at 1000; role count is far
// below that, but order+range keeps this deterministic anyway).
const { data: roles, error: rolesErr } = await db
  .from('role')
  .select('id,name,tenant_id,excluded_features')
  .order('id')
  .range(0, 4999);
if (rolesErr) throw rolesErr;

let changed = 0;
for (const role of roles || []) {
  const current = Array.isArray(role.excluded_features) ? role.excluded_features : null;
  if (!current || current.length === 0) continue;

  const seen = new Set();
  const next = [];
  for (const raw of current) {
    // Only rewrite when an alias mapping exists AND the aliased key is a real
    // key in the tenant's DB tree; unknown/custom keys pass through untouched.
    const aliased = LEGACY_TO_NEW_MAPPING[raw];
    const out = aliased && dbKeys.has(aliased) ? aliased : raw;
    if (!seen.has(out)) {
      seen.add(out);
      next.push(out);
    }
  }

  const isChanged = next.length !== current.length || next.some((k, i) => k !== current[i]);
  if (!isChanged) continue;
  changed++;

  const diff = current.filter((k) => !next.includes(k));
  console.log(`role "${role.name}" (${role.id}, tenant ${role.tenant_id}): ${current.length} -> ${next.length} entries; rewritten/deduped: ${JSON.stringify(diff)}`);

  if (APPLY) {
    const { error: updErr } = await db
      .from('role')
      .update({ excluded_features: next })
      .eq('id', role.id);
    if (updErr) throw updErr;
  }
}

console.log(`${APPLY ? 'Updated' : '[dry run] Would update'} ${changed} of ${roles?.length ?? 0} roles.`);
