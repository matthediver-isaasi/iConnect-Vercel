// Stable partition of already-filtered, already-sorted matches. Never mutates
// the source list or introduces records from outside the current selection.
export function pinnedResourcesFirst(resources) {
  const pinned = [];
  const ordinary = [];
  for (const resource of resources) {
    (resource.is_pinned === true ? pinned : ordinary).push(resource);
  }
  return [...pinned, ...ordinary];
}
