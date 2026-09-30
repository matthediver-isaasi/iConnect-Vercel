export function mergeLibraryBadges(groupRoleBadges = [], directBadges = []) {
  const merged = [];
  const seen = new Set();
  for (const badge of [...groupRoleBadges, ...directBadges]) {
    if (!badge?.id || seen.has(badge.id)) continue;
    seen.add(badge.id);
    merged.push(badge);
  }
  return merged;
}