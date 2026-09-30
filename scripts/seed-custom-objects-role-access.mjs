#!/usr/bin/env node
/**
 * Idempotently register the Admin Toolkit / Data Studio / Manage data model
 * RBAC hierarchy. Dry-run by default; pass --apply to write.
 */
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../api/_lib/roleVisibility.js';
import {
  DATA_STUDIO_PAGE,
  DATA_STUDIO_PAGE_KEY,
  normaliseDataStudioExclusions,
  planDataStudioPageMigration,
} from './custom-objects-role-access-helpers.mjs';

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

const ADMIN_MODULE = {
  item_type: 'module',
  item_key: 'admin',
  label: 'Admin Toolkit',
  icon: 'Shield',
};
const MANAGE_DATA_MODEL = {
  item_type: 'feature',
  item_key: 'data.custom-objects.manage-data-model',
  label: 'Manage Data Model',
  icon: null,
};
const DEFAULT_EXCLUSIONS = [DATA_STUDIO_PAGE_KEY, MANAGE_DATA_MODEL.item_key];

function isAdmin(exclusions) {
  return !isResourceExcluded(
    Array.isArray(exclusions) ? exclusions : [],
    'admin.role-management',
  );
}

async function ensureItem(item, parentId) {
  const { data: existing, error } = await db.from('role_access_item')
    .select('id,item_type,item_key,label,icon,parent_id,is_active')
    .eq('item_key', item.item_key).limit(1).maybeSingle();
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

async function ensureDataStudioPage(parentId) {
  const keys = [DATA_STUDIO_PAGE_KEY, 'data.custom-objects'];
  const { data: rows, error } = await db.from('role_access_item')
    .select('id,item_type,item_key,label,icon,parent_id,is_active')
    .in('item_key', keys);
  if (error) throw error;

  const plan = planDataStudioPageMigration(rows, parentId);
  if (!plan.keeper) return ensureItem(DATA_STUDIO_PAGE, parentId);

  if (Object.keys(plan.repairs).length === 0) {
    console.log(`${TAG} ${DATA_STUDIO_PAGE_KEY} already configured.`);
  } else if (!APPLY) {
    console.log(`${TAG} DRY RUN: would migrate ${plan.keeper.item_key} to ${DATA_STUDIO_PAGE_KEY}.`);
  } else {
    const { error: updateError } = await db.from('role_access_item')
      .update(plan.repairs)
      .eq('id', plan.keeper.id);
    if (updateError) throw updateError;
    console.log(`${TAG} Migrated ${plan.keeper.item_key} to ${DATA_STUDIO_PAGE_KEY}.`);
  }

  if (plan.retireIds.length > 0) {
    if (!APPLY) {
      console.log(`${TAG} DRY RUN: would deactivate ${plan.retireIds.length} duplicate Data Studio row(s).`);
    } else {
      const { error: retireError } = await db.from('role_access_item')
        .update({ is_active: false })
        .in('id', plan.retireIds);
      if (retireError) throw retireError;
      console.log(`${TAG} Deactivated ${plan.retireIds.length} duplicate Data Studio row(s).`);
    }
  }

  return plan.keeper.id;
}

async function retireEmptyLegacyDataModule(movedPageId) {
  const { data: modules, error: moduleError } = await db.from('role_access_item')
    .select('id,is_active')
    .eq('item_type', 'module')
    .eq('item_key', 'data');
  if (moduleError) throw moduleError;

  for (const module of modules || []) {
    if (module.is_active === false) continue;
    const { data: children, error: childrenError } = await db.from('role_access_item')
      .select('id,is_active')
      .eq('parent_id', module.id)
      .eq('is_active', true);
    if (childrenError) throw childrenError;
    const remaining = (children || []).filter((child) => child.id !== movedPageId);
    if (remaining.length > 0) continue;
    if (!APPLY) {
      console.log(`${TAG} DRY RUN: would deactivate the empty legacy data module.`);
    } else {
      const { error: retireError } = await db.from('role_access_item')
        .update({ is_active: false })
        .eq('id', module.id);
      if (retireError) throw retireError;
      console.log(`${TAG} Deactivated the empty legacy data module.`);
    }
  }
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
    const migrated = normaliseDataStudioExclusions(current);
    const desired = isAdmin(migrated)
      ? migrated
      : [...new Set([...migrated, ...DEFAULT_EXCLUSIONS])];
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
    const migrated = normaliseDataStudioExclusions(current);
    const desired = isAdmin(migrated)
      ? migrated
      : [...new Set([...migrated, ...DEFAULT_EXCLUSIONS])];
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
  const adminId = await ensureItem(ADMIN_MODULE, null);
  const dataStudioId = await ensureDataStudioPage(adminId);
  await ensureItem(MANAGE_DATA_MODEL, dataStudioId);
  await retireEmptyLegacyDataModule(dataStudioId);
  await seedRoleExclusions();
  await seedTemplates();
  console.log(`${TAG} Done.`);
}

run().catch((error) => {
  console.error(`${TAG} Fatal: ${error.message}`);
  process.exit(1);
});