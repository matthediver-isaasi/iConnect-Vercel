import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import LayoutContext from '../contexts/LayoutContext';
import {
  MEMBER_SESSION_ROLE_TIMEOUT_MS,
  memberRoleIdentityKey,
} from '../lib/memberSessionRole';

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Navigation role request timed out.')), timeoutMs);
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function useSessionMemberRole() {
  const {
    authResolved,
    sessionValidated,
    memberInfo,
    sessionRoleSnapshot,
    retrySessionRole,
  } = useContext(LayoutContext);
  const isLegacy = sessionRoleSnapshot?.status === 'legacy';
  const isTrustedReady = sessionRoleSnapshot?.status === 'ready';
  const identityKey = memberRoleIdentityKey(sessionRoleSnapshot);

  const roleQuery = useQuery({
    // Keep the historical prefix so Role Management's existing invalidations
    // refresh the active role. The session suffix prevents an old session's
    // cached permissions from flashing after an account switch.
    queryKey: ['memberRole', 'validated-session-v3', identityKey, sessionRoleSnapshot?.session_key],
    enabled: authResolved && sessionValidated && (isLegacy || isTrustedReady)
      && !!sessionRoleSnapshot?.role_id,
    retry: false,
    // A legacy result is fresh for this validated session epoch too. Otherwise
    // each newly mounted useMemberAccess observer refetches the stale query,
    // temporarily fails closed, unmounts its page, then repeats forever.
    // Explicit memberRole invalidation still marks/refetches this active query.
    staleTime: Infinity,
    gcTime: 0,
    initialData: isTrustedReady ? sessionRoleSnapshot.role : undefined,
    queryFn: async () => {
      const role = await withTimeout(
        base44.entities.Role.get(sessionRoleSnapshot.role_id),
        MEMBER_SESSION_ROLE_TIMEOUT_MS,
      );
      if (!role || role.id !== sessionRoleSnapshot.role_id
        || (role.tenant_id && role.tenant_id !== sessionRoleSnapshot.tenant_id)) {
        throw new Error('The navigation role response was invalid.');
      }
      return role;
    },
  });

  if (!authResolved) {
    return {
      memberRole: null,
      roleStatus: 'loading',
      roleError: null,
      retryRole: retrySessionRole,
    };
  }

  if (!sessionValidated || !memberInfo) {
    return {
      memberRole: null,
      roleStatus: memberInfo ? 'error' : 'missing',
      roleError: memberInfo ? new Error('Your session could not be validated.') : null,
      retryRole: retrySessionRole,
    };
  }

  if (!sessionRoleSnapshot) {
    return {
      memberRole: null,
      roleStatus: 'error',
      roleError: new Error('Your navigation role has not been validated.'),
      retryRole: retrySessionRole,
    };
  }

  if (sessionRoleSnapshot.status === 'ready') {
    if (roleQuery.isFetching) {
      return { memberRole: null, roleStatus: 'loading', roleError: null, retryRole: roleQuery.refetch };
    }
    if (roleQuery.isError) {
      return {
        memberRole: null,
        roleStatus: 'error',
        roleError: roleQuery.error,
        retryRole: roleQuery.refetch,
      };
    }
    return {
      memberRole: roleQuery.data || sessionRoleSnapshot.role,
      roleStatus: 'ready',
      roleError: null,
      retryRole: roleQuery.refetch,
    };
  }

  if (isLegacy && sessionRoleSnapshot.role_id) {
    if (roleQuery.isPending || roleQuery.isFetching) {
      return { memberRole: null, roleStatus: 'loading', roleError: null, retryRole: roleQuery.refetch };
    }
    if (roleQuery.isError) {
      return {
        memberRole: null,
        roleStatus: 'error',
        roleError: roleQuery.error,
        retryRole: roleQuery.refetch,
      };
    }
    if (roleQuery.data) {
      return { memberRole: roleQuery.data, roleStatus: 'ready', roleError: null, retryRole: roleQuery.refetch };
    }
  }

  return {
    memberRole: null,
    roleStatus: sessionRoleSnapshot.status === 'legacy' ? 'missing' : sessionRoleSnapshot.status,
    roleError: sessionRoleSnapshot.error || null,
    retryRole: retrySessionRole,
  };
}