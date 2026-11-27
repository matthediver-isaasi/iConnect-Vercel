import { isResourceReleased } from '../../shared/resourceRelease.js';
import { fetchCategoriesWithAccess, computeHiddenSubcategories, isResourceHiddenByCategories } from './resourceCategoryAccess.js';

export const GROUP_PUBLIC_COLUMNS = 'id,name,description,who_is_it_for,about_the_group,header_image_url,terms_of_reference,is_public,is_active,forum_enabled,forum_enabled_roles,resource_subcategories,events_enabled,complex_events_enabled';
export function guestGroupForumEligible(group) {
  return group.forum_enabled === true && (group.forum_enabled_roles == null
    || (Array.isArray(group.forum_enabled_roles) && group.forum_enabled_roles.length === 0));
}
export async function readRows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
export async function readPublicGroup(db, tenantId, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await readRows(db.from('member_group').select(GROUP_PUBLIC_COLUMNS)
    .eq('tenant_id', tenantId).eq('id', id).eq('is_public', true).eq('is_active', true).limit(1)))[0] || null;
}
export function resourceBelongsToGroup(resource, group) {
  return resource.member_group_id === group.id || (!resource.member_group_id
    && (resource.subcategories || []).some(s => (group.resource_subcategories || []).includes(s)));
}
export function guestResourceEligible(resource, group, hidden, now = Date.now()) {
  return resource.is_public === true && resource.status === 'active' && resourceBelongsToGroup(resource, group)
    && isResourceReleased(resource, now)
    && !(resource.allowed_role_ids?.length)
    && !(resource.linked_events?.length)
    && !isResourceHiddenByCategories(resource, hidden);
}
export async function readGroupResource(db, tenantId, group, id) {
  const resource = (await readRows(db.from('resource').select('*')
    .eq('tenant_id', tenantId).eq('id', id).limit(1)))[0];
  if (!resource) return null;
  const hidden = computeHiddenSubcategories(await fetchCategoriesWithAccess(db, tenantId), { isGuest: true });
  return guestResourceEligible(resource, group, hidden) ? resource : null;
}
export function projectGroupResource(resource) {
  // Never expose a private storage locator, role/category rules, or form metadata.
  return {
    ...Object.fromEntries(['id', 'title', 'description', 'image_url', 'resource_type', 'author_name']
      .map(key => [key, resource[key] ?? null])),
    is_group_pinned: !!resource.member_group_id && resource.is_group_pinned === true,
  };
}
export function persistedResourceStorageTarget(target, tenantId, storageOrigin) {
  if (typeof target !== 'string') return null;
  let bucket, path;
  if (target.startsWith('/api/storage/secure-url?')) {
    const url = new URL(target, 'https://local.invalid');
    bucket = url.searchParams.get('bucket') || 'private-uploads';
    path = url.searchParams.get('path');
  } else {
    try {
      const url = new URL(target);
      if (!storageOrigin || url.origin !== new URL(storageOrigin).origin) return null;
      const match = url.pathname.match(/^\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
      if (!match) return null;
      bucket = match[1];
      path = decodeURIComponent(match[2]);
    } catch { return null; }
  }
  if (!['private-uploads', 'public-assets'].includes(bucket) || !path?.startsWith(`${tenantId}/`)
    || path.split('/').some(p => !p || p === '.' || p === '..') || /[\\\0]/.test(path)) return null;
  return { bucket, path };
}
export function guestForumVisible(row) {
  return !!row && row.is_hidden !== true && row.is_deleted !== true;
}

export async function authorizedResourceStorageTarget(db, resource, tenantId, group, storageOrigin) {
  if (resource.resource_type !== 'download') return null;
  const stored = persistedResourceStorageTarget(resource.target_url, tenantId, storageOrigin);
  // General resource uploads are the only storage namespace this publication
  // consent covers. Never sign gallery, opportunity, note, form or other files.
  if (!stored || !stored.path.startsWith(`${tenantId}/uploads/`)
    || stored.path.split('/').length !== 3) return null;
  const files = await readRows(db.from('file_repository').select('id,folder_id')
    .eq('tenant_id', tenantId).eq('bucket', stored.bucket).eq('storage_path', stored.path)
    .eq('file_url', resource.target_url).limit(2));
  if (files.length !== 1) return null;
  if (files[0].folder_id) {
    const folder = (await readRows(db.from('file_repository_folder').select('id,member_group_id')
      .eq('tenant_id', tenantId).eq('id', files[0].folder_id).limit(1)))[0];
    if (!folder || (folder.member_group_id && folder.member_group_id !== group.id)) return null;
  }
  // Protect legacy records whose independently governed objects were stored in
  // the generic uploads namespace before dedicated folders were introduced.
  for (const table of ['gallery_photo', 'opportunity_document']) {
    const protectedFiles = await readRows(db.from(table).select('id').eq('tenant_id', tenantId)
      .eq('bucket', stored.bucket).eq('storage_path', stored.path).limit(1));
    if (protectedFiles.length) return null;
  }
  return stored;
}
