#!/usr/bin/env node
/**
 * Task #4603: registers the Individual Membership Payment Report permission.
 * Idempotent and DEST-only. Defaults to dry-run; pass --apply to write.
 *
 * This script intentionally does not alter role exclusions or default role
 * templates. The endpoint separately requires admin access, and access to this
 * report can be configured after registration. Re-running registration must
 * never reset those later choices.
 */
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const TAG = '[seed-membership-payment-report]';
const DEST_URL = process.env.DEST_SUPABASE_URL;
const KEY = process.env.DEST_SUPABASE_KEY || process.env.DEST_SUPABASE_SERVICE_KEY;
const MODULE_KEY = 'commerce';
const PAGE_KEY = 'commerce.membership-payment-report';
const PAGE_LABEL = 'Individual Membership Payment Report';
const DEST_HOSTNAME = 'lvmzliemqnieeoruhkik.supabase.co';

if (!DEST_URL || !KEY) {
  console.error(`${TAG} DEST_SUPABASE_URL and DEST_SUPABASE_KEY (or DEST_SUPABASE_SERVICE_KEY) are required.`);
  process.exit(1);
}

let destination;
try {
  destination = new URL(DEST_URL);
} catch {
  console.error(`${TAG} DEST_SUPABASE_URL is not a valid URL.`);
  process.exit(1);
}
if (destination.protocol !== 'https:' || destination.hostname !== DEST_HOSTNAME) {
  console.error(`${TAG} Refusing to access unpinned host "${destination.hostname}". Expected "${DEST_HOSTNAME}".`);
  process.exit(1);
}

const db = createClient(DEST_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function ensurePage() {
  const { data: module, error: moduleError } = await db.from('role_access_item')
    .select('id').eq('item_type', 'module').eq('item_key', MODULE_KEY).maybeSingle();
  if (moduleError) throw moduleError;
  if (!module) throw new Error('Commerce role-access module is missing; refusing to create an orphan page.');

  const { data: existing, error } = await db.from('role_access_item')
    .select('id,item_type,parent_id,label,is_active').eq('item_key', PAGE_KEY).maybeSingle();
  if (error) throw error;
  if (existing) {
    const patch = {};
    if (existing.item_type !== 'page') patch.item_type = 'page';
    if (existing.parent_id !== module.id) patch.parent_id = module.id;
    if (existing.label !== PAGE_LABEL) patch.label = PAGE_LABEL;
    if (existing.is_active !== true) patch.is_active = true;
    if (Object.keys(patch).length && APPLY) {
      const { error: updateError } = await db.from('role_access_item').update(patch).eq('id', existing.id);
      if (updateError) throw updateError;
    }
    console.log(`${TAG} ${Object.keys(patch).length ? `${APPLY ? 'repaired' : 'would repair'} page row` : 'page row already current'}.`);
    return;
  }

  const { data: siblings, error: siblingsError } = await db.from('role_access_item')
    .select('display_order').eq('parent_id', module.id);
  if (siblingsError) throw siblingsError;
  const displayOrder = (siblings || []).reduce((max, row) => Math.max(max, row.display_order || 0), -1) + 1;
  if (APPLY) {
    const { error: insertError } = await db.from('role_access_item').insert({
      item_type: 'page', item_key: PAGE_KEY, label: PAGE_LABEL, icon: null,
      parent_id: module.id, display_order: displayOrder, is_active: true,
    });
    if (insertError) throw insertError;
  }
  console.log(`${TAG} ${APPLY ? 'inserted' : 'would insert'} page row.`);
}

await ensurePage();
console.log(`${TAG} done (${APPLY ? 'APPLY' : 'DRY RUN'}).`);