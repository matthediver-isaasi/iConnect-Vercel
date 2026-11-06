import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import LayoutContext from '../contexts/LayoutContext';
import { base44 } from '../api/base44Client';
import { memberRoleIdentityKey } from '../lib/memberSessionRole';
import { loadViewableCustomObjectPortalDestinations } from '../lib/portalMenuLinks';

const EMPTY = [];

// Keep existing prefixes: management-page invalidation must reach these reads.
// Session keys are verified in memory, never hydrated from localStorage.
export function portalNavigationScope({ authResolved, sessionValidated, memberInfo, sessionRoleSnapshot }) {
  const identity = memberRoleIdentityKey(sessionRoleSnapshot);
  const matches = memberInfo && identity === memberRoleIdentityKey({
    tenant_id: memberInfo.tenant_id, member_id: memberInfo.id, role_id: memberInfo.role_id,
  });
  return authResolved && sessionValidated && matches && sessionRoleSnapshot?.session_key
    ? [identity, sessionRoleSnapshot.session_key] : null;
}

export function usePortalNavigationScope() {
  return portalNavigationScope(useContext(LayoutContext));
}

export async function readNavigationRows(load, timeoutMs = 9000) {
  let timer;
  try {
    const rows = await Promise.race([
      load(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Navigation request timed out. Please retry.')), timeoutMs);
      }),
    ]);
    if (!Array.isArray(rows)) throw new Error('Invalid navigation response. Please retry.');
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export function usePortalNavigation(roleStatus) {
  const context = useContext(LayoutContext);
  const scope = portalNavigationScope(context);
  const options = {
    enabled: !!scope && roleStatus === 'ready',
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
  const menu = useQuery({
    ...options,
    queryKey: ['portal-menu', ...(scope || ['unverified'])],
    queryFn: () => readNavigationRows(() => base44.entities.PortalMenu.list({ sort: { display_order: 'asc' } })),
  });
  const hierarchy = useQuery({
    ...options,
    queryKey: ['role-access-items', ...(scope || ['unverified'])],
    queryFn: () => readNavigationRows(() => base44.entities.RoleAccessItem.list()),
  });
  const groups = useQuery({
    ...options,
    queryKey: ['member-group-assignments-self', ...(scope || ['unverified'])],
    queryFn: () => readNavigationRows(() => base44.entities.MemberGroupAssignment.filter({ member_id: context.memberInfo.id })),
  });
  const objects = useQuery({
    ...options,
    queryKey: ['custom-objects-for-portal-navigation', ...(scope || ['unverified'])],
    queryFn: () => readNavigationRows(() => loadViewableCustomObjectPortalDestinations()),
  });
  const queries = [menu, hierarchy, groups, objects];
  const pending = !scope || queries.some(query => query.isPending || query.isFetching);
  const failed = queries.find(query => query.isError);
  const status = roleStatus !== 'ready' ? roleStatus : pending ? 'loading' : failed ? 'error' : 'ready';
  return {
    status,
    error: failed?.error,
    retry: () => Promise.all(queries.filter(query => !query.isSuccess).map(query => query.refetch())),
    menu: scope ? menu.data || EMPTY : EMPTY,
    hierarchy: scope && hierarchy.isSuccess && !hierarchy.isFetching ? hierarchy.data : EMPTY,
    groups: scope ? groups.data || EMPTY : EMPTY,
    objects: scope ? objects.data || EMPTY : EMPTY,
    groupsFetched: !!scope && groups.isFetched,
    objectsFetched: !!scope && objects.isFetched,
  };
}
