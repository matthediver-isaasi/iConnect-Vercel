/**
 * Shared navigation-item tree helpers (Task #2527).
 *
 * NavigationItem rows form a tree via `parent_id`. These helpers are used by
 * the microsite Navigation tab (MicrositeManagement.jsx) and mirror the
 * hierarchy logic in NavigationManagement.jsx so the two managers behave the
 * same way (up to 3 levels: parent > child > grandchild, matching what the
 * public header renders).
 */

/** Max nesting depth the public header renders (0-indexed: 0,1,2 = 3 levels). */
export const MAX_NAV_DEPTH = 2;

/**
 * Build a sorted tree of nav items starting at `parentId`, optionally
 * restricted to one `location` (children always share their parent's
 * location). Items keep all their fields plus a `children` array.
 */
export function buildNavTree(items, { parentId = null, location = null } = {}) {
  return (items || [])
    .filter(
      (i) =>
        (i.parent_id || null) === (parentId || null) &&
        (location == null || i.location === location)
    )
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
    .map((i) => ({
      ...i,
      children: buildNavTree(items, { parentId: i.id, location }),
    }));
}

/** All descendants (children, grandchildren, …) of `parentId`, flattened. */
export function collectDescendants(items, parentId) {
  const direct = (items || []).filter((i) => i.parent_id === parentId);
  return direct.reduce(
    (acc, child) => [...acc, child, ...collectDescendants(items, child.id)],
    []
  );
}

/** True when `targetId` is `rootId` itself or anywhere inside its subtree. */
export function isInSubtree(items, rootId, targetId) {
  if (rootId === targetId) return true;
  return (items || [])
    .filter((i) => i.parent_id === rootId)
    .some((child) => isInSubtree(items, child.id, targetId));
}

/** Depth of an item in the tree (0 = top level). */
export function getItemDepth(items, item) {
  const byId = new Map((items || []).map((i) => [i.id, i]));
  let depth = 0;
  let cur = item;
  while (cur && cur.parent_id && depth <= 10) {
    depth += 1;
    cur = byId.get(cur.parent_id);
  }
  return depth;
}

/** "↳ " prefix per ancestor level, for parent-picker labels. */
export function getHierarchyPrefix(items, parentId) {
  if (!parentId) return "";
  const parent = (items || []).find((i) => i.id === parentId);
  if (!parent) return "↳ ";
  return getHierarchyPrefix(items, parent.parent_id) + "↳ ";
}
