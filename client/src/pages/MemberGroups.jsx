import React, { useState, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Users, Loader2 } from "lucide-react";
import { useMemberGroupSettings } from "@/hooks/useMemberGroupSettings";
import { createPageUrl } from "@/utils";
import MemberGroupCard from "@/components/member-groups/MemberGroupCard";
import { useMemberGroupCardsData } from "@/hooks/useMemberGroupCards";

export default function MemberGroupsPage() {
  const memberGroupData = useMemberGroupCardsData();
  const {
    isAuthenticated,
    authResolved,
    isAccessReady,
    accessRestricted,
    groups,
    dataError,
    isLoading: groupsLoading,
    assignmentByGroup,
    openVacancyCountByGroup,
    groupAdminIds,
  } = memberGroupData;
  const { featureName } = useMemberGroupSettings();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnlyJoined, setShowOnlyJoined] = useState(false);
  const [showAdminGroups, setShowAdminGroups] = useState(false);

  useEffect(() => {
    if (!authResolved) return;

    if (!isAuthenticated) {
      setAccessChecked(true);
      return;
    }

    if (isAccessReady) {
      if (accessRestricted) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [authResolved, isAuthenticated, isAccessReady, accessRestricted]);

  const visibleGroups = useMemo(() => {
    const onlyManaged = isAuthenticated && showAdminGroups;
    return groups
      .filter((g) => {
        if (onlyManaged) {
          return groupAdminIds.has(g.id);
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
  }, [groups, searchQuery, showOnlyJoined, showAdminGroups, isAuthenticated, assignmentByGroup, groupAdminIds]);

  const isLoading = !accessChecked || groupsLoading;

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

        {dataError ? (
          <Card>
            <CardContent className="p-12 text-center text-rose-600" role="alert">
              <p>Couldn&apos;t load member groups right now. Please try again.</p>
            </CardContent>
          </Card>
        ) : visibleGroups.length === 0 ? (
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
              return (
                <MemberGroupCard
                  key={group.id}
                  group={group}
                  isAuthenticated={isAuthenticated}
                  assignment={myAssignment}
                  isGroupAdmin={groupAdminIds.has(group.id)}
                  openVacancyCount={openVacancyCountByGroup[group.id] || 0}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
