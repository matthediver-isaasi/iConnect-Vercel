import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Users, UserPlus, Loader2, ImageIcon, Check, LogOut } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function MemberGroupsPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [leavingGroup, setLeavingGroup] = useState(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  const { data: myAssignments = [], isLoading: loadingAssignments } = useQuery({
    queryKey: ['member-group-assignments-self', memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.MemberGroupAssignment.filter({ member_id: memberInfo.id });
    },
    enabled: accessChecked && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const joinMutation = useMutation({
    mutationFn: async (group) => {
      if (!memberInfo?.id) {
        throw new Error('You must be signed in to join a group');
      }
      if (!group.default_self_join_role) {
        throw new Error('This group has no default role configured');
      }
      return base44.entities.MemberGroupAssignment.create({
        group_id: group.id,
        member_id: memberInfo.id,
        group_role: group.default_self_join_role,
      });
    },
    onSuccess: (_data, group) => {
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments-self', memberInfo?.id] });
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      toast.success(`You've joined "${group.name}"`);
    },
    onError: (error) => {
      toast.error('Failed to join group: ' + (error?.message || 'Unknown error'));
    }
  });

  const leaveMutation = useMutation({
    mutationFn: async (group) => {
      const assignment = myAssignments.find((a) => a.group_id === group.id);
      if (!assignment) {
        throw new Error('You are not a member of this group');
      }
      return base44.entities.MemberGroupAssignment.delete(assignment.id);
    },
    onSuccess: (_data, group) => {
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments-self', memberInfo?.id] });
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      toast.success(`You've left "${group.name}"`);
      setLeavingGroup(null);
    },
    onError: (error) => {
      toast.error('Failed to leave group: ' + (error?.message || 'Unknown error'));
    }
  });

  const joinedGroupIds = useMemo(
    () => new Set(myAssignments.map((a) => a.group_id)),
    [myAssignments]
  );

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

  const isLoading = !accessChecked || loadingGroups || loadingAssignments;

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
              const alreadyJoined = joinedGroupIds.has(group.id);
              const isPending =
                joinMutation.isPending && joinMutation.variables?.id === group.id;

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
                    {group.default_self_join_role && (
                      <div className="mb-3">
                        <span className="text-xs text-slate-500">You'll join as: </span>
                        <Badge className="bg-blue-100 text-blue-700 text-xs">
                          {group.default_self_join_role}
                        </Badge>
                      </div>
                    )}
                    <div className="mt-auto pt-3" onClick={(e) => e.stopPropagation()}>
                      {alreadyJoined ? (
                        <div className="flex flex-col gap-2">
                          <div
                            className="flex items-center justify-center text-sm text-slate-600"
                            data-testid={`text-joined-${group.id}`}
                          >
                            <Check className="w-4 h-4 mr-2 text-green-600" />
                            Already a member
                          </div>
                          <Button
                            variant="outline"
                            className="w-full"
                            onClick={(e) => {
                              e.stopPropagation();
                              setLeavingGroup(group);
                            }}
                            data-testid={`button-leave-${group.id}`}
                          >
                            <LogOut className="w-4 h-4 mr-2" />
                            Leave Group
                          </Button>
                        </div>
                      ) : (
                        <Button
                          className="w-full bg-blue-600 hover:bg-blue-700"
                          onClick={(e) => {
                            e.stopPropagation();
                            joinMutation.mutate(group);
                          }}
                          disabled={isPending || !memberInfo?.id || !group.default_self_join_role}
                          data-testid={`button-join-${group.id}`}
                        >
                          {isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <UserPlus className="w-4 h-4 mr-2" />
                          )}
                          Join Group
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

      <AlertDialog
        open={!!leavingGroup}
        onOpenChange={(open) => {
          if (!open && !leaveMutation.isPending) {
            setLeavingGroup(null);
          }
        }}
      >
        <AlertDialogContent data-testid="dialog-leave-group">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave Group</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to leave "{leavingGroup?.name}"? You can rejoin at any time
              while this group remains open for self-join.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={leaveMutation.isPending}
              data-testid="button-cancel-leave"
            >
              Stay in Group
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (leavingGroup) {
                  leaveMutation.mutate(leavingGroup);
                }
              }}
              disabled={leaveMutation.isPending}
              data-testid="button-confirm-leave"
            >
              {leaveMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4 mr-2" />
              )}
              Leave Group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
