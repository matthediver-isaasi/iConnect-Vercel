export function buildAssignmentRoleOptions(assignments) {
  const rolesByKey = new Map();

  for (const assignment of assignments) {
    const role = typeof assignment.group_role === 'string'
      ? assignment.group_role.trim().replace(/\s+/g, ' ')
      : '';
    if (!role) continue;

    const key = role.toLocaleLowerCase();
    const existing = rolesByKey.get(key);
    if (!existing || role.localeCompare(existing, undefined, { sensitivity: 'variant' }) < 0) {
      rolesByKey.set(key, role);
    }
  }

  return [...rolesByKey.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  );
}

export function assignmentMatchesRole(assignment, selectedRole) {
  if (selectedRole === null) return true;
  return assignment.group_role?.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    === selectedRole.toLocaleLowerCase();
}