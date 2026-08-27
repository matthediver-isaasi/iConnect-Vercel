// Merge schema additions into persisted column preferences without changing
// the order or visibility of columns already chosen by a member.
export const appendMissingColumns = (columns, defaultColumns) => {
  const current = Array.isArray(columns) ? columns : [];
  const existingIds = new Set(current.map((column) => column.id));
  const additions = defaultColumns.filter((column) => !existingIds.has(column.id));
  return additions.length > 0 ? [...current, ...additions] : current;
};