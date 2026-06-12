import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Users,
  UserPlus,
  Loader2,
  ImageIcon,
  Check,
  LogOut,
  ArrowLeft,
  Search,
  ChevronLeft,
  ChevronRight,
  Crown,
  Linkedin,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import MemberProfileModal from "@/components/MemberProfileModal";
import DOMPurify from "dompurify";

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MEMBERS_PER_PAGE = 24;

function getMemberDisplay(member) {
  const first = (member.first_name || "").trim();
  const last = (member.last_name || "").trim();
  const anonymise = member.show_in_directory === false;
  if (anonymise) {
    const lastInitial = last ? `${last[0].toUpperCase()}.` : "";
    const displayName = [first, lastInitial].filter(Boolean).join(" ") || "Anonymous member";
    return { displayName, showAvatarImage: false, anonymised: true };
  }
  const displayName = [first, last].filter(Boolean).join(" ") || "Unknown member";
  return { displayName, showAvatarImage: true, anonymised: false };
}

export default function MemberGroupDetailPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const groupId = searchParams.get("id");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("membership.member-group-access")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const {
    data: group,
    isLoading: loadingGroup,
    isError: groupError,
  } = useQuery({
    queryKey: ["member-group", groupId],
    queryFn: () => base44.entities.MemberGroup.get(groupId),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: groupAssignments = [], isLoading: loadingAssignments } = useQuery({
    queryKey: ["member-group-assignments-group", groupId],
    queryFn: () => base44.entities.MemberGroupAssignment.filter({ group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: myAssignments = [] } = useQuery({
    queryKey: ["member-group-assignments-self", memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.MemberGroupAssignment.filter({ member_id: memberInfo.id });
    },
    enabled: accessChecked && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const memberIds = useMemo(
    () => groupAssignments.filter((a) => a.member_id).map((a) => a.member_id),
    [groupAssignments]
  );

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ["member-group-members", groupId, memberIds.join(",")],
    queryFn: async () => {
      if (memberIds.length === 0) return [];
      const results = await Promise.all(
        memberIds.map((id) =>
          base44.entities.Member.get(id).catch(() => null)
        )
      );
      return results.filter(Boolean);
    },
    enabled: accessChecked && memberIds.length > 0,
    staleTime: 0,
  });

  const joinMutation = useMutation({
    mutationFn: async () => {
      if (!memberInfo?.id) throw new Error("You must be signed in to join a group");
      if (!group?.default_self_join_role) {
        throw new Error("This group has no default role configured");
      }
      const payload = {
        group_id: group.id,
        member_id: memberInfo.id,
        group_role: group.default_self_join_role,
      };
      if (hasTermsOfReference) {
        payload.terms_agreed = true;
      }
      return base44.entities.MemberGroupAssignment.create(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-self", memberInfo?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["member-group-assignments"] });
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-group", groupId],
      });
      setShowTerms(false);
      setAgreedToTerms(false);
      toast.success(`You've joined "${group?.name}"`);
    },
    onError: (error) => {
      toast.error("Failed to join group: " + (error?.message || "Unknown error"));
    },
  });

  const leaveMutation = useMutation({
    mutationFn: async () => {
      const assignment = myAssignments.find((a) => a.group_id === group?.id);
      if (!assignment) throw new Error("You are not a member of this group");
      return base44.entities.MemberGroupAssignment.delete(assignment.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-self", memberInfo?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["member-group-assignments"] });
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-group", groupId],
      });
      toast.success(`You've left "${group?.name}"`);
      setConfirmLeave(false);
    },
    onError: (error) => {
      toast.error("Failed to leave group: " + (error?.message || "Unknown error"));
    },
  });

  const isJoined = useMemo(
    () => myAssignments.some((a) => a.group_id === groupId),
    [myAssignments, groupId]
  );

  const hasTermsOfReference = useMemo(() => {
    const raw = group?.terms_of_reference;
    if (!raw) return false;
    const text = raw
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;|\u00A0/g, " ")
      .trim();
    return text.length > 0;
  }, [group?.terms_of_reference]);

  const [memberSearch, setMemberSearch] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [selectedMemberId, setSelectedMemberId] = useState(null);

  const memberRoleByMemberId = useMemo(() => {
    const map = new Map();
    for (const a of groupAssignments) {
      if (a.member_id && a.group_role) map.set(a.member_id, a.group_role);
    }
    return map;
  }, [groupAssignments]);

  const sortedMembers = useMemo(() => {
    return members
      .map((m) => ({ ...m, __display: getMemberDisplay(m) }))
      .sort((a, b) => a.__display.displayName.localeCompare(b.__display.displayName));
  }, [members]);

  const leadershipRoleSet = useMemo(
    () => new Set(Array.isArray(group?.leadership_roles) ? group.leadership_roles : []),
    [group]
  );

  const leadershipMembers = useMemo(() => {
    if (leadershipRoleSet.size === 0) return [];
    return sortedMembers
      .map((m) => ({ ...m, __role: memberRoleByMemberId.get(m.id) || null }))
      .filter((m) => m.__role && leadershipRoleSet.has(m.__role));
  }, [sortedMembers, memberRoleByMemberId, leadershipRoleSet]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return sortedMembers;
    return sortedMembers.filter((m) =>
      m.__display.displayName.toLowerCase().includes(q)
    );
  }, [sortedMembers, memberSearch]);

  useEffect(() => {
    setMemberPage(1);
  }, [memberSearch, groupId]);

  const totalPages = Math.max(1, Math.ceil(filteredMembers.length / MEMBERS_PER_PAGE));
  const currentPage = Math.min(memberPage, totalPages);
  const pagedMembers = useMemo(() => {
    const start = (currentPage - 1) * MEMBERS_PER_PAGE;
    return filteredMembers.slice(start, start + MEMBERS_PER_PAGE);
  }, [filteredMembers, currentPage]);

  const isLoading =
    !accessChecked || loadingGroup || loadingAssignments || loadingMembers;

  if (!groupId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              Group not specified
            </h3>
            <p className="text-slate-600 mb-4">No group id was provided.</p>
            <Link to={createPageUrl("MemberGroups")}>
              <Button variant="outline" data-testid="link-back-groups">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to Member Groups
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-600">Loading group...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const groupUnavailable =
    !group || groupError || !group.allow_self_join || group.is_active === false;

  if (groupUnavailable) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              Group not available
            </h3>
            <p className="text-slate-600 mb-4">
              This group cannot be viewed. It may have been removed or is not open
              for self-join.
            </p>
            <Link to={createPageUrl("MemberGroups")}>
              <Button variant="outline" data-testid="link-back-groups">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to Member Groups
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-4">
          <Link to={createPageUrl("MemberGroups")}>
            <Button variant="ghost" size="sm" data-testid="link-back-groups">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Member Groups
            </Button>
          </Link>
        </div>

        <Card className="overflow-hidden mb-6" data-testid={`card-group-detail-${group.id}`}>
          <div className="relative w-full h-56 md:h-64 bg-slate-100">
            {group.header_image_url ? (
              <img
                src={group.header_image_url}
                alt={group.name}
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.target.onerror = null;
                  e.target.style.display = "none";
                }}
                data-testid={`img-group-header-${group.id}`}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-300">
                <ImageIcon className="w-16 h-16" />
              </div>
            )}
          </div>
          <CardContent className="p-6">
            <h1
              className="text-2xl md:text-3xl font-bold text-slate-900 mb-2"
              data-testid="text-group-name"
            >
              {group.name}
            </h1>
            {group.description && (
              <p
                className="text-slate-700 whitespace-pre-wrap mb-4"
                data-testid="text-group-description"
              >
                {group.description}
              </p>
            )}
            {group.linkedin_url && (
              <a
                href={group.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mb-4 font-medium"
                data-testid="link-group-linkedin"
              >
                <Linkedin className="w-4 h-4" />
                LinkedIn
              </a>
            )}
            {group.default_self_join_role && !isJoined && (
              <div className="mb-4">
                <span className="text-sm text-slate-500">You'll join as: </span>
                <Badge className="bg-blue-100 text-blue-700">
                  {group.default_self_join_role}
                </Badge>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {isJoined ? (
                <>
                  <div
                    className="inline-flex items-center text-sm text-slate-600 px-3"
                    data-testid="text-joined-status"
                  >
                    <Check className="w-4 h-4 mr-2 text-green-600" />
                    Already a member
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setConfirmLeave(true)}
                    data-testid="button-leave-group"
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    Leave Group
                  </Button>
                </>
              ) : (
                <Button
                  className="bg-blue-600 hover:bg-blue-700"
                  onClick={() => {
                    if (hasTermsOfReference) {
                      setAgreedToTerms(false);
                      setShowTerms(true);
                    } else {
                      joinMutation.mutate();
                    }
                  }}
                  disabled={
                    joinMutation.isPending ||
                    !memberInfo?.id ||
                    !group.default_self_join_role
                  }
                  data-testid="button-join-group"
                >
                  {joinMutation.isPending ? (
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

        {leadershipMembers.length > 0 && (
          <Card className="mb-6" data-testid="card-leadership-section">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <Crown className="w-5 h-5 text-amber-600 fill-current" />
                <h2
                  className="text-lg font-semibold text-slate-900"
                  data-testid="text-leadership-heading"
                >
                  Leadership ({leadershipMembers.length})
                </h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {leadershipMembers.map((m) => {
                  const { displayName, showAvatarImage, anonymised } = m.__display;
                  const interactive = !anonymised;
                  const handleOpen = () => {
                    if (interactive) setSelectedMemberId(m.id);
                  };
                  return (
                    <Card
                      key={`leader-${m.id}`}
                      className={`overflow-hidden ${interactive ? "cursor-pointer hover-elevate active-elevate-2" : ""}`}
                      onClick={interactive ? handleOpen : undefined}
                      onKeyDown={
                        interactive
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleOpen();
                              }
                            }
                          : undefined
                      }
                      role={interactive ? "button" : undefined}
                      tabIndex={interactive ? 0 : undefined}
                      data-testid={`card-leader-${m.id}`}
                    >
                      <CardContent className="p-3 flex items-center gap-3">
                        <Avatar className="h-10 w-10 flex-shrink-0">
                          {showAvatarImage && m.profile_photo_url ? (
                            <AvatarImage src={m.profile_photo_url} alt={displayName} />
                          ) : null}
                          <AvatarFallback className="bg-amber-100 text-amber-800">
                            {getInitials(displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div
                            className="font-medium text-sm text-slate-900 truncate"
                            data-testid={`text-leader-name-${m.id}`}
                            title={displayName}
                          >
                            {displayName}
                          </div>
                          <div
                            className="text-xs text-amber-700 truncate flex items-center gap-1"
                            data-testid={`text-leader-role-${m.id}`}
                            title={m.__role}
                          >
                            <Crown className="w-3 h-3 fill-current flex-shrink-0" />
                            {m.__role}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-5 h-5 text-slate-600" />
              <h2
                className="text-lg font-semibold text-slate-900"
                data-testid="text-members-heading"
              >
                Members ({sortedMembers.length})
              </h2>
            </div>
            {sortedMembers.length === 0 ? (
              <div className="text-center py-8 text-slate-500" data-testid="text-no-members">
                No members have joined this group yet.
              </div>
            ) : (
              <>
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  <Input
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder="Search members..."
                    className="pl-9"
                    data-testid="input-search-members"
                  />
                </div>

                {filteredMembers.length === 0 ? (
                  <div
                    className="text-center py-8 text-slate-500"
                    data-testid="text-no-members-matching"
                  >
                    No members match your search.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {pagedMembers.map((m) => {
                        const { displayName, showAvatarImage, anonymised } = m.__display;
                        const interactive = !anonymised;
                        const handleOpen = () => {
                          if (interactive) setSelectedMemberId(m.id);
                        };
                        return (
                          <Card
                            key={m.id}
                            className={`overflow-hidden ${interactive ? "cursor-pointer hover-elevate active-elevate-2" : ""}`}
                            onClick={interactive ? handleOpen : undefined}
                            onKeyDown={
                              interactive
                                ? (e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      handleOpen();
                                    }
                                  }
                                : undefined
                            }
                            role={interactive ? "button" : undefined}
                            tabIndex={interactive ? 0 : undefined}
                            data-testid={`card-member-${m.id}`}
                          >
                            <CardContent className="p-3 flex items-center gap-3">
                              <Avatar className="h-10 w-10 flex-shrink-0">
                                {showAvatarImage && m.profile_photo_url ? (
                                  <AvatarImage src={m.profile_photo_url} alt={displayName} />
                                ) : null}
                                <AvatarFallback className="bg-blue-100 text-blue-700">
                                  {getInitials(displayName)}
                                </AvatarFallback>
                              </Avatar>
                              <div
                                className="font-medium text-sm text-slate-900 truncate"
                                data-testid={`text-member-name-${m.id}`}
                                title={displayName}
                              >
                                {displayName}
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>

                    {totalPages > 1 && (
                      <div
                        className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-200"
                        data-testid="pagination-members"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMemberPage((p) => Math.max(1, p - 1))}
                          disabled={currentPage <= 1}
                          data-testid="button-members-prev"
                        >
                          <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                        </Button>
                        <div
                          className="text-sm text-slate-600"
                          data-testid="text-members-page-indicator"
                        >
                          Page {currentPage} of {totalPages}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMemberPage((p) => Math.min(totalPages, p + 1))}
                          disabled={currentPage >= totalPages}
                          data-testid="button-members-next"
                        >
                          Next <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={confirmLeave}
        onOpenChange={(open) => {
          if (!open && !leaveMutation.isPending) setConfirmLeave(false);
        }}
      >
        <AlertDialogContent data-testid="dialog-leave-group">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave Group</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to leave "{group.name}"? You can rejoin at any
              time while this group remains open for self-join.
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
                leaveMutation.mutate();
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

      <AlertDialog
        open={showTerms}
        onOpenChange={(open) => {
          if (joinMutation.isPending) return;
          setShowTerms(open);
          if (!open) setAgreedToTerms(false);
        }}
      >
        <AlertDialogContent
          className="max-w-2xl"
          data-testid="dialog-terms-of-reference"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Terms of reference</AlertDialogTitle>
            <AlertDialogDescription>
              Please read and agree to the terms of reference before joining "{group.name}".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div
            className="max-h-[55vh] overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 prose prose-sm max-w-none"
            data-testid="text-terms-of-reference"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(group.terms_of_reference || ""),
            }}
          />
          <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
            <Checkbox
              checked={agreedToTerms}
              onCheckedChange={(v) => setAgreedToTerms(v === true)}
              disabled={joinMutation.isPending}
              className="mt-0.5"
              data-testid="checkbox-agree-terms"
            />
            <span>I have read and agree to the terms of reference.</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={joinMutation.isPending}
              data-testid="button-cancel-terms"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                joinMutation.mutate();
              }}
              disabled={!agreedToTerms || joinMutation.isPending}
              data-testid="button-confirm-join-terms"
            >
              {joinMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              Agree and join
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MemberProfileModal
        memberId={selectedMemberId}
        open={!!selectedMemberId}
        onOpenChange={(open) => {
          if (!open) setSelectedMemberId(null);
        }}
      />
    </div>
  );
}
