#!/usr/bin/env node
/**
 * Revert the Task #3043 admin.dashboard role-access seed. The requirement was
 * to gate the portal member dashboard at /dashboard (key: system.dashboard),
 * not the admin dashboard at /admin/dashboard. This script removes all
 * production data that seed created:
 *
 *   1. Deletes the `admin.dashboard` page row from `role_access_item`
 *      (leaves the Admin Toolkit module row alone — other pages use it).
 *   2. Strips `admin.dashboard` from `excluded_features` on every role.
 *   3. Strips `admin.dashboard` from every template in the
 *      `default_role_templates` platform preference.
 *
 * Safe to re-run. Defaults to DRY RUN; pass --apply to write changes.
 *
 * Usage:
 *   node scripts/cleanup-admin-dashboard-role-access.mjs           # dry run
 *   node scripts/cleanup-admin-dashboard-role-access.mjs --apply   # write changes
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
  console.error('[cleanup-admin-dashboard] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PAGE_KEY = 'admin.dashboard';

async function deletePageRow() {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label')
    .eq('item_key', PAGE_KEY)
    .maybeSingle();
  if (error) throw error;

  if (!existing) {
    console.log('[cleanup-admin-dashboard] No role_access_item row for admin.dashboard; nothing to delete.');
    return;
  }

  if (!APPLY) {
    console.log(`[cleanup-admin-dashboard] DRY RUN: would delete role_access_item row (id=${existing.id}).`);
    return;
  }

  const { error: delErr } = await supabase
    .from('role_access_item')
    .delete()
    .eq('id', existing.id);
  if (delErr) throw delErr;
  console.log(`[cleanup-admin-dashboard] Deleted role_access_item row (id=${existing.id}).`);
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

async function stripFromRoles() {
  const roles = await fetchAllRoles();

  let updated = 0;
  let untouched = 0;
  const failures = [];

  for (const role of roles) {
    const current = Array.isArray(role.excluded_features) ? role.excluded_features : [];
    if (!current.includes(PAGE_KEY)) {
      untouched++;
      continue;
    }

    if (!APPLY) {
      console.log(`[cleanup-admin-dashboard] DRY RUN: would remove exclusion from role "${role.name}" (id=${role.id})`);
      updated++;
      continue;
    }

    const next = current.filter((k) => k !== PAGE_KEY);
    const { error: updErr } = await supabase
      .from('role')
      .update({ excluded_features: next })
      .eq('id', role.id);
    if (updErr) {
      console.error(`[cleanup-admin-dashboard] Failed to update role "${role.name}" (${role.id}): ${updErr.message}`);
      failures.push({ id: role.id, name: role.name, message: updErr.message });
      continue;
    }
    console.log(`[cleanup-admin-dashboard] Removed exclusion from role: "${role.name}"`);
    updated++;
  }

  console.log(
    `[cleanup-admin-dashboard] Total roles processed: ${roles.length}; ${APPLY ? 'updated' : 'would update'}: ${updated}; untouched: ${untouched}; failed: ${failures.length}`
  );

  if (failures.length > 0) {
    throw new Error(
      `Failed to update ${failures.length} role(s); first failure: ${failures[0].name} (${failures[0].id}) - ${failures[0].message}. Re-run after resolving.`
    );
  }
}

async function stripFromRoleTemplates() {
  const { data: pref, error } = await supabase
    .from('platform_preferences')
    .select('value')
    .eq('key', 'default_role_templates')
    .maybeSingle();
  if (error) {
    console.warn(`[cleanup-admin-dashboard] Could not read default_role_templates: ${error.message}`);
    return;
  }
  if (!pref || !pref.value || !Array.isArray(pref.value.roles)) {
    console.log('[cleanup-admin-dashboard] No default_role_templates preference found; skipping.');
    return;
  }

  let changed = false;
  const updatedRoles = pref.value.roles.map((tpl) => {
    const excluded = Array.isArray(tpl.excluded_features) ? tpl.excluded_features : [];
    const filtered = excluded.filter((k) => k !== PAGE_KEY);
    if (filtered.length !== excluded.length) {
      changed = true;
      console.log(`[cleanup-admin-dashboard] ${APPLY ? 'Removed' : 'DRY RUN: would remove'} exclusion from template: "${tpl.name}"`);
      return { ...tpl, excluded_features: filtered };
    }
    return tpl;
  });

  if (!changed) {
    console.log('[cleanup-admin-dashboard] Default role templates already clean.');
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
    console.error(`[cleanup-admin-dashboard] Failed to update default_role_templates: ${upErr.message}`);
    return;
  }
  console.log('[cleanup-admin-dashboard] Updated default_role_templates.');
}

async function run() {
  console.log(`[cleanup-admin-dashboard] Starting... ${APPLY ? '(APPLY mode)' : '(DRY RUN — pass --apply to write)'}`);
  await deletePageRow();
  await stripFromRoles();
  await stripFromRoleTemplates();
  console.log('[cleanup-admin-dashboard] Done.');
}

run().catch((err) => {
  console.error('[cleanup-admin-dashboard] Fatal:', err);
  process.exit(1);
});
