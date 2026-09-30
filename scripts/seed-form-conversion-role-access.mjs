#!/usr/bin/env node
/**
 * Task #2969: Make the Form Conversion Report assignable in /rolemanagement,
 * default disabled for non-admin roles.
 *
 * One-shot, idempotent data migration that:
 *   1. Ensures the Forms module row exists in `role_access_item`.
 *   2. Inserts the page row for `forms.conversion-report` (item_type=page,
 *      parent_id=<forms module row id>) so the page becomes assignable in the
 *      role editor.
 *   3. Adds `forms.conversion-report` to `excluded_features` for every
 *      existing role EXCEPT admin-level roles (Super Admin / Administrator).
 *   4. Updates the saved default role templates in `platform_preferences`
 *      (key=`default_role_templates`) so newly provisioned tenants inherit
 *      the same default.
 *
 * Safe to re-run.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/seed-form-conversion-role-access.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.DEST_SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[seed-form-conversion] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const FORMS_MODULE_KEY = 'forms';
const FORMS_MODULE_LABEL = 'Forms';
const FORMS_MODULE_ICON = 'ClipboardList';

const PAGE_KEY = 'forms.conversion-report';
const PAGE_LABEL = 'Form Conversion Report';
// Slotted after review-submission in the canonical Forms ordering.
const PAGE_DISPLAY_ORDER = 7;

const ADMIN_ROLE_NAMES = new Set(['Super Admin', 'Administrator']);

function isAdminRoleByName(name) {
  return ADMIN_ROLE_NAMES.has((name || '').trim());
}

async function ensureFormsModuleRow() {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, icon, display_order, is_active')
    .eq('item_type', 'module')
    .eq('item_key', FORMS_MODULE_KEY)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    console.log(`[seed-form-conversion] Forms module row already present (id=${existing.id}).`);
    return existing;
  }

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
      item_key: FORMS_MODULE_KEY,
      label: FORMS_MODULE_LABEL,
      icon: FORMS_MODULE_ICON,
      parent_id: null,
      display_order: nextOrder,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-form-conversion] Inserted Forms module row (id=${created.id}).`);
  return created;
}

async function ensurePageRow(formsModuleId) {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, parent_id, display_order, is_active')
    .eq('item_key', PAGE_KEY)
    .maybeSingle();

  if (error) throw error;

  if (existing) {
    const repairs = {};
    if (existing.item_type !== 'page') repairs.item_type = 'page';
    if (existing.parent_id !== formsModuleId) repairs.parent_id = formsModuleId;
    if (existing.is_active !== true) repairs.is_active = true;
    if (existing.label !== PAGE_LABEL) repairs.label = PAGE_LABEL;

    if (Object.keys(repairs).length > 0) {
      const { error: upErr } = await supabase
        .from('role_access_item')
        .update(repairs)
        .eq('id', existing.id);
      if (upErr) throw upErr;
      console.log(
        `[seed-form-conversion] Repaired page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`
      );
    } else {
      console.log(`[seed-form-conversion] Page row already present (id=${existing.id}).`);
    }
    return { ...existing, ...repairs };
  }

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'page',
      item_key: PAGE_KEY,
      label: PAGE_LABEL,
      icon: null,
      parent_id: formsModuleId,
      display_order: PAGE_DISPLAY_ORDER,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-form-conversion] Inserted page row (id=${created.id}).`);
  return created;
}

async function fetchAllRoles() {
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
      skippedAdmin++;
      continue;
    }

    const next = [...current, PAGE_KEY];
    const { error: updErr } = await supabase
      .from('role')
      .update({ excluded_features: next })
      .eq('id', role.id);
    if (updErr) {
      console.error(`[seed-form-conversion] Failed to update role "${role.name}" (${role.id}): ${updErr.message}`);
      failures.push({ id: role.id, name: role.name, message: updErr.message });
      continue;
    }
    updated++;
  }

  console.log(
    `[seed-form-conversion] Roles processed: ${roles.length}; updated: ${updated}; admin skipped: ${skippedAdmin}; already excluded: ${alreadyExcluded}; failed: ${failures.length}`
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
    console.warn(`[seed-form-conversion] Could not read default_role_templates: ${error.message}`);
    return;
  }
  if (!pref || !pref.value || !Array.isArray(pref.value.roles)) {
    console.log('[seed-form-conversion] No default_role_templates preference found; skipping.');
    return;
  }

  let changed = false;
  const updatedRoles = pref.value.roles.map((tpl) => {
    const excluded = Array.isArray(tpl.excluded_features) ? [...tpl.excluded_features] : [];

    if (isAdminRoleByName(tpl.name)) {
      const filtered = excluded.filter((k) => k !== PAGE_KEY);
      if (filtered.length !== excluded.length) {
        changed = true;
        console.log(`[seed-form-conversion] Removed exclusion from admin template: "${tpl.name}"`);
        return { ...tpl, excluded_features: filtered };
      }
      return tpl;
    }

    if (excluded.includes(PAGE_KEY)) {
      return tpl;
    }
    excluded.push(PAGE_KEY);
    changed = true;
    console.log(`[seed-form-conversion] Added exclusion to template: "${tpl.name}"`);
    return { ...tpl, excluded_features: excluded };
  });

  if (!changed) {
    console.log('[seed-form-conversion] Default role templates already up to date.');
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
    console.error(`[seed-form-conversion] Failed to update default_role_templates: ${upErr.message}`);
    return;
  }
  console.log('[seed-form-conversion] Updated default_role_templates.');
}

async function run() {
  console.log('[seed-form-conversion] Starting...');
  const formsModule = await ensureFormsModuleRow();
  await ensurePageRow(formsModule.id);
  await excludeFromExistingRoles();
  await updateRoleTemplates();
  console.log('[seed-form-conversion] Done.');
}

run().catch((err) => {
  console.error('[seed-form-conversion] Fatal:', err);
  process.exit(1);
});
