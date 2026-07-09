#!/usr/bin/env node
/**
 * Task #2523: Make Microsites management assignable in /rolemanagement,
 * default disabled for non-admin roles.
 *
 * One-shot, idempotent data migration that:
 *   1. Ensures the Site Builder module row exists in `role_access_item`.
 *   2. Inserts the page row for `site-builder.micro-sites` (item_type=page,
 *      parent_id=<site-builder module row id>) so the page becomes assignable
 *      in the role editor.
 *   3. Adds `site-builder.micro-sites` to `excluded_features` for every
 *      existing role EXCEPT roles that retain admin access (Super Admin /
 *      Administrator by name, per codebase convention). This flips the page
 *      to off-by-default for everyone except admins.
 *   4. Updates the saved default role templates in `platform_preferences`
 *      (key=`default_role_templates`) so newly provisioned tenants inherit
 *      the same default: non-admin templates get the key added to their
 *      `excluded_features`, admin templates do not.
 *
 * Safe to re-run. Defaults to DRY RUN; pass --apply to write changes.
 *
 * Usage:
 *   node scripts/seed-microsites-role-access.mjs           # dry run
 *   node scripts/seed-microsites-role-access.mjs --apply   # write changes
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[seed-microsites] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MODULE_KEY = 'site-builder';
const MODULE_LABEL = 'Site Builder';
const MODULE_ICON = 'Layout';

const PAGE_KEY = 'site-builder.micro-sites';
const PAGE_LABEL = 'Microsites';
// Slotted after site-builder.navigation in the canonical ordering (roleAccessMap.ts).
const PAGE_DISPLAY_ORDER = 5;

// Roles/templates considered admin-level by codebase convention (see
// api/_lib/provisionTenantService.js and scripts/seed-role-templates.js).
const ADMIN_ROLE_NAMES = new Set(['Super Admin', 'Administrator']);

function isAdminRoleByName(name) {
  return ADMIN_ROLE_NAMES.has((name || '').trim());
}

async function ensureModuleRow() {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, icon, display_order, is_active')
    .eq('item_type', 'module')
    .eq('item_key', MODULE_KEY)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    console.log(`[seed-microsites] Site Builder module row already present (id=${existing.id}).`);
    return existing;
  }

  const { data: siblings, error: sibErr } = await supabase
    .from('role_access_item')
    .select('display_order')
    .eq('item_type', 'module');
  if (sibErr) throw sibErr;
  const nextOrder = siblings.reduce((m, s) => Math.max(m, s.display_order || 0), -1) + 1;

  if (!APPLY) {
    console.log('[seed-microsites] DRY RUN: would insert Site Builder module row.');
    return { id: null };
  }

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'module',
      item_key: MODULE_KEY,
      label: MODULE_LABEL,
      icon: MODULE_ICON,
      parent_id: null,
      display_order: nextOrder,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-microsites] Inserted Site Builder module row (id=${created.id}).`);
  return created;
}

async function ensureMicrositesPageRow(moduleId) {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, parent_id, display_order, is_active')
    .eq('item_key', PAGE_KEY)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    // Repair the row if a previous partial seed left it misconfigured.
    const repairs = {};
    if (existing.item_type !== 'page') repairs.item_type = 'page';
    if (moduleId && existing.parent_id !== moduleId) repairs.parent_id = moduleId;
    if (existing.is_active !== true) repairs.is_active = true;
    if (existing.label !== PAGE_LABEL) repairs.label = PAGE_LABEL;

    if (Object.keys(repairs).length > 0) {
      if (!APPLY) {
        console.log(`[seed-microsites] DRY RUN: would repair Microsites page row: ${Object.keys(repairs).join(', ')}`);
        return existing;
      }
      const { error: upErr } = await supabase
        .from('role_access_item')
        .update(repairs)
        .eq('id', existing.id);
      if (upErr) throw upErr;
      console.log(
        `[seed-microsites] Repaired Microsites page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`
      );
    } else {
      console.log(`[seed-microsites] Microsites page row already present (id=${existing.id}).`);
    }
    return { ...existing, ...repairs };
  }

  if (!APPLY) {
    console.log('[seed-microsites] DRY RUN: would insert Microsites page row.');
    return null;
  }

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'page',
      item_key: PAGE_KEY,
      label: PAGE_LABEL,
      icon: null,
      parent_id: moduleId,
      display_order: PAGE_DISPLAY_ORDER,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-microsites] Inserted Microsites page row (id=${created.id}).`);
  return created;
}

async function fetchAllRoles() {
  // PostgREST caps unbounded SELECTs at ~1000 rows; page through explicitly
  // with a stable order so we never silently miss roles.
  const PAGE_SIZE = 500;
  const roles = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('role')
      .select('id, name, excluded_features')
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    roles.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return roles;
}

async function excludeFromExistingRoles() {
  const roles = await fetchAllRoles();

  let updated = 0;
  let skippedAdmin = 0;
  let alreadyExcluded = 0;
  const failures = [];

  for (const role of roles) {
    const current = Array.isArray(role.excluded_features) ? role.excluded_features : [];
    if (current.includes(PAGE_KEY)) {
      alreadyExcluded++;
      continue;
    }
    if (isAdminRoleByName(role.name)) {
      console.log(`[seed-microsites] Skipping admin role: "${role.name}" (id=${role.id})`);
      skippedAdmin++;
      continue;
    }

    if (!APPLY) {
      console.log(`[seed-microsites] DRY RUN: would add exclusion to role "${role.name}" (id=${role.id})`);
      updated++;
      continue;
    }

    const next = [...current, PAGE_KEY];
    const { error: updErr } = await supabase
      .from('role')
      .update({ excluded_features: next })
      .eq('id', role.id);
    if (updErr) {
      console.error(`[seed-microsites] Failed to update role "${role.name}" (${role.id}): ${updErr.message}`);
      failures.push({ id: role.id, name: role.name, message: updErr.message });
      continue;
    }
    console.log(`[seed-microsites] Added exclusion to role: "${role.name}"`);
    updated++;
  }

  console.log(
    `[seed-microsites] Total roles processed: ${roles.length}; ${APPLY ? 'updated' : 'would update'}: ${updated}; admin skipped: ${skippedAdmin}; already excluded: ${alreadyExcluded}; failed: ${failures.length}`
  );

  if (failures.length > 0) {
    throw new Error(
      `Failed to update ${failures.length} role(s); first failure: ${failures[0].name} (${failures[0].id}) - ${failures[0].message}. Re-run after resolving.`
    );
  }
}

async function updateRoleTemplates() {
  const { data: pref, error } = await supabase
    .from('platform_preferences')
    .select('value')
    .eq('key', 'default_role_templates')
    .maybeSingle();
  if (error) {
    console.warn(`[seed-microsites] Could not read default_role_templates: ${error.message}`);
    return;
  }
  if (!pref || !pref.value || !Array.isArray(pref.value.roles)) {
    console.log('[seed-microsites] No default_role_templates preference found; skipping template update.');
    return;
  }

  let changed = false;
  const updatedRoles = pref.value.roles.map((tpl) => {
    const excluded = Array.isArray(tpl.excluded_features) ? [...tpl.excluded_features] : [];

    if (isAdminRoleByName(tpl.name)) {
      // Admin template: ensure key is NOT present so admins keep access.
      const filtered = excluded.filter((k) => k !== PAGE_KEY);
      if (filtered.length !== excluded.length) {
        changed = true;
        console.log(`[seed-microsites] ${APPLY ? 'Removed' : 'DRY RUN: would remove'} exclusion from admin template: "${tpl.name}"`);
        return { ...tpl, excluded_features: filtered };
      }
      return tpl;
    }

    // Non-admin template: ensure key IS present so the page is off-by-default.
    if (excluded.includes(PAGE_KEY)) {
      return tpl;
    }
    excluded.push(PAGE_KEY);
    changed = true;
    console.log(`[seed-microsites] ${APPLY ? 'Added' : 'DRY RUN: would add'} exclusion to template: "${tpl.name}"`);
    return { ...tpl, excluded_features: excluded };
  });

  if (!changed) {
    console.log('[seed-microsites] Default role templates already up to date.');
    return;
  }
  if (!APPLY) {
    return;
  }

  const { error: upErr } = await supabase
    .from('platform_preferences')
    .upsert(
      {
        key: 'default_role_templates',
        value: { ...pref.value, roles: updatedRoles },
        description: 'Default role configurations to provision for new tenants',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
  if (upErr) {
    console.error(`[seed-microsites] Failed to update default_role_templates: ${upErr.message}`);
    return;
  }
  console.log('[seed-microsites] Updated default_role_templates.');
}

async function run() {
  console.log(`[seed-microsites] Starting... ${APPLY ? '(APPLY mode)' : '(DRY RUN — pass --apply to write)'}`);
  const moduleRow = await ensureModuleRow();
  await ensureMicrositesPageRow(moduleRow?.id ?? null);
  await excludeFromExistingRoles();
  await updateRoleTemplates();
  console.log('[seed-microsites] Done.');
}

run().catch((err) => {
  console.error('[seed-microsites] Fatal:', err);
  process.exit(1);
});
