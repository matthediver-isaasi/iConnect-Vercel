export const MEMBER_SESSION_ROLE_TIMEOUT_MS = 9000;
let sessionRoleEpoch = 0;

export function createSessionRoleKey(scope = '') {
  sessionRoleEpoch += 1;
  return `${scope}:${sessionRoleEpoch}`;
}

export function stripTrustedMemberProjections(member) {
  if (!member || typeof member !== 'object') return member;
  const { canvasMemberSnapshot, sessionRole, ...persistableMember } = member;
  return persistableMember;
}

export function normalizeSessionRoleSnapshot(sessionRole, member, sessionKey) {
  if (!member?.id) return null;

  const identity = {
    member_id: member.id,
    tenant_id: member.tenant_id || null,
    role_id: member.role_id || null,
    session_key: sessionKey,
  };

  // Older servers and test fixtures do not include sessionRole. They may use
  // the legacy Role endpoint, but only after the surrounding session validates.
  if (sessionRole === undefined) return { status: 'legacy', ...identity };

  const status = sessionRole?.status;
  const identityMatches = sessionRole?.member_id === identity.member_id
    && (sessionRole?.tenant_id || null) === identity.tenant_id
    && (sessionRole?.role_id || null) === identity.role_id;

  if (!identityMatches || !['ready', 'missing', 'error'].includes(status)) {
    return { status: 'error', ...identity, error: 'The navigation role response was invalid.' };
  }

  if (status === 'ready') {
    if (!sessionRole.role || sessionRole.role.id !== identity.role_id
      || (sessionRole.role.tenant_id && sessionRole.role.tenant_id !== identity.tenant_id)) {
      return { status: 'error', ...identity, error: 'The navigation role response was invalid.' };
    }
    return { status: 'ready', ...identity, role: sessionRole.role };
  }

  return {
    status,
    ...identity,
    error: status === 'error' ? 'The navigation role could not be loaded.' : undefined,
  };
}

export function memberRoleIdentityKey(snapshot) {
  if (!snapshot) return 'unresolved';
  return [snapshot.tenant_id || '', snapshot.member_id || '', snapshot.role_id || ''].join(':');
}