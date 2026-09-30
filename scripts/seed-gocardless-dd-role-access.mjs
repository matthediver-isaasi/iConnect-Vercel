#!/usr/bin/env node
/**
 * Task #3125 GoCardless Phase 4: Make the Direct Debit admin console assignable in
 * /rolemanagement, default disabled for non-admin roles.
 *
 * One-shot, idempotent data migration that:
 *   1. Locates the existing Commerce module row in `role_access_item`
 *      (item_key=`commerce`).
 *   2. Inserts the page row for `commerce.gocardless-dd`
 *      (item_type=page, parent_id=<commerce module row id>) so the page
 *      becomes assignable in the role editor.
 *   3. Adds `commerce.gocardless-dd` to `excluded_features` for
 *      every existing role EXCEPT roles that retain admin access
 *      (Super Admin / Administrator by name, per codebase convention).
 *   4. Updates the saved default role templates in `platform_preferences`
 *      (key=`default_role_templates`) so newly provisioned tenants inherit
 *      the same default.
 *
 * Safe to re-run. Defaults to DRY RUN; pass --apply to write changes.
 *
 * Usage:
 *   node scripts/seed-gocardless-dd-role-access.mjs           # dry run
 *   node scripts/seed-gocardless-dd-role-access.mjs --apply   # write changes
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const TAG = '[seed-gocardless-dd]';

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
  console.error(`${TAG} Missing Supabase credentials.`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MODULE_KEY = 'commerce';
const MODULE_LABEL = 'Commerce';
const MODULE_ICON = 'CreditCard';

const PAGE_KEY = 'commerce.gocardless-dd';
const PAGE_LABEL = 'Direct Debit Console';

// Roles/templates considered admin-level by codebase convention.
const ADMIN_ROLE_NAMES = new Set(['Super Admin', 'Administrator']);

function isAdminRoleByName(name) {
  return ADMIN_ROLE_NAMES.has((name || '').trim());
}

async function ensureModuleRow() {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, display_order, is_active')
    .eq('item_type', 'module')
    .eq('item_key', MODULE_KEY)
    .maybeSingle();
  if (error) throw error;

  if (existing) {
    console.log(`${TAG} Commerce module row already present (id=${existing.id}).`);
    return existing;
  }

  const { data: siblings, error: sibErr } = await supabase
    .from('role_access_item')
    .select('display_order')
    .eq('item_type', 'module');
  if (sibErr) throw sibErr;
  const nextOrder = (siblings || []).reduce((m, s) => Math.max(m, s.display_order || 0), -1) + 1;

  if (!APPLY) {
    console.log(`${TAG} DRY RUN: would insert Commerce module row.`);
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
  console.log(`${TAG} Inserted Commerce module row (id=${created.id}).`);
  return created;
}

async function ensurePageRow(moduleId) {
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
        console.log(`${TAG} DRY RUN: would repair page row: ${Object.keys(repairs).join(', ')}`);
        return existing;
      }
      const { error: upErr } = await supabase
        .from('role_access_item')
        .update(repairs)
        .eq('id', existing.id);
      if (upErr) throw upErr;
      console.log(`${TAG} Repaired page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`);
    } else {
      console.log(`${TAG} Page row already present (id=${existing.id}).`);
    }
    return { ...existing, ...repairs };
  }

  // Slot after the existing voucher-management page within the module.
  let displayOrder = 0;
  if (moduleId) {
    const { data: pages, error: pErr } = await supabase
      .from('role_access_item')
      .select('display_order')
      .eq('parent_id', moduleId);
    if (pErr) throw pErr;
    displayOrder = (pages || []).reduce((m, p) => Math.max(m, p.display_order || 0), -1) + 1;
  }

  if (!APPLY) {
    console.log(`${TAG} DRY RUN: would insert Direct Debit Console page row.`);
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
      display_order: displayOrder,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;
  console.log(`${TAG} Inserted Direct Debit Console page row (id=${created.id}).`);
  return created;
}

async function fetchAllRoles() {
  // PostgREST caps unbounded SELECTs at ~1000 rows; page through explicitly.
  const PAGE_SIZE = 500;
  const roles = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('role')
      .select('id, name, excluded_features')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
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
      skippedAdmin++;
      continue;
    }

    if (!APPLY) {
      console.log(`${TAG} DRY RUN: would add exclusion to role "${role.name}" (id=${role.id})`);
      updated++;
      continue;
    }

    const { error: updErr } = await supabase
      .from('role')
      .update({ excluded_features: [...current, PAGE_KEY] })
      .eq('id', role.id);
    if (updErr) {
      console.error(`${TAG} Failed to update role "${role.name}" (${role.id}): ${updErr.message}`);
      failures.push({ id: role.id, name: role.name, message: updErr.message });
      continue;
    }
    console.log(`${TAG} Added exclusion to role: "${role.name}"`);
    updated++;
  }

  console.log(
    `${TAG} Total roles processed: ${roles.length}; ${APPLY ? 'updated' : 'would update'}: ${updated}; admin skipped: ${skippedAdmin}; already excluded: ${alreadyExcluded}; failed: ${failures.length}`
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
    console.warn(`${TAG} Could not read default_role_templates: ${error.message}`);
    return;
  }
  if (!pref || !pref.value || !Array.isArray(pref.value.roles)) {
    console.log(`${TAG} No default_role_templates preference found; skipping template update.`);
    return;
  }

  let changed = false;
  const updatedRoles = pref.value.roles.map((tpl) => {
    const excluded = Array.isArray(tpl.excluded_features) ? [...tpl.excluded_features] : [];

    if (isAdminRoleByName(tpl.name)) {
      const filtered = excluded.filter((k) => k !== PAGE_KEY);
      if (filtered.length !== excluded.length) {
        changed = true;
        console.log(`${TAG} ${APPLY ? 'Removed' : 'DRY RUN: would remove'} exclusion from admin template: "${tpl.name}"`);
        return { ...tpl, excluded_features: filtered };
      }
      return tpl;
    }

    if (excluded.includes(PAGE_KEY)) return tpl;
    excluded.push(PAGE_KEY);
    changed = true;
    console.log(`${TAG} ${APPLY ? 'Added' : 'DRY RUN: would add'} exclusion to template: "${tpl.name}"`);
    return { ...tpl, excluded_features: excluded };
  });

  if (!changed) {
    console.log(`${TAG} Default role templates already up to date.`);
    return;
  }
  if (!APPLY) return;

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
    console.error(`${TAG} Failed to update default_role_templates: ${upErr.message}`);
    return;
  }
  console.log(`${TAG} Updated default_role_templates.`);
}

async function run() {
  console.log(`${TAG} Starting... ${APPLY ? '(APPLY mode)' : '(DRY RUN — pass --apply to write)'}`);
  const moduleRow = await ensureModuleRow();
  await ensurePageRow(moduleRow?.id ?? null);
  await excludeFromExistingRoles();
  await updateRoleTemplates();
  console.log(`${TAG} Done.`);
}

run().catch((err) => {
  console.error(`${TAG} Fatal:`, err);
  process.exit(1);
});
