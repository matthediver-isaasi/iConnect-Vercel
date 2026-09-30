export function isInviteTemplateResolutionPending({
  hasRoleId,
  rolesPending,
  rolesFetching,
  inviteTemplateId,
  templatePending,
  templateFetching,
}) {
  const roleResolutionPending =
    hasRoleId && (rolesPending || rolesFetching);
  const templateResolutionPending =
    !!inviteTemplateId && (templatePending || templateFetching);

  return roleResolutionPending || templateResolutionPending;
}

export function shouldInitializeInviteTemplate({
  open,
  initialized,
  resolutionPending,
}) {
  return open && !initialized && !resolutionPending;
}