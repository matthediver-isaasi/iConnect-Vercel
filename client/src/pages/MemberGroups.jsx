import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Users, Loader2, ImageIcon, ArrowRight, Wand2, Lock } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useMemberGroupSettings } from "@/hooks/useMemberGroupSettings";
import { createPageUrl } from "@/utils";
import { sanitizeRichText } from "@/components/canvas/blocks/sanitize";

export default function MemberGroupsPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { authResolved, sessionValidated } = useLayoutContext();
  const { featureName } = useMemberGroupSettings();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnlyJoined, setShowOnlyJoined] = useState(false);
  const [showAdminGroups, setShowAdminGroups] = useState(false);
  const navigate = useNavigate();

  const isAuthenticated = authResolved && sessionValidated && !!memberInfo?.id;

  useEffect(() => {
    if (!authResolved) return;

    if (!isAuthenticated) {
      setAccessChecked(true);
      return;
    }

    if (isAccessReady) {
      if (isFeatureExcluded('membership.member-group-access')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [authResolved, isAuthenticated, isAccessReady, isFeatureExcluded]);

  const { data: publicGroups = [], isLoading: publicGroupsLoading } = useQuery({
    queryKey: ['public-member-groups'],
    queryFn: () => publicClient.listMemberGroups(),
    enabled: authResolved && !isAuthenticated,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: authenticatedGroups = [], isLoading: authenticatedGroupsLoading } = useQuery({
    queryKey: ['member-groups-self-join'],
    queryFn: () => base44.entities.MemberGroup.list(),
    enabled: isAuthenticated && accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: openVacancies = [] } = useQuery({
    queryKey: ['member-groups-open-vacancies'],
    queryFn: () => base44.entities.Vacancy.filter({ status: 'open' }),
    enabled: isAuthenticated && accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: myAssignments = [] } = useQuery({
    queryKey: ['member-group-assignments-self', memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.MemberGroupAssignment.filter({ member_id: memberInfo.id });
    },
    enabled: isAuthenticated && accessChecked && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const groups = isAuthenticated ? authenticatedGroups : publicGroups;
  const loadingGroups = isAuthenticated ? authenticatedGroupsLoading : publicGroupsLoading;

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

  const isAdminOfGroup = useMemo(() => {
    const set = new Set();
    for (const a of myAssignments) {
      if (
        a.group_id &&
        a.is_group_admin === true &&
        (!a.expires_at || new Date(a.expires_at) > new Date())
      ) {
        set.add(a.group_id);
      }
    }
    return set;
  }, [myAssignments]);

  const visibleGroups = useMemo(() => {
    const onlyManaged = isAuthenticated && showAdminGroups;
    return groups
      .filter((g) => {
        if (onlyManaged) {
          return isAdminOfGroup.has(g.id);
        }
        return g.allow_self_join && g.is_active !== false;
      })
      .filter((g) => {
        if (!isAuthenticated || !showOnlyJoined) return true;
        return !!assignmentByGroup[g.id];
      })
      .filter((g) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          g.name?.toLowerCase().includes(q) ||
          (g.description || '').replace(/<[^>]*>/g, ' ').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [groups, searchQuery, showOnlyJoined, showAdminGroups, isAuthenticated, assignmentByGroup, isAdminOfGroup]);

  const handleGuestGroupClick = (groupId) => {
    const detailPath = createPageUrl('MemberGroupDetail');
    window.location.href = `/login?returnTo=${encodeURIComponent(detailPath)}&groupId=${encodeURIComponent(groupId)}`;
  };

  const isLoading = !accessChecked || loadingGroups;

  if (isLoading) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
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
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2" data-testid="text-page-title">
            {featureName || 'Member Groups'}
          </h1>
          <p className="text-slate-600">
            Browse and join groups that are open to all members
          </p>
        </div>

        {groups.filter((g) => g.allow_self_join && g.is_active !== false).length > 0 && (
          <Card className="mb-4">
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

        {isAuthenticated && (
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-3">
                  <Switch
                    id="toggle-only-joined"
                    checked={showOnlyJoined}
                    onCheckedChange={setShowOnlyJoined}
                    data-testid="toggle-only-joined"
                  />
                  <Label htmlFor="toggle-only-joined" className="cursor-pointer select-none text-sm">
                    Only groups I&apos;ve joined
                  </Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id="toggle-admin-groups"
                    checked={showAdminGroups}
                    onCheckedChange={setShowAdminGroups}
                    data-testid="toggle-admin-groups"
                  />
                  <Label htmlFor="toggle-admin-groups" className="cursor-pointer select-none text-sm">
                    Only groups I manage
                  </Label>
                </div>
              </div>
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
                  : showAdminGroups
                    ? "You don't manage any groups."
                    : showOnlyJoined
                      ? "You haven't joined any groups yet."
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

              const handleCardClick = () => {
                if (!isAuthenticated) {
                  handleGuestGroupClick(group.id);
                } else {
                  navigate(`${createPageUrl('MemberGroupDetail')}?id=${group.id}`);
                }
              };

              return (
                <Card
                  key={group.id}
                  className="overflow-hidden flex flex-col cursor-pointer hover-elevate"
                  onClick={handleCardClick}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleCardClick();
                    }
                  }}
                  data-testid={`card-group-${group.id}`}
                >
                  <div className="relative w-full aspect-[5/2] bg-slate-100">
                    {isAuthenticated && openVacancyCountByGroup[group.id] > 0 && (
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
                      <div
                        className="text-sm text-slate-600 mb-3 line-clamp-3 prose prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: sanitizeRichText(group.description) }}
                      />
                    )}
                    {isAuthenticated && isGroupAdmin && (
                      <div className="mb-3">
                        <Wand2
                          className="h-4 w-4 text-purple-700"
                          data-testid={`badge-group-admin-${group.id}`}
                        />
                      </div>
                    )}
                    {isAuthenticated && isJoined ? (
                      <div className="mb-3" data-testid={`text-joined-role-${group.id}`}>
                        <span className="text-xs text-slate-500">You have joined the group as </span>
                        <Badge className="bg-green-100 text-green-700 text-xs">
                          {myAssignment.group_role || group.default_self_join_role}
                        </Badge>
                      </div>
                    ) : (
                      isAuthenticated && group.default_self_join_role && (
                        <div className="mb-3" data-testid={`text-join-as-${group.id}`}>
                          <span className="text-xs text-slate-500">You'll join as: </span>
                          <Badge className="bg-blue-100 text-blue-700 text-xs">
                            {group.default_self_join_role}
                          </Badge>
                        </div>
                      )
                    )}
                    <div className="mt-auto pt-3" onClick={(e) => e.stopPropagation()}>
                      {!isAuthenticated ? (
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleGuestGroupClick(group.id);
                          }}
                          data-testid={`button-login-required-${group.id}`}
                        >
                          <Lock className="w-4 h-4 mr-2" />
                          Member only content - Click to login
                        </Button>
                      ) : (
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
                      )}
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
