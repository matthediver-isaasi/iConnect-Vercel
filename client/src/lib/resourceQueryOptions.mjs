// Management is an explicit server-authorized scope, never the browsing default.
export function resourceQueryOptions({ management = false, groupId } = {}) {
  return {
    ...(groupId ? { filter: { member_group_id: groupId } } : {}),
    ...(management ? { queryParams: { resource_context: 'management' } } : {}),
  };
}

export const RESOURCE_READ_CACHE_KEYS = [
  'resources', 'public-resources', 'authenticated-resources',
  'member-group-resources', 'member-group-linked-resources',
  'public-resources-showcase', 'public-resources-showcase-latest',
  'public-showcase-resources', 'resources-list', 'showcase-editor-items',
  'embed-resource', 'single-resource',
];