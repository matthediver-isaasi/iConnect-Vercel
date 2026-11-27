// Stable partition of already-filtered, already-sorted matches. Never mutates
// the source list or introduces records from outside the current selection.
export function pinnedResourcesFirst(resources) {
  const pinned = [];
  const ordinary = [];
  for (const resource of resources) {
    (!resource.member_group_id && resource.is_pinned === true ? pinned : ordinary).push(resource);
  }
  return [...pinned, ...ordinary];
}

// Group editorial choices never promote linked tenant cards or another group.
export function groupPinnedResourcesFirst(resources, groupId) {
  const pinned = [];
  const ordinary = [];
  for (const resource of resources) {
    (resource.member_group_id === groupId && resource.is_group_pinned === true
      ? pinned : ordinary).push(resource);
  }
  return [...pinned, ...ordinary];
}
