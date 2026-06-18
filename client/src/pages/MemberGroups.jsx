import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Users, Loader2, ImageIcon, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function MemberGroupsPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('membership.member-group-access')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const { data: groups = [], isLoading: loadingGroups } = useQuery({
    queryKey: ['member-groups-self-join'],
    queryFn: () => base44.entities.MemberGroup.list(),
    enabled: accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: openVacancies = [] } = useQuery({
    queryKey: ['member-groups-open-vacancies'],
    queryFn: () => base44.entities.Vacancy.filter({ status: 'open' }),
    enabled: accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: myAssignments = [] } = useQuery({
    queryKey: ['member-group-assignments-self', memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.MemberGroupAssignment.filter({ member_id: memberInfo.id });
    },
    enabled: accessChecked && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const assignmentByGroup = useMemo(() => {
    const map = {};
    for (const a of myAssignments) {
      if (a.group_id && !map[a.group_id]) {
        map[a.group_id] = a;
      }
    }
    return map;
  }, [myAssignments]);

  const openVacancyCountByGroup = useMemo(() => {
    const map = {};
    for (const v of openVacancies) {
      if (v.member_group_id && v.status !== 'closed') {
        map[v.member_group_id] = (map[v.member_group_id] || 0) + 1;
      }
    }
    return map;
  }, [openVacancies]);

  const visibleGroups = useMemo(() => {
    return groups
      .filter((g) => g.allow_self_join && g.is_active !== false)
      .filter((g) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          g.name?.toLowerCase().includes(q) ||
          (g.description || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [groups, searchQuery]);

  const isLoading = !accessChecked || loadingGroups;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-600">Loading member groups...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2" data-testid="text-page-title">
            Member Groups
          </h1>
          <p className="text-slate-600">
            Browse and join groups that are open to all members
          </p>
        </div>

        {groups.filter((g) => g.allow_self_join && g.is_active !== false).length > 0 && (
          <Card className="mb-6">
            <CardContent className="p-4">
              <Input
                placeholder="Search groups..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="input-search-groups"
              />
            </CardContent>
          </Card>
        )}

        {visibleGroups.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Groups Available</h3>
              <p className="text-slate-600">
                {searchQuery
                  ? 'No groups match your search criteria'
                  : 'There are no member groups open for self-join right now.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleGroups.map((group) => {
              const myAssignment = assignmentByGroup[group.id];
              const isJoined = !!myAssignment;
              const isGroupAdmin =
                !!myAssignment &&
                myAssignment.is_group_admin === true &&
                (!myAssignment.expires_at ||
                  new Date(myAssignment.expires_at).toISOString() > new Date().toISOString());
              return (
                <Card
                  key={group.id}
                  className="overflow-hidden flex flex-col cursor-pointer hover-elevate"
                  onClick={() => navigate(`${createPageUrl('MemberGroupDetail')}?id=${group.id}`)}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`${createPageUrl('MemberGroupDetail')}?id=${group.id}`);
                    }
                  }}
                  data-testid={`card-group-${group.id}`}
                >
                  <div className="relative w-full h-40 bg-slate-100">
                    {openVacancyCountByGroup[group.id] > 0 && (
                      <div className="absolute top-2 right-2 z-10">
                        <Badge
                          className="bg-green-100 text-green-700 text-xs"
                          data-testid={`badge-open-vacancies-${group.id}`}
                        >
                          {openVacancyCountByGroup[group.id] > 1
                            ? `${openVacancyCountByGroup[group.id]} open vacancies`
                            : 'Open vacancies'}
                        </Badge>
                      </div>
                    )}
                    {group.header_image_url ? (
                      <img
                        src={group.header_image_url}
                        alt={group.name}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.target.onerror = null;
                          e.target.style.display = 'none';
                        }}
                        data-testid={`img-group-header-${group.id}`}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-300">
                        <ImageIcon className="w-12 h-12" />
                      </div>
                    )}
                  </div>
                  <CardContent className="p-4 flex flex-col flex-1">
                    <h3
                      className="text-lg font-semibold text-slate-900 mb-1"
                      data-testid={`text-group-name-${group.id}`}
                    >
                      {group.name}
                    </h3>
                    {group.description && (
                      <p className="text-sm text-slate-600 mb-3 line-clamp-3">
                        {group.description}
                      </p>
                    )}
                    {isGroupAdmin && (
                      <div className="mb-3">
                        <Badge
                          className="bg-purple-100 text-purple-700 text-xs"
                          data-testid={`badge-group-admin-${group.id}`}
                        >
                          Group admin
                        </Badge>
                      </div>
                    )}
                    {isJoined ? (
                      <div className="mb-3" data-testid={`text-joined-role-${group.id}`}>
                        <span className="text-xs text-slate-500">You have joined the group as </span>
                        <Badge className="bg-green-100 text-green-700 text-xs">
                          {myAssignment.group_role || group.default_self_join_role}
                        </Badge>
                      </div>
                    ) : (
                      group.default_self_join_role && (
                        <div className="mb-3" data-testid={`text-join-as-${group.id}`}>
                          <span className="text-xs text-slate-500">You'll join as: </span>
                          <Badge className="bg-blue-100 text-blue-700 text-xs">
                            {group.default_self_join_role}
                          </Badge>
                        </div>
                      )
                    )}
                    <div className="mt-auto pt-3" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`${createPageUrl('MemberGroupDetail')}?id=${group.id}`);
                        }}
                        data-testid={`button-find-out-more-${group.id}`}
                      >
                        Find out more
                        <ArrowRight className="w-4 h-4 ml-2" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
