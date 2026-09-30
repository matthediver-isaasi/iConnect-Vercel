import React, { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mail, Search, FileText, Loader2, AlertTriangle, RotateCw, UserPlus } from "lucide-react";
import { format } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

const STATUS_BADGE = {
  pending: "bg-warning/10 text-warning",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-600",
  expired: "bg-red-100 text-red-700",
};

function StatusBadge({ status }) {
  const cls = STATUS_BADGE[status] || "bg-slate-100 text-slate-600";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
  return <Badge className={cls} data-testid={`badge-status-${status}`}>{label}</Badge>;
}

function formatDate(value) {
  if (!value) return null;
  try {
    return format(new Date(value), "dd MMM yyyy");
  } catch {
    return null;
  }
}

export default function MemberGroupInviteReportPage() {
  const queryClient = useQueryClient();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("membership.member-groups-invite-report")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  const {
    data,
    isLoading: loadingInvites,
    isError,
    error,
  } = useQuery({
    queryKey: ["member-group-invite-report"],
    queryFn: () => apiRequest("GET", "/api/member-group-invites"),
    enabled: accessChecked,
  });

  const invitations = useMemo(() => data?.invitations || [], [data]);

  const [resendingId, setResendingId] = useState(null);
  const resendInviteMutation = useMutation({
    mutationFn: (invitationId) => apiRequest("POST", "/api/member-group-invites", { action: "resend", invitationId }),
    onMutate: (invitationId) => {
      setResendingId(invitationId);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["member-group-invite-report"] });
      if (result?.emailSent === false) {
        toast.error("Invitation re-issued, but the email could not be sent: " + (result.emailError || "unknown error"));
      } else {
        toast.success("Invitation resent");
      }
    },
    onError: (error) => {
      toast.error("Failed to resend invitation: " + (error?.message || "unknown error"));
    },
    onSettled: () => {
      setResendingId(null);
    },
  });

  const [reinvitingId, setReinvitingId] = useState(null);
  const reinviteMutation = useMutation({
    mutationFn: (inv) => apiRequest("POST", "/api/member-group-invites", {
      action: "create",
      groupId: inv.group_id,
      memberId: inv.member_id,
      role: inv.group_role,
    }),
    onMutate: (inv) => {
      setReinvitingId(inv.id);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["member-group-invite-report"] });
      if (result?.emailSent === false) {
        toast.error("Invitation created, but the email could not be sent: " + (result.emailError || "unknown error"));
      } else {
        toast.success("Invitation sent");
      }
    },
    onError: (error) => {
      toast.error("Failed to send invitation: " + (error?.message || "unknown error"));
    },
    onSettled: () => {
      setReinvitingId(null);
    },
  });

  const groupOptions = useMemo(() => {
    const seen = new Map();
    invitations.forEach((inv) => {
      const name = inv.group_name || "Unknown Group";
      if (!seen.has(name)) seen.set(name, name);
    });
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [invitations]);

  const filteredInvites = useMemo(() => {
    let filtered = invitations;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (inv) =>
          (inv.member_name || "").toLowerCase().includes(q) ||
          (inv.member_email || "").toLowerCase().includes(q) ||
          (inv.group_name || "").toLowerCase().includes(q) ||
          (inv.group_role || "").toLowerCase().includes(q)
      );
    }

    if (statusFilter !== "all") {
      filtered = filtered.filter((inv) => inv.status === statusFilter);
    }

    if (groupFilter !== "all") {
      filtered = filtered.filter((inv) => (inv.group_name || "Unknown Group") === groupFilter);
    }

    return filtered;
  }, [invitations, searchQuery, statusFilter, groupFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, groupFilter]);

  const totalPages = Math.ceil(filteredInvites.length / itemsPerPage);
  const paginatedInvites = filteredInvites.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const isLoading = !accessChecked || loadingInvites;

  if (isLoading) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-600">Loading invite report...</p>
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
            Member Group Invite Report
          </h1>
          <p className="text-slate-600">
            View the status of every member group role invitation sent across your organisation
          </p>
        </div>

        {isError ? (
          <Card>
            <CardContent className="p-12 text-center">
              <AlertTriangle className="w-16 h-16 text-red-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Unable to load invitations</h3>
              <p className="text-slate-600" data-testid="text-error">
                {error?.message || "Something went wrong while loading the report."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Filters */}
            <Card className="mb-6">
              <CardContent className="p-4">
                <div className="flex flex-col md:flex-row gap-3">
                  <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      placeholder="Search by member, email, group, or role..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                      data-testid="input-search"
                    />
                  </div>
                  <div className="w-full md:w-48">
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger data-testid="select-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Statuses</SelectItem>
                        {STATUS_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-full md:w-48">
                    <Select value={groupFilter} onValueChange={setGroupFilter}>
                      <SelectTrigger data-testid="select-group">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Groups</SelectItem>
                        {groupOptions.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {filteredInvites.length > 0 && (
                  <p className="text-sm text-slate-600 mt-3" data-testid="text-result-count">
                    Showing {filteredInvites.length} invitation{filteredInvites.length !== 1 ? "s" : ""}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Results */}
            {filteredInvites.length === 0 ? (
              <Card>
                <CardContent className="p-12 text-center">
                  {invitations.length === 0 ? (
                    <>
                      <Mail className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                      <h3 className="text-xl font-semibold text-slate-900 mb-2">No Invitations Yet</h3>
                      <p className="text-slate-600">
                        No member group role invitations have been sent yet.
                      </p>
                    </>
                  ) : (
                    <>
                      <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                      <h3 className="text-xl font-semibold text-slate-900 mb-2">No Invitations Found</h3>
                      <p className="text-slate-600">Try adjusting your filters</p>
                    </>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Member</th>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Group</th>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Role</th>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Status</th>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Sent</th>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Decision</th>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Expiry</th>
                          <th className="text-left p-4 text-sm font-semibold text-slate-700">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {paginatedInvites.map((inv) => (
                          <tr key={inv.id} className="hover:bg-slate-50" data-testid={`row-invite-${inv.id}`}>
                            <td className="p-4">
                              <div className="font-medium text-slate-900" data-testid={`text-member-name-${inv.id}`}>
                                {inv.member_name || "Unknown"}
                              </div>
                              <div className="text-xs text-slate-500">{inv.member_email || "-"}</div>
                            </td>
                            <td className="p-4">
                              <span className="text-slate-900">{inv.group_name || "Unknown Group"}</span>
                            </td>
                            <td className="p-4">
                              <Badge className="bg-blue-100 text-blue-700">{inv.group_role}</Badge>
                            </td>
                            <td className="p-4">
                              <StatusBadge status={inv.status} />
                            </td>
                            <td className="p-4">
                              <span className="text-slate-900">{formatDate(inv.created_at) || "-"}</span>
                            </td>
                            <td className="p-4">
                              {inv.decided_at ? (
                                <span className="text-slate-900">{formatDate(inv.decided_at)}</span>
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                            <td className="p-4">
                              {inv.expires_at ? (
                                <span className="text-slate-900">{formatDate(inv.expires_at)}</span>
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                            <td className="p-4">
                              {(inv.status === "pending" || inv.status === "expired") ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => resendInviteMutation.mutate(inv.id)}
                                  disabled={resendInviteMutation.isPending}
                                  data-testid={`button-resend-invite-${inv.id}`}
                                >
                                  {resendingId === inv.id ? (
                                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                  ) : (
                                    <RotateCw className="w-3 h-3 mr-1" />
                                  )}
                                  Resend
                                </Button>
                              ) : (inv.status === "declined" || inv.status === "cancelled") ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => reinviteMutation.mutate(inv)}
                                  disabled={reinviteMutation.isPending}
                                  data-testid={`button-reinvite-${inv.id}`}
                                >
                                  {reinvitingId === inv.id ? (
                                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                  ) : (
                                    <UserPlus className="w-3 h-3 mr-1" />
                                  )}
                                  Invite again
                                </Button>
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-6 flex justify-center">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-slate-600 px-3">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
