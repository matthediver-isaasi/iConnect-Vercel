export function filterCountableEvents({
  rows,
  tenantId,
  isTenantAdmin = false,
  hasGlobalAttendeeAccess = false,
  memberGroupIds = new Set(),
  administeredGroupIds = new Set(),
}) {
  const memberships = memberGroupIds instanceof Set ? memberGroupIds : new Set(memberGroupIds || []);
  const administered = administeredGroupIds instanceof Set
    ? administeredGroupIds
    : new Set(administeredGroupIds || []);

  return (rows || []).filter((row) => {
    if (!row?.id || row.tenant_id !== tenantId) return false;
    if (isTenantAdmin) return true;
    if (row.member_group_id && administered.has(row.member_group_id)) return true;
    if (!hasGlobalAttendeeAccess) return false;
    if (!row.member_group_id || row.group_event_public === true) return true;
    return memberships.has(row.member_group_id);
  });
}