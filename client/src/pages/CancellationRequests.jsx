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
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Search, Calendar, User, Ticket, CheckCircle, XCircle, Clock, AlertCircle, Loader2, RefreshCw, DollarSign, AlertTriangle, RotateCcw, ArrowRightLeft, Mail, MailX } from "lucide-react";
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
  const [typeFilter, setTypeFilter] = useState("all");
  const [reviewDialog, setReviewDialog] = useState(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [processing, setProcessing] = useState(false);
  const [voucherReplacements, setVoucherReplacements] = useState({});
  const [discountCodeReplacement, setDiscountCodeReplacement] = useState({ create: false, newExpiryDate: "" });
  const [refundInFull, setRefundInFull] = useState(true);
  const [customRefundAmount, setCustomRefundAmount] = useState('');
  const [creditNoteEmail, setCreditNoteEmail] = useState('');
  const [selectedTickets, setSelectedTickets] = useState({});
  const [sendEmails, setSendEmails] = useState(true);
  const [allocationTrainingFund, setAllocationTrainingFund] = useState('');
  const [allocationVouchers, setAllocationVouchers] = useState({});
  const [customInvoiceAmount, setCustomInvoiceAmount] = useState('');

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

  const { data: transferRequestsData, isLoading: transferLoading, error: transferError, refetch: refetchTransfers } = useQuery({
    queryKey: ['transfer-requests', statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'all') {
        params.set('status', statusFilter);
      }
      const response = await fetch(`/api/booking-transfer-requests?${params.toString()}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch transfer requests');
      }
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: true,
    enabled: accessChecked,
  });

  const cancellationRequests = requestsData?.requests || [];
  const transferRequests = transferRequestsData?.requests || [];

  const requests = typeFilter === 'transfers' ? [] : cancellationRequests;
  const transfers = typeFilter === 'cancellations' ? [] : transferRequests;

  const groupedRequests = useMemo(() => {
    const groups = {};
    for (const req of requests) {
      const baseKey = req.booking_group_reference || req.booking_id;
      const key = req.booking_group_reference ? baseKey : `${baseKey}::${req.request_type || 'individual'}`;
      if (!groups[key]) {
        groups[key] = {
          key: baseKey,
          booking_group_reference: req.booking_group_reference,
          event: req.event,
          member: req.member,
          request_type: req.request_type,
          reason: req.reason,
          reasons: [],
          created_at: req.created_at,
          items: [],
        };
      }
      groups[key].items.push(req);
      if (req.reason && !groups[key].reasons.includes(req.reason)) {
        groups[key].reasons.push(req.reason);
      }
    }
    return Object.values(groups);
  }, [requests]);

  const transferItems = useMemo(() => {
    return transfers.map(tr => ({
      ...tr,
      _type: 'transfer',
      key: tr.booking_id,
      items: [tr],
    }));
  }, [transfers]);

  const allItems = useMemo(() => {
    const cancellationGroups = groupedRequests.map(g => ({ ...g, _type: 'cancellation' }));
    return [...cancellationGroups, ...transferItems].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
  }, [groupedRequests, transferItems]);

  const filteredGroups = useMemo(() => {
    let items = allItems;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(group => {
        const eventTitle = group.event?.title || '';
        const memberName = group.member ? `${group.member.first_name || ''} ${group.member.last_name || ''}` : '';
        const memberEmail = group.member?.email || '';
        const attendees = group.items.map(i => {
          const b = i.booking;
          return b ? `${b.attendee_first_name || ''} ${b.attendee_last_name || ''} ${b.attendee_email || ''}` : '';
        }).join(' ');
        const targetName = group._type === 'transfer' && group.target_member
          ? `${group.target_member.first_name || ''} ${group.target_member.last_name || ''}`
          : '';
        return (
          eventTitle.toLowerCase().includes(q) ||
          memberName.toLowerCase().includes(q) ||
          memberEmail.toLowerCase().includes(q) ||
          attendees.toLowerCase().includes(q) ||
          targetName.toLowerCase().includes(q)
        );
      });
    }
    return items;
  }, [allItems, searchQuery]);

  const handleTransferReview = async (action) => {
    if (!reviewDialog || reviewDialog._type !== 'transfer') return;
    setProcessing(true);

    try {
      const requestId = reviewDialog.items[0].id;
      const response = await fetch(`/api/booking-transfer-requests/${requestId}`, {
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
        throw new Error(data.error || `Failed to ${action} transfer request`);
      }

      toast.success(action === 'approved' ? 'Transfer approved — ticket transferred' : 'Transfer request rejected');
      setReviewDialog(null);
      setReviewNotes("");
      queryClient.invalidateQueries({ queryKey: ['transfer-requests'] });
    } catch (error) {
      console.error('Transfer review error:', error);
      toast.error(error.message || `Failed to ${action} transfer request`);
    } finally {
      setProcessing(false);
    }
  };

  const handleReview = async (action) => {
    if (!reviewDialog) return;
    setProcessing(true);

    try {
      const allItems = reviewDialog.items;
      const selected = allItems.filter(i => selectedTickets[i.id] !== false);
      const requestIds = selected.map(i => i.id);

      if (requestIds.length === 0) {
        toast.error('Please select at least one ticket');
        setProcessing(false);
        return;
      }

      const hasGroupRef = !!reviewDialog.booking_group_reference;
      const allSelected = requestIds.length === allItems.length;
      const useGroupEndpoint = hasGroupRef && allSelected && requestIds.length > 1;

      const voucherReplacementsList = Object.entries(voucherReplacements)
        .filter(([, v]) => v.create && v.newExpiryDate)
        .map(([voucherId, v]) => ({ voucherId, newExpiryDate: v.newExpiryDate }));

      const reversalOpts = {
        voucherReplacements: voucherReplacementsList.length > 0 ? voucherReplacementsList : undefined,
        discountCodeReplacement: discountCodeReplacement.create && discountCodeReplacement.newExpiryDate
          ? { newExpiryDate: discountCodeReplacement.newExpiryDate }
          : undefined,
      };

      let allReversalResults = [];

      if (useGroupEndpoint) {
        const body = {
          request_ids: requestIds,
          status: action,
          review_notes: reviewNotes.trim() || null,
          suppress_emails: !sendEmails,
        };
        if (action === 'approved') {
          body.reversal_options = reversalOpts;
          if (!refundInFull) {
            const allocation = {};
            if (customRefundAmount) {
              const parsedAmt = parseFloat(customRefundAmount);
              body.custom_refund_amount = parsedAmt;
              allocation.stripeAmount = parsedAmt;
            }
            if (allocationTrainingFund !== '') {
              allocation.trainingFundAmount = parseFloat(allocationTrainingFund) || 0;
            }
            if (customInvoiceAmount !== '') {
              allocation.invoiceAmount = parseFloat(customInvoiceAmount) || 0;
            }
            const voucherAllocs = {};
            for (const [vid, val] of Object.entries(allocationVouchers)) {
              if (val !== '') voucherAllocs[vid] = parseFloat(val) || 0;
            }
            if (Object.keys(voucherAllocs).length > 0) {
              allocation.vouchers = voucherAllocs;
            }
            if (Object.keys(allocation).length > 0) {
              body.refund_allocation = allocation;
            }
          }
          if (creditNoteEmail.trim()) {
            body.credit_note_email = creditNoteEmail.trim();
          }
        }

        const response = await fetch('/api/booking-cancellation-requests/approve-group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to ${action} group request`);
        }

        const result = await response.json();
        if (result.reversalResults) {
          allReversalResults.push(result.reversalResults);
        }
      } else {
        const selItems = allItems.filter(item => requestIds.includes(item.id));
        const totalSelectedCost = selItems.reduce((sum, item) => sum + (item.financialSummary?.totalCost || 0), 0);
        const totalSelectedCard = selItems.reduce((sum, item) => sum + (item.financialSummary?.cardAmount || 0), 0);
        const totalSelectedTraining = selItems.reduce((sum, item) => sum + (item.financialSummary?.trainingFundAmount || 0), 0);

        for (let i = 0; i < requestIds.length; i++) {
          const requestId = requestIds[i];
          const thisItem = selItems.find(it => it.id === requestId);
          const thisFS = thisItem?.financialSummary;
          const body = {
            status: action,
            review_notes: reviewNotes.trim() || null,
            suppress_emails: !sendEmails,
          };

          if (action === 'approved' && i === 0) {
            body.reversal_options = reversalOpts;
          }

          if (action === 'approved' && !refundInFull && thisFS) {
            const allocation = {};
            if (customRefundAmount && totalSelectedCard > 0) {
              const ratio = (thisFS.cardAmount || 0) / totalSelectedCard;
              const perTicketStripe = Math.round(parseFloat(customRefundAmount) * ratio * 100) / 100;
              body.custom_refund_amount = perTicketStripe;
              allocation.stripeAmount = perTicketStripe;
            }
            if (allocationTrainingFund !== '' && totalSelectedTraining > 0) {
              const ratio = (thisFS.trainingFundAmount || 0) / totalSelectedTraining;
              allocation.trainingFundAmount = Math.round((parseFloat(allocationTrainingFund) || 0) * ratio * 100) / 100;
            }
            if (customInvoiceAmount !== '') {
              const totalSelectedInvoice = selItems.reduce((sum, it) => sum + (it.financialSummary?.totalCost || 0), 0);
              if (totalSelectedInvoice > 0) {
                const ratio = (thisFS.totalCost || 0) / totalSelectedInvoice;
                allocation.invoiceAmount = Math.round((parseFloat(customInvoiceAmount) || 0) * ratio * 100) / 100;
              }
            }
            if (i === 0) {
              const voucherAllocs = {};
              for (const [vid, val] of Object.entries(allocationVouchers)) {
                if (val !== '') voucherAllocs[vid] = parseFloat(val) || 0;
              }
              if (Object.keys(voucherAllocs).length > 0) {
                allocation.vouchers = voucherAllocs;
              }
            }
            if (Object.keys(allocation).length > 0) {
              body.refund_allocation = allocation;
            }
          }

          if (action === 'approved' && creditNoteEmail.trim()) {
            body.credit_note_email = creditNoteEmail.trim();
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
      }

      if (action === 'approved') {
        const messages = [`${requestIds.length} ticket(s) cancellation approved${useGroupEndpoint ? ' (consolidated)' : ''}`];
        const warnings = [];
        for (const rr of allReversalResults) {
          if (useGroupEndpoint) {
            const totalTF = (rr.trainingFund || []).filter(t => t.success).reduce((sum, t) => sum + t.amount, 0);
            if (totalTF > 0) messages.push(`Training fund: £${totalTF.toFixed(2)} reinstated`);
            const programCount = (rr.programTickets || []).filter(p => p.success).length;
            if (programCount > 0) messages.push(`${programCount} program ticket(s) refunded`);
          } else {
            if (rr.trainingFund?.success) messages.push(`Training fund: £${Number(rr.trainingFund.amount).toFixed(2)} reinstated`);
            if (rr.programTicket?.success) messages.push(`Program ticket refunded`);
          }
          for (const v of rr.vouchers || []) {
            if (v.reinstated) messages.push(`Voucher ${v.code}: £${Number(v.amount).toFixed(2)} reinstated`);
            if (v.replacementCreated) messages.push(`Replacement voucher ${v.newVoucherCode} created`);
          }
          if (rr.discountCode?.reversed) messages.push(`Discount code ${rr.discountCode.code} usage reversed`);
          if (rr.discountCode?.replacementCreated) messages.push(`Replacement discount code ${rr.discountCode.newCode} created`);
          if (rr.stripeRefund?.success && !rr.stripeRefund?.alreadyRefunded) messages.push(`Stripe refund: £${Number(rr.stripeRefund.amount).toFixed(2)}${rr.stripeRefund.partialRefund ? ' (partial)' : ''}${rr.stripeRefund.consolidated ? ' (consolidated)' : ''}`);
          if (rr.stripeRefund?.success && rr.stripeRefund?.alreadyRefunded) messages.push(`Stripe payment already refunded`);
          if (rr.stripeRefund && !rr.stripeRefund.success) warnings.push(`Stripe refund failed for £${Number(rr.stripeRefund.amount).toFixed(2)} — manual refund needed`);
          if (rr.xeroCreditNote?.success && rr.xeroCreditNote?.allocated) messages.push(`Xero credit note ${rr.xeroCreditNote.creditNoteNumber}: £${Number(rr.xeroCreditNote.amount).toFixed(2)} (allocated${rr.xeroCreditNote.alreadyExisted ? ', already existed' : ''}${rr.xeroCreditNote.consolidated ? ', consolidated' : ''})`);
          if (rr.xeroCreditNote?.success && !rr.xeroCreditNote?.allocated) warnings.push(`Xero credit note ${rr.xeroCreditNote.creditNoteNumber} created for £${Number(rr.xeroCreditNote.amount).toFixed(2)} but not allocated — manual allocation needed`);
          if (rr.xeroCreditNote?.success && rr.xeroCreditNote?.emailed) messages.push(`Credit note emailed to ${rr.xeroCreditNote.emailedTo}`);
          if (rr.xeroCreditNote?.success && rr.xeroCreditNote?.emailed === false) warnings.push(`Failed to email credit note: ${rr.xeroCreditNote.emailError || 'unknown error'}`);
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
      setRefundInFull(true);
      setCustomRefundAmount('');
      setCreditNoteEmail('');
      setSelectedTickets({});
      setSendEmails(true);
      setAllocationTrainingFund('');
      setAllocationVouchers({});
      setCustomInvoiceAmount('');
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

  const pendingCancellationCount = cancellationRequests.filter(r => r.status === 'pending').length;
  const pendingTransferCount = transferRequests.filter(r => r.status === 'pending').length;
  const pendingCount = pendingCancellationCount + pendingTransferCount;

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
              Booking Requests
            </h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { refetch(); refetchTransfers(); }}
              data-testid="button-refresh"
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              Refresh
            </Button>
          </div>
          <p className="text-slate-600">
            Review and manage booking cancellation and transfer requests from members
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
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[180px]" data-testid="select-type-filter">
              <SelectValue placeholder="Filter by type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="cancellations">Cancellations</SelectItem>
              <SelectItem value="transfers">Transfers</SelectItem>
            </SelectContent>
          </Select>
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

        {(isLoading || transferLoading) ? (
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
        ) : (error || transferError) ? (
          <Card className="border-red-200">
            <CardContent className="p-8 text-center">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 mb-2">Failed to load requests</h3>
              <p className="text-slate-600 mb-4">{error?.message || transferError?.message}</p>
              <Button variant="outline" onClick={() => { refetch(); refetchTransfers(); }} data-testid="button-retry">
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
                  ? 'All requests have been reviewed.'
                  : 'No requests match your current filters.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredGroups.map((group) => {
              const firstItem = group.items[0];
              const allPending = group.items.every(i => i.status === 'pending');
              const allSameStatus = group.items.every(i => i.status === firstItem.status);

              const isTransfer = group._type === 'transfer';

              return (
                <Card key={group.key} className="border-slate-200 shadow-sm" data-testid={`card-request-${group.key}`}>
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <CardTitle className="text-lg truncate">
                            {group.event?.title || 'Unknown Event'}
                          </CardTitle>
                          {isTransfer ? (
                            <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200">
                              <ArrowRightLeft className="w-3 h-3 mr-1" />
                              Transfer
                            </Badge>
                          ) : (
                            <>
                              {group.request_type === 'group' && group.items.length > 1 ? (
                                <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200">
                                  Group ({group.items.length} tickets)
                                </Badge>
                              ) : group.items.length > 1 ? (
                                <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200">
                                  {group.items.length} tickets
                                </Badge>
                              ) : null}
                            </>
                          )}
                          {firstItem.booking_source === 'complex_event_booking' && (
                            <Badge variant="outline" className="bg-purple-100 text-purple-700 border-purple-200">
                              Complex Event
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
                              <div className="min-w-0">
                                <span className="text-sm text-slate-700 truncate block">
                                  {item.booking?.attendee_first_name && item.booking?.attendee_last_name
                                    ? `${item.booking.attendee_first_name} ${item.booking.attendee_last_name}`
                                    : item.booking?.attendee_email || 'Unknown attendee'}
                                </span>
                                {item.booking?.attendee_email && (
                                  <span className="text-xs text-slate-500 truncate block">
                                    {item.booking.attendee_email}
                                  </span>
                                )}
                              </div>
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

                      {isTransfer && group.target_member && (
                        <div className="flex items-center gap-2 p-2 bg-blue-50 rounded-md border border-blue-200">
                          <ArrowRightLeft className="w-4 h-4 text-blue-500 shrink-0" />
                          <div className="text-sm text-blue-800 min-w-0">
                            <span>Transfer to: <span className="font-medium">{group.target_member.first_name} {group.target_member.last_name}</span> ({group.target_member.email})</span>
                            {group.target_member.is_public && (
                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">
                                  Guest / Public
                                </Badge>
                                {group.target_member.organisation && (
                                  <span className="text-xs text-blue-600">Org: {group.target_member.organisation}</span>
                                )}
                                {group.target_member.phone && (
                                  <span className="text-xs text-blue-600">Tel: {group.target_member.phone}</span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {!isTransfer && allPending && (() => {
                        const hasGrpFS = !!firstItem.groupFinancialSummary;
                        const fs = hasGrpFS ? firstItem.groupFinancialSummary : firstItem.financialSummary;
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
                            {hasGrpFS && fs.consolidated && (
                              <Badge variant="outline" className="text-blue-600 border-blue-300 text-xs">
                                Consolidated
                              </Badge>
                            )}
                            {hasExpired && (
                              <Badge variant="outline" className="text-orange-600 border-orange-300 text-xs">
                                Expired items
                              </Badge>
                            )}
                          </div>
                        );
                      })()}

                      {(group.reasons?.length > 0 || group.reason) && (
                        <div className="p-3 bg-slate-50 rounded-md border border-slate-200">
                          <p className="text-xs font-medium text-slate-500 mb-1">
                            {group.reasons?.length > 1 ? 'Reasons' : 'Reason'}
                          </p>
                          {group.reasons?.length > 1 ? (
                            <ul className="text-sm text-slate-700 list-disc pl-4 space-y-1">
                              {group.reasons.map((r, idx) => (
                                <li key={idx}>{r}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-slate-700">{group.reasons?.[0] || group.reason}</p>
                          )}
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
                            onClick={() => {
                              const tickets = {};
                              group.items.forEach(i => { tickets[i.id] = true; });
                              setSelectedTickets(tickets);
                              setReviewDialog({ ...group, action: 'rejected' });
                              setReviewNotes("");
                              setVoucherReplacements({});
                              setDiscountCodeReplacement({ create: false, newExpiryDate: "" });
                              setCreditNoteEmail('');
                              setSendEmails(true);
                            }}
                            data-testid={`button-reject-${group.key}`}
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              const tickets = {};
                              group.items.forEach(i => { tickets[i.id] = true; });
                              setSelectedTickets(tickets);
                              setReviewDialog({ ...group, action: 'approved' });
                              setReviewNotes("");
                              setVoucherReplacements({});
                              setDiscountCodeReplacement({ create: false, newExpiryDate: "" });
                              setSendEmails(true);
                              const hasGrpRef = !!group.booking_group_reference;
                              const fsi = hasGrpRef ? group.items?.[0]?.groupFinancialSummary : group.items?.[0]?.financialSummary;
                              setCreditNoteEmail(fsi?.invoicingEmail || '');
                            }}
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

      <Dialog open={!!reviewDialog} onOpenChange={(open) => { if (!open) { setReviewDialog(null); setReviewNotes(""); setVoucherReplacements({}); setDiscountCodeReplacement({ create: false, newExpiryDate: "" }); setRefundInFull(true); setCustomRefundAmount(''); setCreditNoteEmail(''); setSelectedTickets({}); setSendEmails(true); setAllocationTrainingFund(''); setAllocationVouchers({}); setCustomInvoiceAmount(''); } }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?._type === 'transfer'
                ? (reviewDialog?.action === 'approved' ? 'Approve Transfer' : 'Reject Transfer')
                : (reviewDialog?.action === 'approved' ? 'Approve Cancellation' : 'Reject Cancellation')}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?._type === 'transfer'
                ? (reviewDialog?.action === 'approved'
                    ? 'Approving will transfer the ticket to the target member.'
                    : 'Rejecting will keep the ticket with the current attendee. The requester will be notified.')
                : (reviewDialog?.action === 'approved'
                    ? `Approving will cancel the selected ticket(s) and reverse applicable financial items.${reviewDialog?.booking_group_reference && (reviewDialog?.items?.length || 0) > 1 ? ' Multiple tickets from the same group will be consolidated into a single Stripe refund and Xero credit note.' : ''}`
                    : `Rejecting will keep the selected ticket(s) active. The member will see their request was declined.`)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {reviewDialog && (
              <div className="space-y-2">
                <p className="text-sm font-medium" data-testid="text-review-event">
                  {reviewDialog.event?.title || 'Unknown Event'}
                </p>
                {reviewDialog.items?.length > 1 && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {Object.values(selectedTickets).filter(Boolean).length} of {reviewDialog.items.length} ticket(s) selected
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const allSelected = reviewDialog.items.every(i => selectedTickets[i.id] !== false);
                        const newState = {};
                        reviewDialog.items.forEach(i => { newState[i.id] = !allSelected; });
                        setSelectedTickets(newState);
                      }}
                      data-testid="button-toggle-all-tickets"
                    >
                      {reviewDialog.items.every(i => selectedTickets[i.id] !== false) ? 'Deselect All' : 'Select All'}
                    </Button>
                  </div>
                )}
                {reviewDialog.items?.map(item => (
                  <div key={item.id} className={`flex items-center gap-2 text-sm p-2 rounded-md ${selectedTickets[item.id] === false ? 'bg-muted/50 opacity-60' : 'bg-muted'}`}>
                    {reviewDialog.items.length > 1 && (
                      <input
                        type="checkbox"
                        checked={selectedTickets[item.id] !== false}
                        onChange={(e) => setSelectedTickets(prev => ({ ...prev, [item.id]: e.target.checked }))}
                        className="h-4 w-4 rounded border-gray-300 shrink-0 cursor-pointer accent-primary"
                        data-testid={`checkbox-ticket-${item.id}`}
                      />
                    )}
                    <User className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <span className="truncate block">
                        {item.booking?.attendee_first_name && item.booking?.attendee_last_name
                          ? `${item.booking.attendee_first_name} ${item.booking.attendee_last_name}`
                          : item.booking?.attendee_email || 'Unknown'}
                      </span>
                      {item.booking?.attendee_email && (
                        <span className="text-xs text-muted-foreground truncate block">
                          {item.booking.attendee_email}
                        </span>
                      )}
                    </div>
                    {item.booking?.ticket_class_name && (
                      <Badge variant="outline" className="text-xs shrink-0">
                        {item.booking.ticket_class_name}
                      </Badge>
                    )}
                    {item.booking?.total_cost && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        £{parseFloat(item.booking.total_cost).toFixed(2)}
                      </span>
                    )}
                  </div>
                ))}
                {reviewDialog._type === 'transfer' && reviewDialog.target_member && (
                  <div className="flex items-center gap-2 text-sm p-2 bg-blue-50 rounded-md border border-blue-200">
                    <ArrowRightLeft className="w-4 h-4 text-blue-500 shrink-0" />
                    <div className="text-blue-800 min-w-0">
                      <span className="truncate block">
                        Transfer to: <span className="font-medium">{reviewDialog.target_member.first_name} {reviewDialog.target_member.last_name}</span> ({reviewDialog.target_member.email})
                      </span>
                      {reviewDialog.target_member.is_public && (
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">
                            Guest / Public
                          </Badge>
                          {reviewDialog.target_member.organisation && (
                            <span className="text-xs text-blue-600">Org: {reviewDialog.target_member.organisation}</span>
                          )}
                          {reviewDialog.target_member.phone && (
                            <span className="text-xs text-blue-600">Tel: {reviewDialog.target_member.phone}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {reviewDialog?._type !== 'transfer' && reviewDialog?.reasons?.length > 0 && (
                  <div className="p-3 bg-muted rounded-md" data-testid="section-review-reasons">
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      {reviewDialog.reasons.length > 1 ? 'Reasons given' : 'Reason given'}
                    </p>
                    {reviewDialog.reasons.length > 1 ? (
                      <ul className="text-sm list-disc pl-4 space-y-1">
                        {reviewDialog.reasons.map((r, idx) => (
                          <li key={idx}>{r}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm">{reviewDialog.reasons[0]}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {reviewDialog?.action === 'approved' && reviewDialog?._type !== 'transfer' && (() => {
              const selItems = reviewDialog?.items?.filter(i => selectedTickets[i.id] !== false) || [];
              const selectedCount = selItems.length;
              const totalCount = reviewDialog?.items?.length || 0;
              const allTicketsSelected = selectedCount === totalCount;

              const hasGroupFS = !!reviewDialog?.items?.[0]?.groupFinancialSummary;
              const groupFS = reviewDialog?.items?.[0]?.groupFinancialSummary;

              let fs;
              if (hasGroupFS && allTicketsSelected) {
                fs = groupFS;
              } else if (hasGroupFS && !allTicketsSelected) {
                let totalTrainingFund = 0, totalVoucher = 0, totalDiscount = 0, totalCard = 0, totalAccount = 0, totalCost = 0;
                let stripePaymentIntentId = null, xeroInvoiceId = null, xeroInvoiceNumber = null, paymentMethod = null, invoicingEmail = null;
                const seenVoucherIds = new Set();
                const collectedVoucherDetails = [];
                for (const item of selItems) {
                  const ifs = item.financialSummary;
                  if (!ifs) continue;
                  totalTrainingFund += ifs.trainingFundAmount || 0;
                  totalVoucher += ifs.voucherAmount || 0;
                  totalDiscount += ifs.discountCodeAmount || 0;
                  totalCard += ifs.cardAmount || 0;
                  totalAccount += ifs.accountAmount || 0;
                  totalCost += ifs.totalCost || 0;
                  if (ifs.stripePaymentIntentId && !stripePaymentIntentId) stripePaymentIntentId = ifs.stripePaymentIntentId;
                  if (ifs.xeroInvoiceId && !xeroInvoiceId) { xeroInvoiceId = ifs.xeroInvoiceId; xeroInvoiceNumber = ifs.xeroInvoiceNumber; }
                  if (ifs.invoicingEmail && !invoicingEmail) invoicingEmail = ifs.invoicingEmail;
                  if (ifs.paymentMethod && !paymentMethod) paymentMethod = ifs.paymentMethod;
                  if (ifs.voucherDetails) {
                    for (const vd of ifs.voucherDetails) {
                      if (!seenVoucherIds.has(vd.voucherId)) {
                        seenVoucherIds.add(vd.voucherId);
                        collectedVoucherDetails.push(vd);
                      }
                    }
                  }
                }
                fs = {
                  trainingFundAmount: totalTrainingFund, voucherAmount: totalVoucher,
                  voucherDetails: collectedVoucherDetails,
                  discountCodeAmount: totalDiscount, discountCode: groupFS?.discountCode || null,
                  stripePaymentIntentId, cardAmount: totalCard, accountAmount: totalAccount,
                  totalCost, paymentMethod, xeroInvoiceId, xeroInvoiceNumber, invoicingEmail,
                  ticketCount: selectedCount, consolidated: false,
                };
              } else {
                fs = reviewDialog?.items?.[0]?.financialSummary;
              }

              if (!fs) return null;
              const hasTrainingFund = fs.trainingFundAmount > 0;
              const hasVoucher = fs.voucherAmount > 0;
              const hasDiscount = fs.discountCodeAmount > 0;
              const hasStripe = !!fs.stripePaymentIntentId;
              const hasXero = !!fs.xeroInvoiceId;
              const hasAnything = hasTrainingFund || hasVoucher || hasDiscount || hasStripe || hasXero;

              if (!hasAnything) return null;

              const stripeMax = hasStripe ? (fs.cardAmount || 0) : 0;
              const xeroMax = hasXero ? (fs.totalCost || 0) : 0;

              return (
                <div className="space-y-3" data-testid="section-financial-summary">
                  <div className="flex items-center gap-2 flex-wrap">
                    <RotateCcw className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium">Financial Reversal Summary</p>
                    {hasGroupFS && allTicketsSelected && fs.consolidated && (
                      <Badge variant="outline" className="text-blue-600 border-blue-300 text-xs">
                        Consolidated ({selectedCount} tickets)
                      </Badge>
                    )}
                    {hasGroupFS && !allTicketsSelected && (
                      <Badge variant="outline" className="text-amber-700 border-amber-300 text-xs">
                        {selectedCount} of {totalCount} selected (individual processing)
                      </Badge>
                    )}
                  </div>

                  {hasGroupFS && allTicketsSelected && (groupFS?.hasMultipleStripeIntents || groupFS?.hasMultipleXeroInvoices) && (
                    <div className="p-3 border border-orange-200 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-800 rounded-md" data-testid="warning-multi-financial">
                      <div className="flex items-center gap-2 text-xs text-orange-700 dark:text-orange-700">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        <span>
                          {groupFS.hasMultipleStripeIntents && groupFS.hasMultipleXeroInvoices
                            ? 'This group has multiple Stripe payment intents and Xero invoices. Consolidated approval will be rejected — deselect some tickets to process individually.'
                            : groupFS.hasMultipleStripeIntents
                              ? 'This group has multiple Stripe payment intents. Consolidated refund will be rejected — deselect some tickets to process individually.'
                              : 'This group has multiple Xero invoices. Consolidated credit note will be rejected — deselect some tickets to process individually.'}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 text-sm">
                    {hasTrainingFund && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-training-fund">
                          <span>Training Fund Reinstatement</span>
                          <Badge variant="outline">£{fs.trainingFundAmount.toFixed(2)}</Badge>
                        </div>
                        {!refundInFull && (
                          <div className="pl-4 space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              Custom amount (max: £{fs.trainingFundAmount.toFixed(2)})
                            </Label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">£</span>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                max={fs.trainingFundAmount}
                                value={allocationTrainingFund}
                                onChange={(e) => setAllocationTrainingFund(e.target.value)}
                                className="pl-7"
                                placeholder={fs.trainingFundAmount.toFixed(2)}
                                data-testid="input-allocation-training-fund"
                              />
                            </div>
                            {allocationTrainingFund !== '' && parseFloat(allocationTrainingFund) > fs.trainingFundAmount && (
                              <p className="text-xs text-destructive">Cannot exceed £{fs.trainingFundAmount.toFixed(2)}</p>
                            )}
                          </div>
                        )}
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
                            <div key={v.voucherId} className="space-y-1 pl-4" data-testid={`row-voucher-detail-${v.voucherId}`}>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <CheckCircle className="w-3 h-3 text-green-600 shrink-0" />
                                <span>Voucher {v.code}: £{parseFloat(v.amount).toFixed(2)} will be reinstated</span>
                              </div>
                              {!refundInFull && (
                                <div className="pl-5 space-y-1">
                                  <Label className="text-xs text-muted-foreground">
                                    Custom reinstatement (max: £{parseFloat(v.amount).toFixed(2)})
                                  </Label>
                                  <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">£</span>
                                    <Input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      max={parseFloat(v.amount)}
                                      value={allocationVouchers[v.voucherId] || ''}
                                      onChange={(e) => setAllocationVouchers(prev => ({ ...prev, [v.voucherId]: e.target.value }))}
                                      className="pl-7"
                                      placeholder={parseFloat(v.amount).toFixed(2)}
                                      data-testid={`input-allocation-voucher-${v.voucherId}`}
                                    />
                                  </div>
                                  {allocationVouchers[v.voucherId] && parseFloat(allocationVouchers[v.voucherId]) > parseFloat(v.amount) && (
                                    <p className="text-xs text-destructive">Cannot exceed £{parseFloat(v.amount).toFixed(2)}</p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                          return (
                            <div key={v.voucherId} className="space-y-2 p-3 border border-orange-200 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-800 rounded-md" data-testid={`row-voucher-expired-${v.voucherId}`}>
                              <div className="flex items-center gap-2 text-xs">
                                <AlertTriangle className="w-3 h-3 text-orange-600 shrink-0" />
                                <span className="text-orange-700 dark:text-orange-700">Voucher {v.code} expired {v.expiresAt ? format(new Date(v.expiresAt), "MMM d, yyyy") : ''} — £{parseFloat(v.amount).toFixed(2)} cannot be reinstated</span>
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
                              <span className="text-orange-700 dark:text-orange-700">Discount code expired {fs.discountCode.expiresAt ? format(new Date(fs.discountCode.expiresAt), "MMM d, yyyy") : ''} — usage cannot be reversed</span>
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

                    {hasStripe && stripeMax > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-stripe">
                          <span>Stripe Refund</span>
                          <Badge variant="outline">£{stripeMax.toFixed(2)}</Badge>
                        </div>
                        {!refundInFull && (
                          <div className="pl-4 space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              Custom Stripe refund (max: £{stripeMax.toFixed(2)})
                            </Label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">£</span>
                              <Input
                                type="number"
                                step="0.01"
                                min="0.01"
                                max={stripeMax}
                                value={customRefundAmount}
                                onChange={(e) => setCustomRefundAmount(e.target.value)}
                                className="pl-7"
                                placeholder={stripeMax.toFixed(2)}
                                data-testid="input-custom-stripe-amount"
                              />
                            </div>
                            {customRefundAmount !== '' && (parseFloat(customRefundAmount) <= 0 || parseFloat(customRefundAmount) > stripeMax) && (
                              <p className="text-xs text-destructive" data-testid="text-stripe-error">
                                {parseFloat(customRefundAmount) <= 0 ? 'Amount must be greater than zero' : `Cannot exceed £${stripeMax.toFixed(2)}`}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {hasXero && xeroMax > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between p-2 bg-muted rounded-md" data-testid="row-xero">
                          <span>Xero Credit Note (#{fs.xeroInvoiceNumber})</span>
                          <Badge variant="outline">£{xeroMax.toFixed(2)}</Badge>
                        </div>
                        {!refundInFull && (
                          <div className="pl-4 space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              Custom credit note amount (max: £{xeroMax.toFixed(2)})
                            </Label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">£</span>
                              <Input
                                type="number"
                                step="0.01"
                                min="0.01"
                                max={xeroMax}
                                value={customInvoiceAmount}
                                onChange={(e) => setCustomInvoiceAmount(e.target.value)}
                                className="pl-7"
                                placeholder={xeroMax.toFixed(2)}
                                data-testid="input-custom-invoice-amount"
                              />
                            </div>
                            {customInvoiceAmount !== '' && (parseFloat(customInvoiceAmount) <= 0 || parseFloat(customInvoiceAmount) > xeroMax) && (
                              <p className="text-xs text-destructive">
                                {parseFloat(customInvoiceAmount) <= 0 ? 'Amount must be greater than zero' : `Cannot exceed £${xeroMax.toFixed(2)}`}
                              </p>
                            )}
                          </div>
                        )}
                        <div className="pl-4 space-y-1">
                          <Label htmlFor="credit-note-email" className="text-xs text-muted-foreground">
                            Email credit note to (leave blank to skip)
                          </Label>
                          <Input
                            id="credit-note-email"
                            type="email"
                            value={creditNoteEmail}
                            onChange={(e) => setCreditNoteEmail(e.target.value)}
                            placeholder="invoicing@example.com"
                            data-testid="input-credit-note-email"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-4 pt-2 border-t">
                    <Label htmlFor="refund-in-full" className="text-sm font-medium cursor-pointer">
                      Refund in full
                    </Label>
                    <Switch
                      id="refund-in-full"
                      checked={refundInFull}
                      onCheckedChange={(checked) => {
                        setRefundInFull(checked);
                        if (checked) {
                          setCustomRefundAmount('');
                          setAllocationTrainingFund('');
                          setAllocationVouchers({});
                          setCustomInvoiceAmount('');
                        } else {
                          if (stripeMax > 0) setCustomRefundAmount(stripeMax.toFixed(2));
                          if (xeroMax > 0) setCustomInvoiceAmount(xeroMax.toFixed(2));
                          if (fs.trainingFundAmount > 0) setAllocationTrainingFund(fs.trainingFundAmount.toFixed(2));
                          const vAllocs = {};
                          (fs.voucherDetails || []).forEach(v => {
                            if (!v.expired) vAllocs[v.voucherId] = parseFloat(v.amount).toFixed(2);
                          });
                          if (Object.keys(vAllocs).length > 0) setAllocationVouchers(vAllocs);
                        }
                      }}
                      data-testid="switch-refund-in-full"
                    />
                  </div>
                  {!refundInFull && (
                    <p className="text-xs text-muted-foreground">
                      Refund amounts pre-populated by preference: Stripe/Invoice, then Training Fund, then Vouchers. Adjust amounts as needed.
                    </p>
                  )}
                </div>
              );
            })()}

            {reviewDialog?._type !== 'transfer' && (
              <div className="flex items-center justify-between gap-4 p-3 border rounded-md" data-testid="section-email-toggle">
                <div className="flex items-center gap-2">
                  {sendEmails ? <Mail className="w-4 h-4 text-muted-foreground" /> : <MailX className="w-4 h-4 text-muted-foreground" />}
                  <Label htmlFor="send-emails" className="text-sm font-medium cursor-pointer">
                    Send notification emails
                  </Label>
                </div>
                <Switch
                  id="send-emails"
                  checked={sendEmails}
                  onCheckedChange={setSendEmails}
                  data-testid="switch-send-emails"
                />
              </div>
            )}

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
              <p className="text-xs text-muted-foreground">
                {sendEmails
                  ? 'These notes will be included in the notification email sent to the ticket holder and/or booker.'
                  : 'Notification emails are suppressed. Notes will only be stored for internal reference.'}
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setReviewDialog(null); setReviewNotes(""); setVoucherReplacements({}); setDiscountCodeReplacement({ create: false, newExpiryDate: "" }); setRefundInFull(true); setCustomRefundAmount(''); setCreditNoteEmail(''); setSelectedTickets({}); setSendEmails(true); setAllocationTrainingFund(''); setAllocationVouchers({}); setCustomInvoiceAmount(''); }}
              data-testid="button-review-cancel"
            >
              Cancel
            </Button>
            <Button
              variant={reviewDialog?.action === 'approved' ? 'default' : 'destructive'}
              onClick={() => reviewDialog?._type === 'transfer' ? handleTransferReview(reviewDialog?.action) : handleReview(reviewDialog?.action)}
              disabled={processing || (reviewDialog?._type !== 'transfer' && reviewDialog?.items?.length > 1 && Object.values(selectedTickets).filter(Boolean).length === 0) || (reviewDialog?.action === 'approved' && reviewDialog?._type !== 'transfer' && !refundInFull && customRefundAmount !== '' && (parseFloat(customRefundAmount) <= 0))}
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
                  {reviewDialog?.items?.length > 1
                    ? `Approve ${Object.values(selectedTickets).filter(Boolean).length} Selected`
                    : 'Confirm Approval'}
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 mr-1" />
                  {reviewDialog?.items?.length > 1
                    ? `Reject ${Object.values(selectedTickets).filter(Boolean).length} Selected`
                    : 'Confirm Rejection'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
