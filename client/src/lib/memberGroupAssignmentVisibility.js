// Match group access boundaries: the expiry instant itself is expired.
// Missing or unparseable legacy values remain visible for administrator repair.
export function isGroupAssignmentExpired(assignment, now = Date.now()) {
  if (!assignment?.expires_at) return false;
  const expiry = new Date(assignment.expires_at).getTime();
  return Number.isFinite(expiry) && expiry <= Number(now);
}

export function visibleGroupAssignments(assignments, showExpired = true, now = Date.now()) {
  return showExpired
    ? assignments
    : assignments.filter((assignment) => !isGroupAssignmentExpired(assignment, now));
}