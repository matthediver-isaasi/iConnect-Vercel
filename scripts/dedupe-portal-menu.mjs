#!/usr/bin/env node
/**
 * Remove duplicate `portal_menu` rows within a tenant (task #2106).
 *
 * Background: the GFI (`Graduate Futures Institute`) tenant ended up with two
 * `portal_menu` rows for the "Member Group Assignment Report" page
 * (`url = MemberGroupAssignmentReport`). Both are `is_active` and now map to
 * the same feature (exclusions were fixed separately), so the item renders
 * twice in the admin nav. One row is a stale/legacy leftover:
 *   - it carries the legacy feature_id `page_admin_MemberGroupAssignmentReport`
 *     (which now aliases to `membership.member-group-assignment-report`), and
 *   - its `parent_id` points at a base44-era id that no longer exists as a
 *     portal_menu row (orphaned parent).
 * The canonical row uses feature_id `membership.member-group-assignment-report`
 * and sits under the real "Member Groups" parent alongside its siblings.
 *
 * This script is general and safe to run across tenants. A "duplicate group"
 * is a set of >1 `portal_menu` rows in the same tenant that share the same
 * (section, url) pair. For each group it deterministically picks ONE keeper
 * and deletes the rest. Keeper preference (in order):
 *   1. Row whose `parent_id` is null OR references an existing portal_menu row
 *      in the same tenant (i.e. NOT an orphaned parent).
 *   2. Row whose `feature_id` is NOT a legacy `page_admin_*` / `page_*` form.
 *   3. Active over inactive.
 *   4. Stable tiebreak by `id` for determinism.
 * Rows that have children are never deleted (their sub-items would be orphaned).
 *
 * Defaults to DRY-RUN. Pass `--apply` to actually delete.
 *
 * Usage:
 *   node scripts/dedupe-portal-menu.mjs                      # dry-run, GFI tenant
 *   node scripts/dedupe-portal-menu.mjs --apply              # apply, GFI tenant
 *   node scripts/dedupe-portal-menu.mjs --tenant=<uuid|slug> [--apply]
 *   node scripts/dedupe-portal-menu.mjs --all-tenants        # dry-run, every tenant
 *   node scripts/dedupe-portal-menu.mjs --all-tenants --apply
 *
 * Scope a run to a single page's duplicates with `--url=<url>` (e.g.
 * `--url=MemberGroupAssignmentReport`) so unrelated duplicate groups are left
 * untouched.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.DEST_SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[dedupe] DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL_TENANTS = args.includes('--all-tenants');
const tenantArg = (args.find(a => a.startsWith('--tenant=')) || '').split('=')[1];
const urlFilter = (args.find(a => a.startsWith('--url=')) || '').split('=')[1];

// Default target when neither --tenant nor --all-tenants is given: GFI.
const DEFAULT_TENANT = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

function isLegacyFeatureId(fid) {
  if (!fid) return false;
  return fid.startsWith('page_admin_') || fid.startsWith('page_');
}

// Lower score = better keeper.
function keeperScore(row, validIds) {
  let score = 0;
  const parentOrphaned = row.parent_id && !validIds.has(row.parent_id);
  if (parentOrphaned) score += 1000;
  if (isLegacyFeatureId(row.feature_id)) score += 100;
  if (row.is_active === false) score += 10;
  return score;
}

async function resolveTenantIds() {
  if (ALL_TENANTS) {
    const { data, error } = await sb.from('tenant').select('id, slug, name');
    if (error) throw error;
    return data;
  }
  const wanted = tenantArg || DEFAULT_TENANT;
  // Accept either a uuid id or a slug.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted);
  const { data, error } = await sb
    .from('tenant')
    .select('id, slug, name')
    .eq(isUuid ? 'id' : 'slug', wanted);
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`Tenant not found for ${isUuid ? 'id' : 'slug'}="${wanted}"`);
  }
  return data;
}

async function dedupeTenant(tenant) {
  const { data: rows, error } = await sb
    .from('portal_menu')
    .select('*')
    .eq('tenant_id', tenant.id);
  if (error) throw error;

  const validIds = new Set(rows.map(r => r.id));
  const childrenCount = new Map();
  for (const r of rows) {
    if (r.parent_id) childrenCount.set(r.parent_id, (childrenCount.get(r.parent_id) || 0) + 1);
  }

  // Group by (section, url).
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.section || ''}::${r.url || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const toDelete = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // Only treat rows with a real url/page as dedupe candidates.
    if (!group[0].url) continue;
    // Optional single-page scoping.
    if (urlFilter && group[0].url !== urlFilter) continue;

    const sorted = [...group].sort((a, b) => {
      const s = keeperScore(a, validIds) - keeperScore(b, validIds);
      if (s !== 0) return s;
      return String(a.id).localeCompare(String(b.id));
    });
    const keeper = sorted[0];
    const losers = sorted.slice(1);

    console.log(`\n[${tenant.slug}] Duplicate group "${key}" (${group.length} rows)`);
    console.log(`  KEEP   ${keeper.id}  feature_id=${keeper.feature_id}  parent=${keeper.parent_id}  order=${keeper.display_order}`);
    for (const l of losers) {
      const hasKids = (childrenCount.get(l.id) || 0) > 0;
      if (hasKids) {
        console.log(`  SKIP   ${l.id}  feature_id=${l.feature_id}  parent=${l.parent_id}  (has ${childrenCount.get(l.id)} child rows — not deleting)`);
        continue;
      }
      console.log(`  DELETE ${l.id}  feature_id=${l.feature_id}  parent=${l.parent_id}  order=${l.display_order}`);
      toDelete.push(l.id);
    }
  }

  if (toDelete.length === 0) {
    console.log(`\n[${tenant.slug}] No duplicates to remove.`);
    return 0;
  }

  if (!APPLY) {
    console.log(`\n[${tenant.slug}] DRY-RUN: would delete ${toDelete.length} row(s). Re-run with --apply to execute.`);
    return 0;
  }

  const { error: delErr } = await sb.from('portal_menu').delete().in('id', toDelete);
  if (delErr) throw delErr;
  console.log(`\n[${tenant.slug}] Deleted ${toDelete.length} duplicate portal_menu row(s).`);
  return toDelete.length;
}

async function run() {
  console.log(`[dedupe] Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const tenants = await resolveTenantIds();
  console.log(`[dedupe] Tenants to scan: ${tenants.map(t => t.slug).join(', ')}`);

  let total = 0;
  for (const t of tenants) {
    total += await dedupeTenant(t);
  }
  console.log(`\n[dedupe] Complete. ${APPLY ? `Deleted ${total} row(s) total.` : 'No changes (dry-run).'}`);
}

run().catch(err => {
  console.error('[dedupe] Failed:', err);
  process.exit(1);
});
