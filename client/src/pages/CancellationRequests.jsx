import React, { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Calendar, User, Ticket, CheckCircle, XCircle, Clock, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { toast } from "sonner";

export default function CancellationRequests() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("pending");
  const [reviewDialog, setReviewDialog] = useState(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_CancellationRequests')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: requestsData, isLoading, error, refetch } = useQuery({
    queryKey: ['cancellation-requests', statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'all') {
        params.set('status', statusFilter);
      }
      const response = await fetch(`/api/booking-cancellation-requests?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch cancellation requests');
      }
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: true,
    enabled: accessChecked,
  });

  const requests = requestsData?.requests || [];

  const groupedRequests = useMemo(() => {
    const groups = {};
    for (const req of requests) {
      const key = req.booking_group_reference || req.booking_id;
      if (!groups[key]) {
        groups[key] = {
          key,
          booking_group_reference: req.booking_group_reference,
          event: req.event,
          member: req.member,
          request_type: req.request_type,
          reason: req.reason,
          created_at: req.created_at,
          items: [],
        };
      }
      groups[key].items.push(req);
    }
    return Object.values(groups);
  }, [requests]);

  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupedRequests;
    const q = searchQuery.toLowerCase();
    return groupedRequests.filter(group => {
      const eventTitle = group.event?.title || '';
      const memberName = group.member ? `${group.member.first_name || ''} ${group.member.last_name || ''}` : '';
      const memberEmail = group.member?.email || '';
      const attendees = group.items.map(i => {
        const b = i.booking;
        return b ? `${b.attendee_first_name || ''} ${b.attendee_last_name || ''} ${b.attendee_email || ''}` : '';
      }).join(' ');
      return (
        eventTitle.toLowerCase().includes(q) ||
        memberName.toLowerCase().includes(q) ||
        memberEmail.toLowerCase().includes(q) ||
        attendees.toLowerCase().includes(q)
      );
    });
  }, [groupedRequests, searchQuery]);

  const handleReview = async (action) => {
    if (!reviewDialog) return;
    setProcessing(true);

    try {
      const requestIds = reviewDialog.items.map(i => i.id);

      for (const requestId of requestIds) {
        const response = await fetch(`/api/booking-cancellation-requests/${requestId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            status: action,
            review_notes: reviewNotes.trim() || null,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to ${action} request`);
        }
      }

      toast.success(
        action === 'approved'
          ? `${requestIds.length} ticket(s) cancellation approved`
          : `${requestIds.length} ticket(s) cancellation rejected`
      );

      setReviewDialog(null);
      setReviewNotes("");
      queryClient.invalidateQueries({ queryKey: ['cancellation-requests'] });
    } catch (error) {
      console.error('Review error:', error);
      toast.error(error.message || `Failed to ${action} request`);
    } finally {
      setProcessing(false);
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-amber-100 text-amber-700 border-amber-200"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      case 'approved':
        return <Badge variant="outline" className="bg-green-100 text-green-700 border-green-200"><CheckCircle className="w-3 h-3 mr-1" />Approved</Badge>;
      case 'rejected':
        return <Badge variant="outline" className="bg-red-100 text-red-700 border-red-200"><XCircle className="w-3 h-3 mr-1" />Rejected</Badge>;
      default:
        return <Badge variant="outline" className="bg-slate-100 text-slate-700 border-slate-200">{status}</Badge>;
    }
  };

  const pendingCount = requests.filter(r => r.status === 'pending').length;

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900" data-testid="text-page-title">
              Cancellation Requests
            </h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              data-testid="button-refresh"
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              Refresh
            </Button>
          </div>
          <p className="text-slate-600">
            Review and manage booking cancellation requests from members
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
            <Input
              placeholder="Search by event, member or attendee..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-status-filter">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="grid gap-4">
            {Array(3).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <CardHeader>
                  <div className="h-5 bg-slate-200 rounded w-1/2 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-1/3" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="h-4 bg-slate-200 rounded" />
                    <div className="h-4 bg-slate-200 rounded w-5/6" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : error ? (
          <Card className="border-red-200">
            <CardContent className="p-8 text-center">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 mb-2">Failed to load requests</h3>
              <p className="text-slate-600 mb-4">{error.message}</p>
              <Button variant="outline" onClick={() => refetch()} data-testid="button-retry">
                Try Again
              </Button>
            </CardContent>
          </Card>
        ) : filteredGroups.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <CheckCircle className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {statusFilter === 'pending' ? 'No pending requests' : 'No requests found'}
              </h3>
              <p className="text-slate-600">
                {statusFilter === 'pending'
                  ? 'All cancellation requests have been reviewed.'
                  : 'No cancellation requests match your current filters.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredGroups.map((group) => {
              const firstItem = group.items[0];
              const allPending = group.items.every(i => i.status === 'pending');
              const allSameStatus = group.items.every(i => i.status === firstItem.status);

              return (
                <Card key={group.key} className="border-slate-200 shadow-sm" data-testid={`card-request-${group.key}`}>
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <CardTitle className="text-lg truncate">
                            {group.event?.title || 'Unknown Event'}
                          </CardTitle>
                          {group.items.length > 1 && (
                            <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200">
                              {group.items.length} tickets
                            </Badge>
                          )}
                          {allSameStatus && getStatusBadge(firstItem.status)}
                        </div>
                        <CardDescription className="flex items-center gap-4 flex-wrap">
                          {group.event?.start_date && (
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {format(new Date(group.event.start_date), "MMM d, yyyy")}
                            </span>
                          )}
                          {group.member && (
                            <span className="flex items-center gap-1">
                              <User className="w-3 h-3" />
                              {group.member.first_name} {group.member.last_name} ({group.member.email})
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Submitted {format(new Date(group.created_at), "MMM d, yyyy 'at' h:mm a")}
                          </span>
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        {group.items.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between gap-2 p-2 bg-slate-50 rounded-md border border-slate-200"
                            data-testid={`row-request-item-${item.id}`}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <Ticket className="w-4 h-4 text-slate-400 shrink-0" />
                              <span className="text-sm text-slate-700 truncate">
                                {item.booking?.attendee_first_name && item.booking?.attendee_last_name
                                  ? `${item.booking.attendee_first_name} ${item.booking.attendee_last_name}`
                                  : item.booking?.attendee_email || 'Unknown attendee'}
                              </span>
                              {item.booking?.ticket_class_name && (
                                <Badge variant="outline" className="bg-slate-100 text-slate-600 border-slate-200 text-xs">
                                  {item.booking.ticket_class_name}
                                </Badge>
                              )}
                            </div>
                            {!allSameStatus && getStatusBadge(item.status)}
                          </div>
                        ))}
                      </div>

                      {group.reason && (
                        <div className="p-3 bg-slate-50 rounded-md border border-slate-200">
                          <p className="text-xs font-medium text-slate-500 mb-1">Reason</p>
                          <p className="text-sm text-slate-700">{group.reason}</p>
                        </div>
                      )}

                      {firstItem.reviewed_by && (
                        <div className="p-3 bg-slate-50 rounded-md border border-slate-200">
                          <p className="text-xs font-medium text-slate-500 mb-1">
                            Reviewed by {firstItem.reviewed_by}
                            {firstItem.reviewed_at && ` on ${format(new Date(firstItem.reviewed_at), "MMM d, yyyy 'at' h:mm a")}`}
                          </p>
                          {firstItem.review_notes && (
                            <p className="text-sm text-slate-700">{firstItem.review_notes}</p>
                          )}
                        </div>
                      )}

                      {allPending && (
                        <div className="flex items-center gap-2 justify-end flex-wrap">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setReviewDialog({ ...group, action: 'rejected' }); setReviewNotes(""); }}
                            data-testid={`button-reject-${group.key}`}
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => { setReviewDialog({ ...group, action: 'approved' }); setReviewNotes(""); }}
                            data-testid={`button-approve-${group.key}`}
                          >
                            <CheckCircle className="w-4 h-4 mr-1" />
                            Approve
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={!!reviewDialog} onOpenChange={(open) => { if (!open) { setReviewDialog(null); setReviewNotes(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === 'approved' ? 'Approve Cancellation' : 'Reject Cancellation'}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === 'approved'
                ? `Approving will cancel ${reviewDialog?.items?.length || 0} ticket(s) and make them available for reallocation.`
                : `Rejecting will keep the ticket(s) active. The member will see their request was declined.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {reviewDialog && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-700">
                  {reviewDialog.event?.title || 'Unknown Event'}
                </p>
                {reviewDialog.items?.map(item => (
                  <div key={item.id} className="flex items-center gap-2 text-sm p-2 bg-slate-50 rounded-md border border-slate-200">
                    <User className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="text-slate-700 truncate">
                      {item.booking?.attendee_first_name && item.booking?.attendee_last_name
                        ? `${item.booking.attendee_first_name} ${item.booking.attendee_last_name}`
                        : item.booking?.attendee_email || 'Unknown'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">
                Notes (optional)
              </label>
              <Textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder="Add any notes about this decision..."
                className="resize-none"
                rows={3}
                data-testid="input-review-notes"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setReviewDialog(null); setReviewNotes(""); }}
              data-testid="button-review-cancel"
            >
              Cancel
            </Button>
            <Button
              variant={reviewDialog?.action === 'approved' ? 'default' : 'destructive'}
              onClick={() => handleReview(reviewDialog?.action)}
              disabled={processing}
              data-testid="button-review-confirm"
            >
              {processing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : reviewDialog?.action === 'approved' ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Confirm Approval
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 mr-1" />
                  Confirm Rejection
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
