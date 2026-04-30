#!/usr/bin/env node
/**
 * Task #628: Make Pending PO report assignable in /rolemanagement, default disabled.
 *
 * One-shot, idempotent data migration that:
 *   1. Ensures the Events module row exists in `role_access_item`.
 *   2. Inserts the page row for `events.pending-purchase-orders` (item_type=page,
 *      parent_id=<events module row id>) so the page becomes assignable in the
 *      role editor.
 *   3. Adds `events.pending-purchase-orders` to `excluded_features` for every
 *      existing role EXCEPT roles that retain admin access (i.e. roles that are
 *      not excluded from `admin.role-management`). This flips the page to
 *      off-by-default for everyone except admins.
 *   4. Updates the saved default role templates in `platform_preferences`
 *      (key=`default_role_templates`) so newly provisioned tenants inherit the
 *      same default: the Member-style templates get the key added to their
 *      `excluded_features`, the Super Admin template does not.
 *
 * Safe to re-run.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   node scripts/seed-pending-po-role-access.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[seed-pending-po] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const EVENTS_MODULE_KEY = 'events';
const EVENTS_MODULE_LABEL = 'Events';
const EVENTS_MODULE_ICON = 'Calendar';

const PPO_PAGE_KEY = 'events.pending-purchase-orders';
const PPO_PAGE_LABEL = 'Pending Purchase Orders Report';
// Slotted between event-settings and speakers in the canonical ordering.
const PPO_PAGE_DISPLAY_ORDER = 5;

// Roles/templates considered admin-level by the codebase convention used in
// api/_lib/provisionTenantService.js and scripts/seed-role-templates.js.
// These are the only roles/templates that retain Pending PO access by default.
const ADMIN_ROLE_NAMES = new Set(['Super Admin', 'Administrator']);

function isAdminRoleByName(name) {
  return ADMIN_ROLE_NAMES.has((name || '').trim());
}

async function ensureEventsModuleRow() {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, icon, display_order, is_active')
    .eq('item_type', 'module')
    .eq('item_key', EVENTS_MODULE_KEY)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    console.log(`[seed-pending-po] Events module row already present (id=${existing.id}).`);
    return existing;
  }

  // Find current max display_order for module rows so we append cleanly.
  const { data: siblings, error: sibErr } = await supabase
    .from('role_access_item')
    .select('display_order')
    .eq('item_type', 'module');
  if (sibErr) throw sibErr;
  const nextOrder = siblings.reduce((m, s) => Math.max(m, s.display_order || 0), -1) + 1;

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'module',
      item_key: EVENTS_MODULE_KEY,
      label: EVENTS_MODULE_LABEL,
      icon: EVENTS_MODULE_ICON,
      parent_id: null,
      display_order: nextOrder,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-pending-po] Inserted Events module row (id=${created.id}).`);
  return created;
}

async function ensurePendingPoPageRow(eventsModuleId) {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, parent_id, display_order, is_active')
    .eq('item_key', PPO_PAGE_KEY)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    // Repair the row if a previous partial seed left it misconfigured (wrong
    // parent module, wrong item_type, deactivated, or missing label).
    const repairs = {};
    if (existing.item_type !== 'page') repairs.item_type = 'page';
    if (existing.parent_id !== eventsModuleId) repairs.parent_id = eventsModuleId;
    if (existing.is_active !== true) repairs.is_active = true;
    if (existing.label !== PPO_PAGE_LABEL) repairs.label = PPO_PAGE_LABEL;

    if (Object.keys(repairs).length > 0) {
      const { error: upErr } = await supabase
        .from('role_access_item')
        .update(repairs)
        .eq('id', existing.id);
      if (upErr) throw upErr;
      console.log(
        `[seed-pending-po] Repaired Pending PO page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`
      );
    } else {
      console.log(`[seed-pending-po] Pending PO page row already present (id=${existing.id}).`);
    }
    return { ...existing, ...repairs };
  }

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'page',
      item_key: PPO_PAGE_KEY,
      label: PPO_PAGE_LABEL,
      icon: null,
      parent_id: eventsModuleId,
      display_order: PPO_PAGE_DISPLAY_ORDER,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-pending-po] Inserted Pending PO page row (id=${created.id}).`);
  return created;
}

async function fetchAllRoles() {
  // PostgREST/Supabase caps unbounded SELECTs at ~1000 rows. Page through the
  // role table explicitly so we never silently miss roles in larger tenants.
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
    if (current.includes(PPO_PAGE_KEY)) {
      alreadyExcluded++;
      continue;
    }
    if (isAdminRoleByName(role.name)) {
      console.log(`[seed-pending-po] Skipping admin role: "${role.name}" (id=${role.id})`);
      skippedAdmin++;
      continue;
    }

    const next = [...current, PPO_PAGE_KEY];
    const { error: updErr } = await supabase
      .from('role')
      .update({ excluded_features: next })
      .eq('id', role.id);
    if (updErr) {
      console.error(`[seed-pending-po] Failed to update role "${role.name}" (${role.id}): ${updErr.message}`);
      failures.push({ id: role.id, name: role.name, message: updErr.message });
      continue;
    }
    console.log(`[seed-pending-po] Added exclusion to role: "${role.name}"`);
    updated++;
  }

  console.log(
    `[seed-pending-po] Total roles processed: ${roles.length}; updated: ${updated}; admin skipped: ${skippedAdmin}; already excluded: ${alreadyExcluded}; failed: ${failures.length}`
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
    console.warn(`[seed-pending-po] Could not read default_role_templates: ${error.message}`);
    return;
  }
  if (!pref || !pref.value || !Array.isArray(pref.value.roles)) {
    console.log('[seed-pending-po] No default_role_templates preference found; skipping template update.');
    return;
  }

  let changed = false;
  const updatedRoles = pref.value.roles.map((tpl) => {
    const excluded = Array.isArray(tpl.excluded_features) ? [...tpl.excluded_features] : [];

    if (isAdminRoleByName(tpl.name)) {
      // Admin template: ensure key is NOT present so admins keep access.
      const filtered = excluded.filter((k) => k !== PPO_PAGE_KEY);
      if (filtered.length !== excluded.length) {
        changed = true;
        console.log(`[seed-pending-po] Removed exclusion from admin template: "${tpl.name}"`);
        return { ...tpl, excluded_features: filtered };
      }
      return tpl;
    }

    // Non-admin template: ensure key IS present so the page is off-by-default.
    if (excluded.includes(PPO_PAGE_KEY)) {
      return tpl;
    }
    excluded.push(PPO_PAGE_KEY);
    changed = true;
    console.log(`[seed-pending-po] Added exclusion to template: "${tpl.name}"`);
    return { ...tpl, excluded_features: excluded };
  });

  if (!changed) {
    console.log('[seed-pending-po] Default role templates already up to date.');
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
    console.error(`[seed-pending-po] Failed to update default_role_templates: ${upErr.message}`);
    return;
  }
  console.log('[seed-pending-po] Updated default_role_templates.');
}

async function run() {
  console.log('[seed-pending-po] Starting...');
  const eventsModule = await ensureEventsModuleRow();
  await ensurePendingPoPageRow(eventsModule.id);
  await excludeFromExistingRoles();
  await updateRoleTemplates();
  console.log('[seed-pending-po] Done.');
}

run().catch((err) => {
  console.error('[seed-pending-po] Fatal:', err);
  process.exit(1);
});
