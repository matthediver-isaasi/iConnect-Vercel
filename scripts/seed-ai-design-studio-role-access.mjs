#!/usr/bin/env node
/**
 * Task #2852: Make the AI Design Studio permission keys assignable in
 * /rolemanagement.
 *
 * Idempotent: inserts (or repairs) these `role_access_item` page rows under
 * their existing module rows:
 *   - admin.ai-design-studio        (configure — under Administration)
 *   - site-builder.ai-generate      (generate — under Site Builder)
 *   - site-builder.ai-approve       (approve changes — under Site Builder)
 * No exclusion backfill — deny-list model, allowed-by-default for roles.
 *
 * Defaults to dry-run; pass --apply to write.
 *
 * Usage:
 *   node scripts/seed-ai-design-studio-role-access.mjs [--apply]
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

const SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[seed-ai-design-studio] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const ENTRIES = [
  { moduleKey: 'admin', pageKey: 'admin.ai-design-studio', label: 'AI Design Studio' },
  { moduleKey: 'site-builder', pageKey: 'site-builder.ai-generate', label: 'AI Design Studio — Generate' },
  { moduleKey: 'site-builder', pageKey: 'site-builder.ai-approve', label: 'AI Design Studio — Approve Changes' },
];

async function seedEntry({ moduleKey, pageKey, label }) {
  const { data: moduleRow, error: modErr } = await supabase
    .from('role_access_item')
    .select('id')
    .eq('item_type', 'module')
    .eq('item_key', moduleKey)
    .maybeSingle();
  if (modErr) throw modErr;
  if (!moduleRow) {
    console.error(`[seed-ai-design-studio] Module row "${moduleKey}" not found — skipping ${pageKey}.`);
    return;
  }

  const { data: existing, error } = await supabase
    .from('role_access_item')
    .select('id, item_type, parent_id, label, is_active')
    .eq('item_key', pageKey)
    .maybeSingle();
  if (error) throw error;

  if (existing) {
    const repairs = {};
    if (existing.item_type !== 'page') repairs.item_type = 'page';
    if (existing.parent_id !== moduleRow.id) repairs.parent_id = moduleRow.id;
    if (existing.is_active !== true) repairs.is_active = true;
    if (existing.label !== label) repairs.label = label;
    if (Object.keys(repairs).length === 0) {
      console.log(`[seed-ai-design-studio] ${pageKey} already present (id=${existing.id}).`);
      return;
    }
    if (!APPLY) {
      console.log(`[seed-ai-design-studio] DRY RUN: would repair ${pageKey}: ${Object.keys(repairs).join(', ')}`);
      return;
    }
    const { error: upErr } = await supabase.from('role_access_item').update(repairs).eq('id', existing.id);
    if (upErr) throw upErr;
    console.log(`[seed-ai-design-studio] Repaired ${pageKey} (id=${existing.id}).`);
    return;
  }

  if (!APPLY) {
    console.log(`[seed-ai-design-studio] DRY RUN: would insert ${pageKey} under "${moduleKey}" module.`);
    return;
  }

  const { data: siblings, error: sibErr } = await supabase
    .from('role_access_item')
    .select('display_order')
    .eq('item_type', 'page')
    .eq('parent_id', moduleRow.id);
  if (sibErr) throw sibErr;
  const nextOrder = (siblings || []).reduce((m, s) => Math.max(m, s.display_order || 0), -1) + 1;

  const { data: created, error: insErr } = await supabase
    .from('role_access_item')
    .insert({
      item_type: 'page',
      item_key: pageKey,
      label,
      icon: null,
      parent_id: moduleRow.id,
      display_order: nextOrder,
      is_active: true,
    })
    .select('id')
    .single();
  if (insErr) throw insErr;
  console.log(`[seed-ai-design-studio] Inserted ${pageKey} page row (id=${created.id}).`);
}

async function run() {
  console.log(`[seed-ai-design-studio] Starting${APPLY ? '' : ' (dry run — pass --apply to write)'}...`);
  for (const entry of ENTRIES) {
    await seedEntry(entry);
  }
}

run().catch((err) => {
  console.error('[seed-ai-design-studio] Fatal:', err);
  process.exit(1);
});
