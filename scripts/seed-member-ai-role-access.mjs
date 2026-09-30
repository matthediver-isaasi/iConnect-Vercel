#!/usr/bin/env node
/**
 * Task #2441: Make the Member AI Assistant assignable in /rolemanagement.
 *
 * One-shot, idempotent data migration that:
 *   1. Ensures the Support module row exists in `role_access_item`.
 *   2. Inserts the page row for `support.member-ai` (item_type=page,
 *      parent_id=<support module row id>) so the key becomes assignable in
 *      the role editor.
 *
 * Deliberately does NOT backfill exclusions onto existing roles: the member
 * AI assistant follows the platform's deny-list model and ships
 * visible-by-default (same rollout as `support.docs`). Admins untick the key
 * per role to hide it.
 *
 * Defaults to dry-run; pass --apply to write.
 *
 * Usage:
 *   node scripts/seed-member-ai-role-access.mjs [--apply]
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
  console.error('[seed-member-ai] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const SUPPORT_MODULE_KEY = 'support';
const SUPPORT_MODULE_LABEL = 'Support';
const SUPPORT_MODULE_ICON = 'HelpCircle';

const PAGE_KEY = 'support.member-ai';
const PAGE_LABEL = 'Member AI Assistant';

async function ensureSupportModuleRow() {
  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, item_key, label, icon, display_order, is_active')
    .eq('item_type', 'module')
    .eq('item_key', SUPPORT_MODULE_KEY)
    .maybeSingle();
  if (error) throw error;

  if (existing) {
    console.log(`[seed-member-ai] Support module row already present (id=${existing.id}).`);
    return existing;
  }

  if (!APPLY) {
    console.log('[seed-member-ai] DRY RUN: would insert Support module row.');
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
      item_key: SUPPORT_MODULE_KEY,
      label: SUPPORT_MODULE_LABEL,
      icon: SUPPORT_MODULE_ICON,
      parent_id: null,
      display_order: nextOrder,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-member-ai] Inserted Support module row (id=${created.id}).`);
  return created;
}

async function ensureMemberAiPageRow(supportModuleId) {
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
    if (supportModuleId && existing.parent_id !== supportModuleId) {
      repairs.parent_id = supportModuleId;
    }
    if (existing.is_active !== true) repairs.is_active = true;
    if (existing.label !== PAGE_LABEL) repairs.label = PAGE_LABEL;

    if (Object.keys(repairs).length > 0) {
      if (!APPLY) {
        console.log(
          `[seed-member-ai] DRY RUN: would repair page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`
        );
        return existing;
      }
      const { error: upErr } = await supabase
        .from('role_access_item')
        .update(repairs)
        .eq('id', existing.id);
      if (upErr) throw upErr;
      console.log(
        `[seed-member-ai] Repaired page row (id=${existing.id}): ${Object.keys(repairs).join(', ')}`
      );
    } else {
      console.log(`[seed-member-ai] ${PAGE_KEY} page row already present (id=${existing.id}).`);
    }
    return { ...existing, ...repairs };
  }

  if (!APPLY) {
    console.log(`[seed-member-ai] DRY RUN: would insert ${PAGE_KEY} page row under Support module.`);
    return null;
  }

  // Append after the module's existing pages.
  const { data: siblings, error: sibErr } = await supabase
    .from('role_access_item')
    .select('display_order')
    .eq('item_type', 'page')
    .eq('parent_id', supportModuleId);
  if (sibErr) throw sibErr;
  const nextOrder = siblings.reduce((m, s) => Math.max(m, s.display_order || 0), -1) + 1;

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'page',
      item_key: PAGE_KEY,
      label: PAGE_LABEL,
      icon: null,
      parent_id: supportModuleId,
      display_order: nextOrder,
      is_active: true,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  console.log(`[seed-member-ai] Inserted ${PAGE_KEY} page row (id=${created.id}).`);
  return created;
}

async function run() {
  console.log(`[seed-member-ai] Starting${APPLY ? '' : ' (dry run — pass --apply to write)'}...`);
  const supportModule = await ensureSupportModuleRow();
  await ensureMemberAiPageRow(supportModule?.id || null);
  console.log('[seed-member-ai] Done.');
}

run().catch((err) => {
  console.error('[seed-member-ai] Fatal:', err);
  process.exit(1);
});
