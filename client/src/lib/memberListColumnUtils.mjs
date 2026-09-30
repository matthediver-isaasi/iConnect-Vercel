// Merge schema additions into persisted column preferences without changing
// the order or visibility of columns already chosen by a member.
export const appendMissingColumns = (columns, defaultColumns) => {
  const current = Array.isArray(columns) ? columns : [];
  const existingIds = new Set(current.map((column) => column.id));
  const additions = defaultColumns.filter((column) => !existingIds.has(column.id));
  return additions.length > 0 ? [...current, ...additions] : current;
};

const compareText = (left, right) => {
  const insensitive = left.localeCompare(right, 'en', { sensitivity: 'base' });
  if (insensitive) return insensitive;
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

// Department relationships have no primary assignment. Consumers therefore
// always use the complete collection and impose the same stable name ordering.
export const normalizeMemberDepartments = (member) => {
  const departments = Array.isArray(member?.departments) ? member.departments : [];
  const seen = new Set();

  return departments
    .filter((department) => department && typeof department === 'object' && department.name)
    .filter((department) => {
      const key = department.id ? `id:${department.id}` : `name:${department.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice()
    .sort((left, right) => (
      compareText(String(left.name), String(right.name))
      || compareText(String(left.id || ''), String(right.id || ''))
    ));
};

export const formatMemberDepartments = (member, separator = ', ') => (
  normalizeMemberDepartments(member).map((department) => department.name).join(separator)
);

// A relationship join can produce more than one source row for a member.
// Collapse those rows while retaining the union of every Department collection.
export const uniqueMemberRows = (members) => {
  const byId = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    if (!member?.id) continue;
    const existing = byId.get(member.id);
    if (!existing) {
      byId.set(member.id, {
        ...member,
        departments: normalizeMemberDepartments(member),
      });
      continue;
    }
    existing.departments = normalizeMemberDepartments({
      departments: [...existing.departments, ...normalizeMemberDepartments(member)],
    });
  }
  return Array.from(byId.values());
};