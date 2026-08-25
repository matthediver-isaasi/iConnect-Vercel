#!/usr/bin/env node
/**
 * Idempotently register the Data / Custom Objects / Manage data model RBAC
 * hierarchy. Dry-run by default; pass --apply to write.
 */
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../api/_lib/roleVisibility.js';

const APPLY = process.argv.includes('--apply');
const TAG = '[seed-custom-objects-role-access]';
const url = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL || process.env.DEV_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY
  || process.env.DEST_SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_KEY
  || process.env.DEV_SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error(`${TAG} Missing Supabase credentials.`);
  process.exit(1);
}
const db = createClient(url, key);

const ITEMS = [
  { item_type: 'module', item_key: 'data', label: 'Data', icon: 'Database' },
  { item_type: 'page', item_key: 'data.custom-objects', label: 'Custom Objects', icon: null },
  {
    item_type: 'feature',
    item_key: 'data.custom-objects.manage-data-model',
    label: 'Manage data model',
    icon: null,
  },
];
const DEFAULT_EXCLUSIONS = ITEMS.slice(1).map((item) => item.item_key);

function isAdmin(exclusions) {
  return !isResourceExcluded(
    Array.isArray(exclusions) ? exclusions : [],
    'admin.role-management',
  );
}

async function ensureItem(item, parentId) {
  const { data: existing, error } = await db.from('role_access_item')
    .select('id,item_type,item_key,label,icon,parent_id,is_active')
    .eq('item_key', item.item_key).maybeSingle();
  if (error) throw error;
  if (existing) {
    const repairs = {};
    for (const [column, value] of Object.entries({
      item_type: item.item_type,
      label: item.label,
      icon: item.icon,
      parent_id: parentId,
      is_active: true,
    })) {
      if (existing[column] !== value) repairs[column] = value;
    }
    if (Object.keys(repairs).length === 0) {
      console.log(`${TAG} ${item.item_key} already configured.`);
    } else if (!APPLY) {
      console.log(`${TAG} DRY RUN: would repair ${item.item_key}.`);
    } else {
      const { error: updateError } = await db.from('role_access_item')
        .update(repairs).eq('id', existing.id);
      if (updateError) throw updateError;
      console.log(`${TAG} Repaired ${item.item_key}.`);
    }
    return existing.id;
  }
  let siblingQuery = db.from('role_access_item').select('display_order');
  siblingQuery = parentId === null
    ? siblingQuery.is('parent_id', null)
    : siblingQuery.eq('parent_id', parentId);
  const { data: siblings, error: siblingError } = await siblingQuery;
  if (siblingError) throw siblingError;
  const displayOrder = (siblings || []).reduce(
    (maximum, row) => Math.max(maximum, row.display_order || 0),
    -1,
  ) + 1;
  if (!APPLY) {
    console.log(`${TAG} DRY RUN: would insert ${item.item_key}.`);
    return null;
  }
  const { data, error: insertError } = await db.from('role_access_item').insert({
    ...item,
    parent_id: parentId,
    display_order: displayOrder,
    is_active: true,
  }).select('id').single();
  if (insertError) throw insertError;
  console.log(`${TAG} Inserted ${item.item_key}.`);
  return data.id;
}

async function fetchRoles() {
  const roles = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db.from('role')
      .select('id,name,excluded_features').order('id').range(from, from + 499);
    if (error) throw error;
    roles.push(...(data || []));
    if (!data || data.length < 500) return roles;
  }
}

async function seedRoleExclusions() {
  for (const role of await fetchRoles()) {
    const current = Array.isArray(role.excluded_features) ? role.excluded_features : [];
    const desired = isAdmin(current)
      ? current.filter((feature) => !DEFAULT_EXCLUSIONS.includes(feature))
      : [...new Set([...current, ...DEFAULT_EXCLUSIONS])];
    if (JSON.stringify(current) === JSON.stringify(desired)) continue;
    if (!APPLY) {
      console.log(`${TAG} DRY RUN: would update role "${role.name}".`);
      continue;
    }
    const { error } = await db.from('role').update({ excluded_features: desired }).eq('id', role.id);
    if (error) throw error;
    console.log(`${TAG} Updated role "${role.name}".`);
  }
}

async function seedTemplates() {
  const { data, error } = await db.from('platform_preferences')
    .select('value').eq('key', 'default_role_templates').maybeSingle();
  if (error) throw error;
  if (!data?.value || !Array.isArray(data.value.roles)) return;
  let changed = false;
  const roles = data.value.roles.map((role) => {
    const current = Array.isArray(role.excluded_features) ? role.excluded_features : [];
    const desired = isAdmin(current)
      ? current.filter((feature) => !DEFAULT_EXCLUSIONS.includes(feature))
      : [...new Set([...current, ...DEFAULT_EXCLUSIONS])];
    if (JSON.stringify(current) === JSON.stringify(desired)) return role;
    changed = true;
    return { ...role, excluded_features: desired };
  });
  if (!changed) return;
  if (!APPLY) {
    console.log(`${TAG} DRY RUN: would update default role templates.`);
    return;
  }
  const { error: updateError } = await db.from('platform_preferences').upsert({
    key: 'default_role_templates',
    value: { ...data.value, roles },
    description: 'Default role configurations to provision for new tenants',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (updateError) throw updateError;
}

async function run() {
  console.log(`${TAG} ${APPLY ? 'APPLY mode' : 'DRY RUN — pass --apply to write'}`);
  let parentId = null;
  for (const item of ITEMS) parentId = await ensureItem(item, parentId);
  await seedRoleExclusions();
  await seedTemplates();
  console.log(`${TAG} Done.`);
}

run().catch((error) => {
  console.error(`${TAG} Fatal: ${error.message}`);
  process.exit(1);
});