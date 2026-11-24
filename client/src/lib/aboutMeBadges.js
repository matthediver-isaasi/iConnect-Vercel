export function mergeLibraryBadges(groupRoleBadges = [], directBadges = []) {
  const merged = [];
  const positions = new Map();
  for (const badge of [...groupRoleBadges, ...directBadges]) {
    if (!badge?.id) continue;
    if (positions.has(badge.id)) {
      const index = positions.get(badge.id);
      merged[index] = { ...merged[index], ...badge };
    } else {
      positions.set(badge.id, merged.length);
      merged.push(badge);
    }
  }
  return merged;
}