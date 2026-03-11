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
import { Search, Calendar, User, Ticket, CheckCircle, XCircle, Clock, AlertCircle, Loader2, RefreshCw, DollarSign, AlertTriangle, RotateCcw } from "lucide-react";
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
  const [voucherReplacements, setVoucherReplacements] = useState({});
  const [discountCodeReplacement, setDiscountCodeReplacement] = useState({ create: false, newExpiryDate: "" });

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
      let allReversalResults = [];

      for (let i = 0; i < requestIds.length; i++) {
        const requestId = requestIds[i];
        const body = {
          status: action,
          review_notes: reviewNotes.trim() || null,
        };

        if (action === 'approved' && i === 0) {
          const voucherReplacementsList = Object.entries(voucherReplacements)
            .filter(([, v]) => v.create && v.newExpiryDate)
            .map(([voucherId, v]) => ({ voucherId, newExpiryDate: v.newExpiryDate }));

          body.reversal_options = {
            voucherReplacements: voucherReplacementsList.length > 0 ? voucherReplacementsList : undefined,
            discountCodeReplacement: discountCodeReplacement.create && discountCodeReplacement.newExpiryDate
              ? { newExpiryDate: discountCodeReplacement.newExpiryDate }
              : undefined,
          };
        }

        const response = await fetch(`/api/booking-cancellation-requests/${requestId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to ${action} request`);
        }

        const result = await response.json();
        if (result.reversalResults) {
          allReversalResults.push(result.reversalResults);
        }
      }

      if (action === 'approved') {
        const messages = [`${requestIds.length} ticket(s) cancellation approved`];
        const warnings = [];
        for (const rr of allReversalResults) {
          if (rr.trainingFund?.success) messages.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
          for (const v of rr.vouchers || []) {
            if (v.reinstated) messages.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
            if (v.replacementCreated) messages.push(`Replacement voucher ${v.newVoucherCode} created`);
          }
          if (rr.discountCode?.reversed) messages.push(`Discount code ${rr.discountCode.code} usage reversed`);
          if (rr.discountCode?.replacementCreated) messages.push(`Replacement discount code ${rr.discountCode.newCode} created`);
          if (rr.programTicket?.success) messages.push(`Program ticket refunded`);
          if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) messages.push(`Stripe refund: £${Number(rr.stripeRefund.amount).toFixed(2)}${rr.stripeRefund.partialRefund ? ' (partial)' : ''}`);
          if (rr.stripeRefund?.success && rr.stripeRefund?.alreadyRefunded) messages.push(`Stripe payment already refunded`);
          if (rr.stripeRefund && !rr.stripeRefund.success) warnings.push(`Stripe refund failed for £${Number(rr.stripeRefund.amount).toFixed(2)} — manual refund needed`);
          if (rr.xeroCreditNote?.success && rr.xeroCreditNote?.allocated) messages.push(`Xero credit note ${rr.xeroCreditNote.creditNoteNumber}: £${Number(rr.xeroCreditNote.amount).toFixed(2)} (allocated${rr.xeroCreditNote.alreadyExisted ? ', already existed' : ''})`);
          if (rr.xeroCreditNote?.success && !rr.xeroCreditNote?.allocated) warnings.push(`Xero credit note ${rr.xeroCreditNote.creditNoteNumber} created for £${Number(rr.xeroCreditNote.amount).toFixed(2)} but not allocated — manual allocation needed`);
          if (rr.xeroCreditNote && !rr.xeroCreditNote.success && rr.xeroCreditNote.skipped) warnings.push(`Xero credit note skipped: ${rr.xeroCreditNote.reason}`);
          if (rr.xeroCreditNote && !rr.xeroCreditNote.success && !rr.xeroCreditNote.skipped) warnings.push(`Xero credit note failed for £${Number(rr.xeroCreditNote.amount).toFixed(2)} — manual action needed`);
        }
        toast.success(messages.join('. '));
        for (const warning of warnings) {
          toast.warning(warning);
        }
      } else {
        toast.success(`${requestIds.length} ticket(s) cancellation rejected`);
      }

      setReviewDialog(null);
      setReviewNotes("");
      setVoucherReplacements({});
      setDiscountCodeReplacement({ create: false, newExpiryDate: "" });
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

                      {allPending && (() => {
                        const fs = firstItem.financialSummary;
                        if (!fs) return null;
                        const items = [];
                        if (fs.trainingFundAmount > 0) items.push(`Training Fund: £${fs.trainingFundAmount.toFixed(2)}`);
                        if (fs.voucherAmount > 0) items.push(`Voucher: £${fs.voucherAmount.toFixed(2)}`);
                        if (fs.discountCodeAmount > 0) items.push(`Discount: £${fs.discountCodeAmount.toFixed(2)}`);
                        if (fs.stripePaymentIntentId && fs.cardAmount > 0) items.push(`Stripe Refund: £${fs.cardAmount.toFixed(2)}`);
                        if (fs.xeroInvoiceId) items.push(`Xero Credit Note: £${fs.totalCost.toFixed(2)} (#${fs.xeroInvoiceNumber || 'Invoice'})`);
                        if (items.length === 0) return null;
                        const hasExpired = (fs.voucherDetails || []).some(v => v.expired) || fs.discountCode?.expired;
                        return (
                          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground" data-testid="row-financial-preview">
                            <DollarSign className="w-3 h-3 shrink-0" />
                            <span>{items.join(' · ')}</span>
                            {hasExpired && (
                              <Badge variant="outline" className="text-orange-600 border-orange-300 text-xs">
                                Expired items
                              </Badge>
                            )}
                          </div>
                        );
                      })()}

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
                            onClick={() => { setReviewDialog({ ...group, action: 'rejected' }); setReviewNotes(""); setVoucherReplacements({}); setDiscountCodeReplacement({ create: false, newExpiryDate: "" }); }}
                            data-testid={`button-reject-${group.key}`}
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => { setReviewDialog({ ...group, action: 'approved' }); setReviewNotes(""); setVoucherReplacements({}); setDiscountCodeReplacement({ create: false, newExpiryDate: "" }); }}
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

      <Dialog open={!!reviewDialog} onOpenChange={(open) => { if (!open) { setReviewDialog(null); setReviewNotes(""); setVoucherReplacements({}); setDiscountCodeReplacement({ create: false, newExpiryDate: "" }); } }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === 'approved' ? 'Approve Cancellation' : 'Reject Cancellation'}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === 'approved'
                ? `Approving will cancel ${reviewDialog?.items?.length || 0} ticket(s) and reverse applicable financial items.`
                : `Rejecting will keep the ticket(s) active. The member will see their request was declined.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {reviewDialog && (
              <div className="space-y-2">
                <p className="text-sm font-medium" data-testid="text-review-event">
                  {reviewDialog.event?.title || 'Unknown Event'}
                </p>
                {reviewDialog.items?.map(item => (
                  <div key={item.id} className="flex items-center gap-2 text-sm p-2 bg-muted rounded-md">
                    <User className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="truncate">
                      {item.booking?.attendee_first_name && item.booking?.attendee_last_name
                        ? `${item.booking.attendee_first_name} ${item.booking.attendee_last_name}`
                        : item.booking?.attendee_email || 'Unknown'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {reviewDialog?.action === 'approved' && (() => {
              const fs = reviewDialog?.items?.[0]?.financialSummary;
              if (!fs) return null;
              const hasTrainingFund = fs.trainingFundAmount > 0;
              const hasVoucher = fs.voucherAmount > 0;
              const hasDiscount = fs.discountCodeAmount > 0;
              const hasStripe = !!fs.stripePaymentIntentId;
              const hasXero = !!fs.xeroInvoiceId;
              const hasAnything = hasTrainingFund || hasVoucher || hasDiscount || hasStripe || hasXero;

              if (!hasAnything) return null;

              return (
                <div className="space-y-3" data-testid="section-financial-summary">
                  <div className="flex items-center gap-2">
                    <RotateCcw className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium">Financial Reversal Summary</p>
                  </div>

                  <div className="space-y-2 text-sm">
                    {hasTrainingFund && (
                      <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-training-fund">
                        <span>Training Fund Reinstatement</span>
                        <Badge variant="outline">£{fs.trainingFundAmount.toFixed(2)}</Badge>
                      </div>
                    )}

                    {hasVoucher && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-voucher-amount">
                          <span>Voucher Reinstatement</span>
                          <Badge variant="outline">£{fs.voucherAmount.toFixed(2)}</Badge>
                        </div>
                        {fs.voucherDetails?.map((v) => {
                          if (!v.expired) return (
                            <div key={v.voucherId} className="flex items-center gap-2 pl-4 text-xs text-muted-foreground" data-testid={`row-voucher-detail-${v.voucherId}`}>
                              <CheckCircle className="w-3 h-3 text-green-600 shrink-0" />
                              <span>Voucher {v.code}: £{parseFloat(v.amount).toFixed(2)} will be reinstated</span>
                            </div>
                          );
                          return (
                            <div key={v.voucherId} className="space-y-2 p-3 border border-orange-200 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-800 rounded-md" data-testid={`row-voucher-expired-${v.voucherId}`}>
                              <div className="flex items-center gap-2 text-xs">
                                <AlertTriangle className="w-3 h-3 text-orange-600 shrink-0" />
                                <span className="text-orange-700 dark:text-orange-400">Voucher {v.code} expired {v.expiresAt ? format(new Date(v.expiresAt), "MMM d, yyyy") : ''} — £{parseFloat(v.amount).toFixed(2)} cannot be reinstated</span>
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <Button
                                  size="sm"
                                  variant={voucherReplacements[v.voucherId]?.create ? "default" : "outline"}
                                  onClick={() => setVoucherReplacements(prev => ({
                                    ...prev,
                                    [v.voucherId]: { create: !prev[v.voucherId]?.create, newExpiryDate: prev[v.voucherId]?.newExpiryDate || "" }
                                  }))}
                                  data-testid={`button-voucher-replace-${v.voucherId}`}
                                >
                                  {voucherReplacements[v.voucherId]?.create ? 'Creating replacement' : 'Create replacement voucher'}
                                </Button>
                                {voucherReplacements[v.voucherId]?.create && (
                                  <Input
                                    type="date"
                                    className="w-40"
                                    value={voucherReplacements[v.voucherId]?.newExpiryDate || ""}
                                    onChange={(e) => setVoucherReplacements(prev => ({
                                      ...prev,
                                      [v.voucherId]: { ...prev[v.voucherId], newExpiryDate: e.target.value }
                                    }))}
                                    min={format(new Date(), "yyyy-MM-dd")}
                                    data-testid={`input-voucher-expiry-${v.voucherId}`}
                                  />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {hasDiscount && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-discount-amount">
                          <span>Discount Code ({fs.discountCode?.code})</span>
                          <Badge variant="outline">£{fs.discountCodeAmount.toFixed(2)}</Badge>
                        </div>
                        {fs.discountCode?.expired ? (
                          <div className="space-y-2 p-3 border border-orange-200 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-800 rounded-md" data-testid="row-discount-expired">
                            <div className="flex items-center gap-2 text-xs">
                              <AlertTriangle className="w-3 h-3 text-orange-600 shrink-0" />
                              <span className="text-orange-700 dark:text-orange-400">Discount code expired {fs.discountCode.expiresAt ? format(new Date(fs.discountCode.expiresAt), "MMM d, yyyy") : ''} — usage cannot be reversed</span>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Button
                                size="sm"
                                variant={discountCodeReplacement.create ? "default" : "outline"}
                                onClick={() => setDiscountCodeReplacement(prev => ({ create: !prev.create, newExpiryDate: prev.newExpiryDate }))}
                                data-testid="button-discount-replace"
                              >
                                {discountCodeReplacement.create ? 'Creating replacement' : 'Create replacement code'}
                              </Button>
                              {discountCodeReplacement.create && (
                                <Input
                                  type="date"
                                  className="w-40"
                                  value={discountCodeReplacement.newExpiryDate}
                                  onChange={(e) => setDiscountCodeReplacement(prev => ({ ...prev, newExpiryDate: e.target.value }))}
                                  min={format(new Date(), "yyyy-MM-dd")}
                                  data-testid="input-discount-expiry"
                                />
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 pl-4 text-xs text-muted-foreground" data-testid="row-discount-active">
                            <CheckCircle className="w-3 h-3 text-green-600 shrink-0" />
                            <span>Usage count will be decremented</span>
                          </div>
                        )}
                      </div>
                    )}

                    {hasStripe && fs.cardAmount > 0 && (
                      <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-stripe">
                        <span>Stripe Refund</span>
                        <Badge variant="outline">£{fs.cardAmount.toFixed(2)}</Badge>
                      </div>
                    )}

                    {hasXero && (
                      <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-xero">
                        <span>Xero Credit Note (#{fs.xeroInvoiceNumber})</span>
                        <Badge variant="outline">£{fs.totalCost.toFixed(2)}</Badge>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="space-y-2">
              <label className="text-sm font-medium">
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
              onClick={() => { setReviewDialog(null); setReviewNotes(""); setVoucherReplacements({}); setDiscountCodeReplacement({ create: false, newExpiryDate: "" }); }}
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
