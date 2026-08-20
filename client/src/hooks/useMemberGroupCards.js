import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { publicClient } from '@/api/publicClient';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { resolveMemberGroupCardsAccess } from '@/lib/memberGroupCards';

export function useMemberGroupCardsData() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { authResolved, sessionValidated } = useLayoutContext();
  const featureExcluded = authResolved
    && sessionValidated
    && !!memberInfo?.id
    && isAccessReady
    && isFeatureExcluded('membership.member-group-access');
  const {
    isAuthenticated,
    accessRestricted,
    shouldLoadPublicData,
    shouldLoadAuthenticatedData,
  } = resolveMemberGroupCardsAccess({
    authResolved,
    sessionValidated,
    memberId: memberInfo?.id,
    isAccessReady,
    featureExcluded,
  });

  const publicGroupsQuery = useQuery({
    queryKey: ['public-member-groups'],
    queryFn: () => publicClient.listMemberGroups(),
    enabled: shouldLoadPublicData,
    staleTime: 0,
    refetchOnMount: true,
  });

  const authenticatedGroupsQuery = useQuery({
    queryKey: ['member-groups-self-join'],
    queryFn: () => base44.entities.MemberGroup.list(),
    enabled: shouldLoadAuthenticatedData,
    staleTime: 0,
    refetchOnMount: true,
  });

  const vacanciesQuery = useQuery({
    queryKey: ['member-groups-open-vacancies'],
    queryFn: () => base44.entities.Vacancy.filter({ status: 'open' }),
    enabled: shouldLoadAuthenticatedData,
    staleTime: 0,
    refetchOnMount: true,
  });

  const assignmentsQuery = useQuery({
    queryKey: ['member-group-assignments-self', memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.MemberGroupAssignment.filter({ member_id: memberInfo.id });
    },
    enabled: shouldLoadAuthenticatedData && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const groups = isAuthenticated
    ? (authenticatedGroupsQuery.data || [])
    : (publicGroupsQuery.data || []);
  const dataError = isAuthenticated
    ? (authenticatedGroupsQuery.error || assignmentsQuery.error || vacanciesQuery.error)
    : publicGroupsQuery.error;
  const dataLoading = isAuthenticated
    ? (
      authenticatedGroupsQuery.isLoading
      || assignmentsQuery.isLoading
      || vacanciesQuery.isLoading
    )
    : publicGroupsQuery.isLoading;
  const assignments = assignmentsQuery.data || [];
  const vacancies = vacanciesQuery.data || [];

  const assignmentByGroup = useMemo(() => {
    const byGroup = {};
    for (const assignment of assignments) {
      if (assignment.group_id && !byGroup[assignment.group_id]) {
        byGroup[assignment.group_id] = assignment;
      }
    }
    return byGroup;
  }, [assignments]);

  const openVacancyCountByGroup = useMemo(() => {
    const byGroup = {};
    for (const vacancy of vacancies) {
      if (vacancy.member_group_id && vacancy.status !== 'closed') {
        byGroup[vacancy.member_group_id] = (byGroup[vacancy.member_group_id] || 0) + 1;
      }
    }
    return byGroup;
  }, [vacancies]);

  const groupAdminIds = useMemo(() => {
    const ids = new Set();
    for (const assignment of assignments) {
      if (
        assignment.group_id
        && assignment.is_group_admin === true
        && (!assignment.expires_at || new Date(assignment.expires_at) > new Date())
      ) {
        ids.add(assignment.group_id);
      }
    }
    return ids;
  }, [assignments]);

  return {
    memberInfo,
    isAuthenticated,
    authResolved,
    isAccessReady,
    accessRestricted,
    groups,
    dataError,
    isLoading: !authResolved || (isAuthenticated && (!isAccessReady || dataLoading)) || dataLoading,
    assignmentByGroup,
    openVacancyCountByGroup,
    groupAdminIds,
  };
}