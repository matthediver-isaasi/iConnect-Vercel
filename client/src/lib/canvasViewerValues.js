export const EMPTY_CANVAS_MEMBER_VALUES = Object.freeze({});

// A request lease closes both on navigation/unmount and on synchronous account
// invalidation (logout/profile reload/cross-tab storage), before React effects
// get a chance to run. In particular, a late parsed /auth/me body cannot commit.
export function createViewerRequestLease(generationRef) {
  const generation = ++generationRef.current;
  let cancelled = false;
  return {
    isCurrent: () => !cancelled && generation === generationRef.current,
    cancel: () => { cancelled = true; },
  };
}

export function canvasSnapshotMatchesMember(snapshot, member) {
  return !!(snapshot?.memberId && snapshot?.tenantId && member?.id && member?.tenant_id
    && String(snapshot.memberId) === String(member.id)
    && String(snapshot.tenantId) === String(member.tenant_id)
    && String(snapshot.organizationId || '') === String(member.organization_id || ''));
}

export function getCanvasMemberValues({ snapshot, member, sessionValidated, authResolved }) {
  if (!sessionValidated || !authResolved || !canvasSnapshotMatchesMember(snapshot, member)) {
    return EMPTY_CANVAS_MEMBER_VALUES;
  }
  const values = {};
  for (const key of ['member.first_name', 'member.last_name', 'member.job_title', 'member.organization.name']) {
    values[key] = typeof snapshot.values?.[key] === 'string' ? snapshot.values[key] : '';
  }
  return values;
}