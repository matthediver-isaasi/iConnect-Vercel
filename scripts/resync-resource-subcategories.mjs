/**
 * resync-resource-subcategories.mjs
 *
 * One-time resync tool for resources whose subcategories array contains stale
 * subcategory names (i.e. names that no longer exist in any resource_category's
 * canonical subcategories list) — the result of past renames that used the now-
 * fixed bug that updated a non-existent singular `subcategory` column instead of
 * the plural `subcategories` array.
 *
 * When applying a rename mapping, this also repairs members' saved filter
 * preferences in `member_resource_category` (stored as `subcategory_name`
 * strings), which otherwise silently stop matching after a rename.
 *
 * Usage:
 *   node scripts/resync-resource-subcategories.mjs [options]
 *
 * Options:
 *   --tenant=<uuid>          Scope to a single tenant (recommended for production runs)
 *   --map=<old>:<new>        One or more explicit rename mappings to apply.
 *                            Can be repeated: --map="Old Name:New Name" --map="Foo:Bar"
 *   --fix-groups             Also repair stale member_group.resource_subcategories
 *                            entries (group-scoped resource links left pointing at an
 *                            old name after a rename step partially failed).
 *   --apply                  Write changes to the database. Without this flag the
 *                            script is a dry run and prints what it would change.
 *   --help                   Print this help text.
 *
 * Workflow:
 *   1. Run without --map to see a diagnosis report (stale names + candidates).
 *   2. Confirm the correct old→new mappings from the report.
 *   3. Re-run with --map flags (and optionally --tenant) to preview the changes.
 *   4. Add --apply to write.
 *
 * Example:
 *   # Diagnose (all tenants)
 *   node scripts/resync-resource-subcategories.mjs
 *
 *   # Diagnose single tenant
 *   node scripts/resync-resource-subcategories.mjs --tenant=abc-123
 *
 *   # Dry-run a rename mapping
 *   node scripts/resync-resource-subcategories.mjs --tenant=abc-123 --map="Old Sub:New Sub"
 *
 *   # Apply
 *   node scripts/resync-resource-subcategories.mjs --tenant=abc-123 --map="Old Sub:New Sub" --apply
 */

import { createClient } from '@supabase/supabase-js';

const DEST_SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const DEST_SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

