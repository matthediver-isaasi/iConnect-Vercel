#!/usr/bin/env node
/**
 * Task #3282: Make Badge Management assignable in /rolemanagement.
 *
 * One-shot, idempotent data migration that:
 *   1. Ensures the Admin Toolkit module row exists in `role_access_item`.
 *   2. Inserts the page row for `admin.badges` (item_type=page,
 *      parent_id=<admin module row id>) so the key becomes assignable in
 *      the role editor.
 *
 * Deliberately does NOT backfill exclusions onto existing roles: Badge
 * Management follows the platform's deny-list model and ships
 * visible-by-default. Admins untick the key per role to hide it.
 *
 * Defaults to dry-run; pass --apply to write.
 *
 * Usage:
 *   node scripts/seed-badges-role-access.mjs [--apply]
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
  console.error('[seed-badges] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const MODULE_KEY = 'admin';
const MODULE_LABEL = 'Admin Toolkit';
const MODULE_ICON = 'Shield';

const PAGE_KEY = 'admin.badges';
const PAGE_LABEL = 'Badge Management';

async function ensureAdminModuleRow() {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, icon, display_order, is_active')
    .eq('item_type', 'module')
    .eq('item_key', MODULE_KEY)
    .maybeSingle();
  if (error) throw error;

  if (existing) {
    console.log(`[seed-badges] Admin module row already present (id=${existing.id}).`);
    return existing;
  }

  if (!APPLY) {
    console.log('[seed-badges] DRY RUN: would insert Admin Toolkit module row.');
    return null;
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

  console.log(`[seed-badges] Inserted Admin Toolkit module row (id=${created.id}).`);
  return created;
}

async function ensureBadgesPageRow(moduleId) {
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
        console.log(
          `[seed-badges] DRY RUN: would repair page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`
        );
        return existing;
      }
      const { error: upErr } = await supabase
        .from('role_access_item')
        .update(repairs)
        .eq('id', existing.id);
      if (upErr) throw upErr;
      console.log(
        `[seed-badges] Repaired page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`
      );
    } else {
      console.log(`[seed-badges] admin.badges page row already present (id=${existing.id}).`);
    }
    return { ...existing, ...repairs };
  }

  if (!APPLY) {
    console.log('[seed-badges] DRY RUN: would insert admin.badges page row.');
    return null;
  }

  const { data: siblings, error: sibErr } = await supabase
    .from('role_access_item')
    .select('display_order')
    .eq('item_type', 'page')
    .eq('parent_id', moduleId);
  if (sibErr) throw sibErr;
  const nextOrder = (siblings || []).reduce((m, s) => Math.max(m, s.display_order || 0), -1) + 1;

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'page',
      item_key: PAGE_KEY,
      label: PAGE_LABEL,
      icon: null,
      parent_id: moduleId,
      display_order: nextOrder,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-badges] Inserted admin.badges page row (id=${created.id}).`);
  return created;
}

async function run() {
  console.log(`[seed-badges] Starting... ${APPLY ? '(APPLY mode)' : '(DRY RUN — pass --apply to write)'}`);
  const moduleRow = await ensureAdminModuleRow();
  await ensureBadgesPageRow(moduleRow?.id ?? null);
  console.log('[seed-badges] Done.');
}

run().catch((err) => {
  console.error('[seed-badges] Fatal:', err);
  process.exit(1);
});