if (!DEST_SUPABASE_URL || !DEST_SUPABASE_KEY) {
  console.error('ERROR: DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(DEST_SUPABASE_URL, DEST_SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ── Arg parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(`
resync-resource-subcategories.mjs

Identifies and repairs resources whose subcategories array contains stale names
left behind by a subcategory rename bug (now fixed). Dry-run by default.

Options:
  --tenant=<uuid>    Scope to a single tenant
  --map=<old>:<new>  Old→new name mapping (repeatable)
  --fix-groups       Also repair stale member_group.resource_subcategories entries
  --apply            Write changes (without this flag: dry run only)
  --help             Show this help

See script header for full workflow.
`);
  process.exit(0);
}

const applyChanges = args.includes('--apply');
const fixGroups = args.includes('--fix-groups');

const tenantArg = args.find(a => a.startsWith('--tenant='));
const tenantFilter = tenantArg ? tenantArg.split('=').slice(1).join('=') : null;

const mapArgs = args.filter(a => a.startsWith('--map='));
const renameMap = new Map();
for (const arg of mapArgs) {
  const raw = arg.split('=').slice(1).join('=');
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) {
    console.error(`ERROR: --map value must be "old:new", got: ${arg}`);
    process.exit(1);
  }
  const oldName = raw.slice(0, colonIdx).trim();
  const newName = raw.slice(colonIdx + 1).trim();
  if (!oldName || !newName) {
    console.error(`ERROR: --map old and new names must both be non-empty, got: ${arg}`);
    process.exit(1);
  }
  renameMap.set(oldName, newName);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fetchAllPages(query) {
  const PAGE = 1000;
  let allRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    allRows = allRows.concat(data || []);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return allRows;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(72));
  console.log('  Resource Subcategory Resync Tool');
  console.log('='.repeat(72));
  console.log(`  Mode   : ${applyChanges ? 'APPLY (writing to database)' : 'DRY RUN (no writes)'}`);
  console.log(`  Tenant : ${tenantFilter || '(all tenants)'}`);
  if (renameMap.size > 0) {
    console.log('  Mappings:');
    for (const [o, n] of renameMap) {
      console.log(`    "${o}" → "${n}"`);
    }
  }
  console.log('='.repeat(72));
  console.log();

  // 1. Fetch canonical subcategory names per tenant from resource_category
  // Fetch categories including applies_to_content_types so the client-side filter works correctly
  let catQueryBase = supabase
    .from('resource_category')
    .select('id, name, tenant_id, subcategories, applies_to_content_types');
  if (tenantFilter) catQueryBase = catQueryBase.eq('tenant_id', tenantFilter);

  const allCategories = await fetchAllPages(catQueryBase);

  // Filter to categories tagged for the Resources content type.
  // applies_to_content_types is a TEXT[] column; if not set on a row, include it as a
  // safety fallback so we never silently exclude categories from an older schema.
  const resourceCategories = allCategories.filter(c =>
    !Array.isArray(c.applies_to_content_types) || c.applies_to_content_types.includes('Resources')
  );

  // Build set of canonical subcategory names per tenant
  // tenantCanonical: Map<tenantId, Set<subName>>
  const tenantCanonical = new Map();
  for (const cat of resourceCategories) {
    if (!tenantCanonical.has(cat.tenant_id)) {
      tenantCanonical.set(cat.tenant_id, new Set());
    }
    const subs = Array.isArray(cat.subcategories) ? cat.subcategories : [];
    for (const s of subs) {
      tenantCanonical.get(cat.tenant_id).add(s);
    }
  }

  // 2. Fetch resources
  let resQuery = supabase
    .from('resource')
    .select('id, title, tenant_id, subcategories');
  if (tenantFilter) resQuery = resQuery.eq('tenant_id', tenantFilter);

  const allResources = await fetchAllPages(resQuery);

  // 3. Identify stale subcategory names (present on resources, absent from canonical sets)
  // Also count canonical names that have zero resources (candidate new names)
  // tenantStale: Map<tenantId, Map<staleName, resourceIds[]>>
  // tenantCanonicalEmpty: Map<tenantId, Set<canonicalName>>
  const tenantStale = new Map();
  const tenantResourceCounts = new Map(); // Map<tenantId, Map<canonicalName, count>>

  for (const res of allResources) {
    const tid = res.tenant_id;
    const canonical = tenantCanonical.get(tid) || new Set();
    const subs = Array.isArray(res.subcategories) ? res.subcategories : [];

    if (!tenantResourceCounts.has(tid)) tenantResourceCounts.set(tid, new Map());
    const counts = tenantResourceCounts.get(tid);

    for (const sub of subs) {
      if (canonical.has(sub)) {
        counts.set(sub, (counts.get(sub) || 0) + 1);
      } else {
        if (!tenantStale.has(tid)) tenantStale.set(tid, new Map());
        const staleMap = tenantStale.get(tid);
        if (!staleMap.has(sub)) staleMap.set(sub, []);
        staleMap.get(sub).push(res.id);
      }
    }
  }

  // Canonical names with zero resources
  const tenantCanonicalEmpty = new Map();
  for (const [tid, canonical] of tenantCanonical) {
    const counts = tenantResourceCounts.get(tid) || new Map();
    const empty = new Set();
    for (const name of canonical) {
      if (!counts.has(name) || counts.get(name) === 0) {
        empty.add(name);
      }
    }
    if (empty.size > 0) tenantCanonicalEmpty.set(tid, empty);
  }

  // ── Diagnosis report ──────────────────────────────────────────────────────

  const allTenantIds = new Set([
    ...tenantStale.keys(),
    ...tenantCanonicalEmpty.keys(),
  ]);

  if (allTenantIds.size === 0) {
    console.log('No mismatches found — all resource subcategory names match their canonical categories.');
    if (renameMap.size > 0) {
      console.log('\nNote: The --map mappings you supplied would have no effect (no stale names matched).');
    }
    return;
  }

  console.log(`Found mismatches in ${allTenantIds.size} tenant(s):\n`);

  for (const tid of allTenantIds) {
    console.log(`  Tenant: ${tid}`);

    const staleMap = tenantStale.get(tid);
    if (staleMap && staleMap.size > 0) {
      console.log(`    Stale subcategory names on resources (not in any category):`);
      for (const [name, ids] of staleMap) {
        console.log(`      "${name}" — ${ids.length} resource(s): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` +${ids.length - 5} more` : ''}`);
      }
    }

    const emptySet = tenantCanonicalEmpty.get(tid);
    if (emptySet && emptySet.size > 0) {
      console.log(`    Canonical subcategory names with zero resources (likely rename targets):`);
      for (const name of emptySet) {
        console.log(`      "${name}"`);
      }
    }

    console.log();
  }

  // ── Apply mappings ────────────────────────────────────────────────────────

  if (renameMap.size === 0) {
    console.log('No --map flags supplied. Review the diagnosis above, determine the correct');
    console.log('old→new mappings, then re-run with --map="Old Name:New Name" (repeatable).');
    console.log('Add --apply to write changes.');
    console.log('Add --fix-groups to also repair member_group.resource_subcategories.\n');
    return;
  }

  // Validate: all old names in the map must appear as stale names in at least one tenant
  for (const [oldName] of renameMap) {
    let found = false;
    for (const staleMap of tenantStale.values()) {
      if (staleMap.has(oldName)) { found = true; break; }
    }
    if (!found) {
      console.warn(`WARNING: --map old name "${oldName}" is not found as a stale subcategory on any resource. It will have no effect.`);
    }
  }

  // Map canonical subcategory names to their owning category id per tenant, so we can
  // scope member_resource_category repairs (that table keys on resource_category_id).
  // tenantSubToCategory: Map<tenantId, Map<subName, categoryId>>
  const tenantSubToCategory = new Map();
  for (const cat of resourceCategories) {
    if (!tenantSubToCategory.has(cat.tenant_id)) tenantSubToCategory.set(cat.tenant_id, new Map());
    const subMap = tenantSubToCategory.get(cat.tenant_id);
    const subs = Array.isArray(cat.subcategories) ? cat.subcategories : [];
    for (const s of subs) subMap.set(s, cat.id);
  }

  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalMemberPrefsUpdated = 0;

  for (const [tid, staleMap] of tenantStale) {
    if (tenantFilter && tid !== tenantFilter) continue;

    for (const [oldName, resourceIds] of staleMap) {
      const newName = renameMap.get(oldName);
      if (!newName) {
        console.log(`  [SKIP] tenant=${tid} — no mapping provided for stale name "${oldName}" (${resourceIds.length} resource(s))`);
        totalSkipped += resourceIds.length;
        continue;
      }

      console.log(`  [${applyChanges ? 'APPLY' : 'DRY RUN'}] tenant=${tid}: "${oldName}" → "${newName}" (${resourceIds.length} resource(s))`);

      // Process each affected resource
      for (const resId of resourceIds) {
        const res = allResources.find(r => r.id === resId);
        if (!res) continue;

        const currentSubs = Array.isArray(res.subcategories) ? res.subcategories : [];
        const newSubs = [...new Set(currentSubs.map(s => s === oldName ? newName : s))];

        if (!applyChanges) {
          console.log(`    [DRY RUN] resource ${resId}: ${JSON.stringify(currentSubs)} → ${JSON.stringify(newSubs)}`);
          totalUpdated++;
          continue;
        }

        const { error } = await supabase
          .from('resource')
          .update({ subcategories: newSubs })
          .eq('id', resId)
          .eq('tenant_id', tid);

        if (error) {
          console.error(`    [ERROR] resource ${resId}: ${error.message}`);
        } else {
          console.log(`    [OK] resource ${resId}: ${JSON.stringify(currentSubs)} → ${JSON.stringify(newSubs)}`);
          totalUpdated++;
        }
      }

      // Repair members' saved filter preferences in member_resource_category.
      // The new name must exist as a canonical subcategory to know which category owns it;
      // scope the update to that category id (the table has no tenant_id column).
      const categoryId = tenantSubToCategory.get(tid)?.get(newName);
      if (!categoryId) {
        console.log(`    [WARN] tenant=${tid}: cannot repair member preferences for "${oldName}" — new name "${newName}" is not a canonical subcategory of any category.`);
      } else {
        const { data: memberPrefRows, error: memberPrefFetchError } = await supabase
          .from('member_resource_category')
          .select('id')
          .eq('resource_category_id', categoryId)
          .eq('subcategory_name', oldName);

        if (memberPrefFetchError) {
          console.error(`    [ERROR] member_resource_category fetch (category ${categoryId}): ${memberPrefFetchError.message}`);
        } else {
          const prefCount = memberPrefRows?.length || 0;
          if (prefCount > 0) {
            if (!applyChanges) {
              console.log(`    [DRY RUN] member preferences: ${prefCount} row(s) in category ${categoryId} "${oldName}" → "${newName}"`);
              totalMemberPrefsUpdated += prefCount;
            } else {
              const { error: memberPrefUpdateError } = await supabase
                .from('member_resource_category')
                .update({ subcategory_name: newName })
                .eq('resource_category_id', categoryId)
                .eq('subcategory_name', oldName);

              if (memberPrefUpdateError) {
                console.error(`    [ERROR] member_resource_category update (category ${categoryId}): ${memberPrefUpdateError.message}`);
              } else {
                console.log(`    [OK] member preferences: ${prefCount} row(s) in category ${categoryId} "${oldName}" → "${newName}"`);
                totalMemberPrefsUpdated += prefCount;
              }
            }
          }
        }
      }
    }
  }

  // ── Repair member groups ──────────────────────────────────────────────────

  let totalGroupsUpdated = 0;
  if (fixGroups) {
    console.log();
    console.log('─'.repeat(72));
    console.log('  Repairing member_group.resource_subcategories …');
    console.log('─'.repeat(72));

    let groupQuery = supabase
      .from('member_group')
      .select('id, name, tenant_id, resource_subcategories');
    if (tenantFilter) groupQuery = groupQuery.eq('tenant_id', tenantFilter);

    const allGroups = await fetchAllPages(groupQuery);

    for (const group of allGroups) {
      const linked = Array.isArray(group.resource_subcategories) ? group.resource_subcategories : [];
      if (linked.length === 0) continue;

      const hasStale = linked.some(s => renameMap.has(s));
      if (!hasStale) continue;

      const newLinked = [...new Set(linked.map(s => renameMap.has(s) ? renameMap.get(s) : s))];

      if (!applyChanges) {
        console.log(`  [DRY RUN] group ${group.id} (${group.name || 'unnamed'}): ${JSON.stringify(linked)} → ${JSON.stringify(newLinked)}`);
        totalGroupsUpdated++;
        continue;
      }

      const { error } = await supabase
        .from('member_group')
        .update({ resource_subcategories: newLinked })
        .eq('id', group.id)
        .eq('tenant_id', group.tenant_id);

      if (error) {
        console.error(`  [ERROR] group ${group.id}: ${error.message}`);
      } else {
        console.log(`  [OK] group ${group.id} (${group.name || 'unnamed'}): ${JSON.stringify(linked)} → ${JSON.stringify(newLinked)}`);
        totalGroupsUpdated++;
      }
    }

    if (totalGroupsUpdated === 0) {
      console.log('  No member groups referenced any of the supplied old names.');
    }
  }

  console.log();
  console.log('─'.repeat(72));
  console.log(`  Resources updated        : ${totalUpdated}`);
  console.log(`  Resources skipped        : ${totalSkipped} (no mapping provided)`);
  console.log(`  Member preferences fixed : ${totalMemberPrefsUpdated}`);
  if (fixGroups) {
    console.log(`  Member groups updated    : ${totalGroupsUpdated}`);
  }
  if (!applyChanges) {
    console.log('\n  This was a DRY RUN. Re-run with --apply to write changes.');
  } else {
    console.log('\n  Changes written to database.');
  }
  console.log('─'.repeat(72));
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
