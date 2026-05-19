
import React from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, MapPin, Clock, User, Ticket, AlertCircle, Pencil, Send, Loader2, FileText, Download, Eye, XCircle, ArrowRightLeft, Search, ArrowUpDown } from "lucide-react";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";
import TransferTicketDialog from "@/components/TransferTicketDialog";

export default function BookingsPage() {
  const { memberInfo, memberRole, isFeatureExcluded } = useMemberAccess();
  
  const canAccessInvoices = !isFeatureExcluded('commerce.bookings.access-invoices');
  const { hasBanner } = useLayoutContext();
  const queryClient = useQueryClient();
  const [showCancelDialog, setShowCancelDialog] = React.useState(false);
  const [cancelTarget, setCancelTarget] = React.useState(null);
  const [cancelReason, setCancelReason] = React.useState('');
  const [submittingCancel, setSubmittingCancel] = React.useState(false);
  const [termsAgreed, setTermsAgreed] = React.useState(false);
  const [deadlinePassed, setDeadlinePassed] = React.useState(false);
  const [showTermsModal, setShowTermsModal] = React.useState(false);
  const [showTour, setShowTour] = React.useState(false);
  const [tourAutoShow, setTourAutoShow] = React.useState(false);
  const [poInputValues, setPoInputValues] = React.useState({});
  const [submittingPoFor, setSubmittingPoFor] = React.useState(null);
  const [loadingInvoiceFor, setLoadingInvoiceFor] = React.useState(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = React.useState(false);
  const [currentInvoiceUrl, setCurrentInvoiceUrl] = React.useState(null);
  const [currentInvoiceNumber, setCurrentInvoiceNumber] = React.useState(null);
  const [loadingCreditNoteFor, setLoadingCreditNoteFor] = React.useState(null);
  const [creditNoteModalOpen, setCreditNoteModalOpen] = React.useState(false);
  const [currentCreditNoteUrl, setCurrentCreditNoteUrl] = React.useState(null);
  const [currentCreditNoteNumber, setCurrentCreditNoteNumber] = React.useState(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState('desc');
  
  // Add ref to track if tour has been auto-started in this session
  const hasAutoStartedTour = React.useRef(false);

  // Determine if tours should be shown for this user
  const shouldShowTours = memberRole?.show_tours !== false;

  // Check if user has seen this page's tour
  const hasSeenTour = memberInfo?.page_tours_seen?.Bookings === true;

  // Auto-show tour on first visit if tours are enabled
  React.useEffect(() => {
    if (shouldShowTours && !hasSeenTour && memberInfo && !hasAutoStartedTour.current) {
      hasAutoStartedTour.current = true; // Mark as auto-started
      setTourAutoShow(true);
      setShowTour(true);
    }
  }, [shouldShowTours, hasSeenTour, memberInfo]);

  const { data: regularBookings = [], isLoading: loadingBookings } = useQuery({
    queryKey: ['my-bookings', memberInfo?.id || memberInfo?.email],
    queryFn: async () => {
      if (!memberInfo) return [];
      
      const memberId = memberInfo.id;
      
      if (!memberId) {
        console.log('[Bookings] No member ID in memberInfo');
        return [];
      }
      
      const myBookings = await base44.entities.Booking.filter({ member_id: memberId });
      return myBookings.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    },
    enabled: !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: complexBookingsData, isLoading: loadingComplexBookings } = useQuery({
    queryKey: ['my-complex-bookings', memberInfo?.id],
    queryFn: async () => {
      const response = await fetch('/api/complex-event-bookings', {
        credentials: 'include',
      });
      if (!response.ok) return { bookings: [], events: {}, sessions: {} };
      return response.json();
    },
    enabled: !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const complexEventsMap = complexBookingsData?.events || {};
  const complexSessionsMap = complexBookingsData?.sessions || {};

  const bookings = React.useMemo(() => {
    const regular = regularBookings.map(b => ({ ...b, _source: 'regular' }));

    const complex = (complexBookingsData?.bookings || []).map(b => {
      const ce = complexEventsMap[b.event_id];
      return {
        ...b,
        _source: 'complex',
        total_cost: parseFloat(b.total_paid) || 0,
        account_amount: parseFloat(b.account_balance_amount) || 0,
        voucher_amount: parseFloat(b.voucher_amount) || 0,
        training_fund_amount: parseFloat(b.training_fund_amount) || 0,
        discount_code_amount: parseFloat(b.discount_amount) || 0,
        ticket_class: b.ticket_class_name,
        created_date: b.created_at,
        booking_reference: b.booking_reference,
        booking_group_reference: b.booking_group_reference || b.booking_reference,
        event_name: ce?.title || 'Complex Event',
        purchase_order_number: b.purchase_order_number || null,
        po_to_follow: b.po_to_follow || false,
        xero_invoice_id: b.xero_invoice_id || null,
        xero_invoice_number: b.xero_invoice_number || null,
        xero_credit_note_id: b.xero_credit_note_id || null,
        xero_credit_note_number: b.xero_credit_note_number || null,
        _complexEvent: ce || null,
        _sessions: complexSessionsMap[b.id] || [],
      };
    });

    return [...regular, ...complex];
  }, [regularBookings, complexBookingsData, complexEventsMap, complexSessionsMap]);

  const { data: events = [], isLoading: loadingEvents } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: cancellationRequests = [] } = useQuery({
    queryKey: ['my-cancellation-requests'],
    queryFn: async () => {
      const response = await fetch('/api/booking-cancellation-requests', {
        credentials: 'include',
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.requests || [];
    },
    enabled: !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const isDevDomain = window.location.hostname.endsWith('.dev.iconn.app');

  const { data: cancellationSettings } = useQuery({
    queryKey: ['system-setting', 'cancellation_settings', isDevDomain],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const termsSetting = allSettings.find(s => s.setting_key === 'event_booking_terms');
      const deadlineSetting = allSettings.find(s => s.setting_key === 'cancellation_deadline_hours');

      const transferKey = isDevDomain ? 'allow_ticket_transfer__dev' : 'allow_ticket_transfer';
      const cancellationKey = isDevDomain ? 'allow_ticket_cancellation__dev' : 'allow_ticket_cancellation';
      const allowTransferSetting = allSettings.find(s => s.setting_key === transferKey)
        || allSettings.find(s => s.setting_key === 'allow_ticket_transfer');
      const allowCancellationSetting = allSettings.find(s => s.setting_key === cancellationKey)
        || allSettings.find(s => s.setting_key === 'allow_ticket_cancellation');

      return {
        termsContent: termsSetting?.setting_value || '',
        deadlineHours: parseInt(deadlineSetting?.setting_value) || 0,
        allowTicketTransfer: allowTransferSetting ? allowTransferSetting.setting_value !== 'false' : true,
        allowTicketCancellation: allowCancellationSetting ? allowCancellationSetting.setting_value !== 'false' : true,
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  const bookingTermsContent = cancellationSettings?.termsContent || '';
  const cancellationDeadlineHours = cancellationSettings?.deadlineHours || 0;
  const allowTicketTransfer = cancellationSettings?.allowTicketTransfer !== false;
  const allowTicketCancellation = cancellationSettings?.allowTicketCancellation !== false;

  const pendingCancelBookingIds = React.useMemo(() => {
    return new Set(
      cancellationRequests
        .filter(r => r.status === 'pending')
        .map(r => r.booking_id)
    );
  }, [cancellationRequests]);

  const [showTransferDialog, setShowTransferDialog] = React.useState(false);
  const [transferTarget, setTransferTarget] = React.useState(null);

  const { data: transferRequests = [] } = useQuery({
    queryKey: ['my-transfer-requests'],
    queryFn: async () => {
      const response = await fetch('/api/booking-transfer-requests', {
        credentials: 'include',
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.requests || [];
    },
    enabled: !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const pendingTransferBookingIds = React.useMemo(() => {
    return new Set(
      transferRequests
        .filter(r => r.status === 'pending')
        .map(r => r.booking_id)
    );
  }, [transferRequests]);

  const handleTransferClick = (booking) => {
    setTransferTarget(booking);
    setShowTransferDialog(true);
  };

  const handleTourComplete = async () => {
    setShowTour(false);
    setTourAutoShow(false);
  };

  const handleTourDismiss = async () => {
    setShowTour(false);
    setTourAutoShow(false);
    await updateMemberTourStatus('Bookings');
  };

  const handleStartTour = () => {
    setShowTour(false);
    setTourAutoShow(false);
    
    setTimeout(() => {
      setShowTour(true);
      setTourAutoShow(true);
    }, 10);
  };

  const updateMemberTourStatus = async (tourKey) => {
    if (memberInfo && !memberInfo.is_team_member && memberInfo.id) {
      try {
        const updatedTours = { ...(memberInfo.page_tours_seen || {}), [tourKey]: true };
        await base44.entities.Member.update(memberInfo.id, {
          page_tours_seen: updatedTours
        });
        
        const updatedMemberInfo = { ...memberInfo, page_tours_seen: updatedTours };
        localStorage.setItem('agcas_member', JSON.stringify(updatedMemberInfo));
      } catch (error) {
        console.error('Failed to update tour status:', error);
      }
    }
  };

  const handleCancelClick = (booking, groupBookings = null) => {
    const bookingSource = booking._source || 'regular';
    if (groupBookings) {
      const activeBookings = groupBookings.filter(b => b.status !== 'cancelled' && !pendingCancelBookingIds.has(b.id));
      setCancelTarget({ type: 'group', bookings: activeBookings, booking_group_reference: booking.booking_group_reference, bookingSource });
    } else {
      setCancelTarget({ type: 'individual', bookings: [booking], bookingSource });
    }
    setCancelReason('');

    if (cancellationDeadlineHours > 0 && booking.event_id) {
      const isComplex = bookingSource === 'complex';
      const event = isComplex ? booking._complexEvent : events.find(e => e.id === booking.event_id);
      if (event?.start_date) {
        const eventStart = new Date(event.start_date);
        const now = new Date();
        const hoursUntilEvent = (eventStart.getTime() - now.getTime()) / (1000 * 60 * 60);
        setDeadlinePassed(hoursUntilEvent < cancellationDeadlineHours);
      } else {
        setDeadlinePassed(false);
      }
    } else {
      setDeadlinePassed(false);
    }

    setShowCancelDialog(true);
  };

  const handleCancelSubmit = async () => {
    if (!cancelTarget || cancelTarget.bookings.length === 0) {
      setShowCancelDialog(false);
      return;
    }

    if (bookingTermsContent && !termsAgreed) {
      toast.error('You must agree to the cancellation terms and conditions before submitting.');
      return;
    }

    setSubmittingCancel(true);

    try {
      const response = await fetch('/api/booking-cancellation-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          booking_ids: cancelTarget.bookings.map(b => b.id),
          booking_group_reference: cancelTarget.booking_group_reference || null,
          request_type: cancelTarget.type,
          reason: cancelReason.trim() || null,
          booking_source: cancelTarget.bookingSource || 'regular',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to submit cancellation request');
      }

      toast.success(
        cancelTarget.type === 'group'
          ? 'Cancellation request submitted for all tickets'
          : 'Cancellation request submitted'
      );
      setShowCancelDialog(false);
      setCancelTarget(null);
      setCancelReason('');
      setTermsAgreed(false);
      setDeadlinePassed(false);
      queryClient.invalidateQueries({ queryKey: ['my-cancellation-requests'] });
      queryClient.invalidateQueries({ queryKey: ['my-complex-bookings'] });
    } catch (error) {
      console.error('Cancellation request error:', error);
      toast.error(error.message || 'Failed to submit cancellation request. Please try again.');
    } finally {
      setSubmittingCancel(false);
    }
  };

  const handleSubmitPurchaseOrder = async (stateKey, apiReference, bookingId, hasXeroInvoice, bookingSource = 'regular') => {
    const poNumber = poInputValues[stateKey]?.trim();
    if (!poNumber) {
      toast.error('Please enter a PO number');
      return;
    }

    setSubmittingPoFor(stateKey);

    const showXeroWarning = (xeroError) => {
      toast.warning('Saved locally — Xero not updated', {
        description: `The PO number was saved, but the Xero invoice could not be updated: ${xeroError}`,
      });
    };

    try {
      if (hasXeroInvoice) {
        if (bookingSource === 'complex') {
          const poResp = await fetch('/api/complex-event-bookings/update-po', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ booking_id: bookingId, purchase_order_number: poNumber }),
          });
          const poData = await poResp.json();
          if (!poResp.ok) {
            throw new Error(poData.error || 'Failed to save PO number');
          }
          if (poData.xeroUpdated === false && poData.xeroError) {
            showXeroWarning(poData.xeroError);
          } else {
            toast.success('PO number added and invoice updated successfully');
          }
        } else {
          try {
            const response = await base44.functions.invoke('updateXeroInvoicePO', {
              bookingGroupReference: apiReference,
              purchaseOrderNumber: poNumber,
              bookingSource: bookingSource,
            });

            if (!response.data.success) {
              throw new Error(response.data.error || 'Failed to update invoice');
            }

            if (response.data.xeroUpdated === false && response.data.xeroError) {
              showXeroWarning(response.data.xeroError);
            } else {
              toast.success('PO number added and invoice updated successfully');
            }
          } catch (invokeError) {
            // Fall back to entity PATCH (which also pushes to Xero) on function-level failures.
            console.error('updateXeroInvoicePO failed, falling back to entity PATCH:', invokeError?.message);
            const updateResult = await base44.entities.Booking.update(bookingId, {
              purchase_order_number: poNumber,
              po_to_follow: false
            });
            const sync = updateResult?._xeroPoSync;
            if (sync && sync.xeroUpdated === false && sync.xeroError) {
              showXeroWarning(sync.xeroError);
            } else if (sync && sync.xeroUpdated === true) {
              toast.success('PO number added and invoice updated successfully');
            } else {
              toast.info('PO number saved. Invoice will be updated shortly.');
            }
          }
        }
      } else {
        if (bookingSource === 'complex') {
          const poResp = await fetch('/api/complex-event-bookings/update-po', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ booking_id: bookingId, purchase_order_number: poNumber }),
          });
          const poData = await poResp.json();
          if (!poResp.ok) {
            throw new Error(poData.error || 'Failed to save PO number');
          }
          if (poData.xeroUpdated === false && poData.xeroError) {
            showXeroWarning(poData.xeroError);
          } else {
            toast.success('Purchase order number submitted successfully');
          }
        } else {
          const updateResult = await base44.entities.Booking.update(bookingId, {
            purchase_order_number: poNumber,
            po_to_follow: false
          });
          const sync = updateResult?._xeroPoSync;
          if (sync && sync.xeroUpdated === false && sync.xeroError) {
            showXeroWarning(sync.xeroError);
          } else {
            toast.success('Purchase order number submitted successfully');
          }
        }
      }

      setPoInputValues(prev => ({ ...prev, [stateKey]: '' }));
      queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['my-complex-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['pending-po-bookings'] });
    } catch (error) {
      console.error('Error submitting PO number:', error);
      toast.error(error.message || 'Failed to submit PO number. Please try again.');
    } finally {
      setSubmittingPoFor(null);
    }
  };

  const handleViewInvoice = async (stateKey, apiRef, invoiceNumber) => {
    setLoadingInvoiceFor(stateKey);
    
    try {
      const response = await fetch(`/api/booking-invoice/${encodeURIComponent(apiRef)}?inline=true`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to load invoice' }));
        throw new Error(error.error || 'Failed to load invoice');
      }
      
      // Get the PDF as a blob
      const pdfBlob = await response.blob();
      const blobUrl = URL.createObjectURL(pdfBlob);
      
      // Add parameters to hide navigation panes and fit to page
      const pdfUrl = `${blobUrl}#view=Fit&navpanes=0&toolbar=0`;
      
      setCurrentInvoiceUrl(pdfUrl);
      setCurrentInvoiceNumber(invoiceNumber);
      setInvoiceModalOpen(true);
    } catch (error) {
      console.error('Error loading invoice:', error);
      toast.error(error.message || 'Failed to load invoice');
    } finally {
      setLoadingInvoiceFor(null);
    }
  };

  const handleDownloadInvoice = async (stateKey, apiRef, invoiceNumber) => {
    setLoadingInvoiceFor(stateKey);
    
    try {
      const response = await fetch(`/api/booking-invoice/${encodeURIComponent(apiRef)}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to download invoice' }));
        throw new Error(error.error || 'Failed to download invoice');
      }
      
      // Get the PDF as a blob
      const pdfBlob = await response.blob();
      const blobUrl = URL.createObjectURL(pdfBlob);
      
      // Create download link
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `invoice-${invoiceNumber || apiRef}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Cleanup
      setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
      
      toast.success('Downloading invoice...');
    } catch (error) {
      console.error('Error downloading invoice:', error);
      toast.error(error.message || 'Failed to download invoice');
    } finally {
      setLoadingInvoiceFor(null);
    }
  };

  const handleInvoiceModalClose = (open) => {
    if (!open && currentInvoiceUrl) {
      const baseBlobUrl = currentInvoiceUrl.split('#')[0];
      URL.revokeObjectURL(baseBlobUrl);
      setCurrentInvoiceUrl(null);
      setCurrentInvoiceNumber(null);
    }
    setInvoiceModalOpen(open);
  };

  const handleViewCreditNote = async (stateKey, apiRef, creditNoteNumber) => {
    setLoadingCreditNoteFor(stateKey);
    try {
      const response = await fetch(`/api/booking-credit-note/${encodeURIComponent(apiRef)}?inline=true`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to load credit note' }));
        throw new Error(error.error || 'Failed to load credit note');
      }
      const blob = await response.blob();
      const pdfUrl = URL.createObjectURL(blob) + '#toolbar=1&navpanes=0';
      setCurrentCreditNoteUrl(pdfUrl);
      setCurrentCreditNoteNumber(creditNoteNumber);
      setCreditNoteModalOpen(true);
    } catch (error) {
      console.error('Error loading credit note:', error);
      toast.error(error.message || 'Failed to load credit note');
    } finally {
      setLoadingCreditNoteFor(null);
    }
  };

  const handleDownloadCreditNote = async (stateKey, apiRef, creditNoteNumber) => {
    setLoadingCreditNoteFor(stateKey);
    try {
      const response = await fetch(`/api/booking-credit-note/${encodeURIComponent(apiRef)}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to download credit note' }));
        throw new Error(error.error || 'Failed to download credit note');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `credit-note-${creditNoteNumber || apiRef}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 100);
      toast.success('Downloading credit note...');
    } catch (error) {
      console.error('Error downloading credit note:', error);
      toast.error(error.message || 'Failed to download credit note');
    } finally {
      setLoadingCreditNoteFor(null);
    }
  };

  const handleCreditNoteModalClose = (open) => {
    if (!open && currentCreditNoteUrl) {
      const baseBlobUrl = currentCreditNoteUrl.split('#')[0];
      URL.revokeObjectURL(baseBlobUrl);
      setCurrentCreditNoteUrl(null);
      setCurrentCreditNoteNumber(null);
    }
    setCreditNoteModalOpen(open);
  };

  if (!memberInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const isLoading = loadingBookings || loadingEvents || loadingComplexBookings;

  const filteredAndSortedGroups = React.useMemo(() => {
    const grouped = bookings.reduce((acc, booking) => {
      const rawRef = booking.booking_group_reference || booking.booking_reference || 'unknown';
      const ref = booking._source === 'complex' ? `complex:${rawRef}` : rawRef;
      if (!acc[ref]) acc[ref] = [];
      acc[ref].push(booking);
      return acc;
    }, {});

    let entries = Object.entries(grouped);

    const query = searchQuery.toLowerCase().trim();
    if (query) {
      entries = entries.filter(([ref, groupBookings]) => {
        const firstBooking = groupBookings[0];
        const isComplex = firstBooking._source === 'complex';
        const event = isComplex ? firstBooking._complexEvent : events.find(e => e.id === firstBooking.event_id);
        const eventTitle = event?.title || firstBooking.event_name || '';
        const eventLocation = event?.location || '';
        return (
          eventTitle.toLowerCase().includes(query) ||
          eventLocation.toLowerCase().includes(query) ||
          ref.toLowerCase().includes(query) ||
          groupBookings.some(b =>
            (b.booking_reference || '').toLowerCase().includes(query) ||
            (b.attendee_email || '').toLowerCase().includes(query) ||
            (b.attendee_first_name || '').toLowerCase().includes(query) ||
            (b.attendee_last_name || '').toLowerCase().includes(query) ||
            (b.ticket_class || b.ticket_class_name || '').toLowerCase().includes(query) ||
            (b.status || '').toLowerCase().includes(query)
          )
        );
      });
    }

    entries.sort((a, b) => {
      const aFirst = a[1][0];
      const bFirst = b[1][0];
      const eventA = aFirst._source === 'complex' ? aFirst._complexEvent : events.find(e => e.id === aFirst.event_id);
      const eventB = bFirst._source === 'complex' ? bFirst._complexEvent : events.find(e => e.id === bFirst.event_id);
      const dateA = eventA?.start_date ? new Date(eventA.start_date).getTime() : (aFirst.created_date ? new Date(aFirst.created_date).getTime() : 0);
      const dateB = eventB?.start_date ? new Date(eventB.start_date).getTime() : (bFirst.created_date ? new Date(bFirst.created_date).getTime() : 0);
      return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });

    return entries;
  }, [bookings, events, searchQuery, sortOrder]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'confirmed':
        return 'bg-green-100 text-green-700 border-green-200';
      case 'pending':
        return 'bg-warning/10 text-warning border-warning/30';
      case 'cancelled':
        return 'bg-red-100 text-red-700 border-red-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {showTour && shouldShowTours && (
        <PageTour
          tourGroupName="Bookings"
          viewId={null}
          onComplete={handleTourComplete}
          onDismissPermanently={handleTourDismiss}
          autoShow={tourAutoShow}
        />
      )}

      <div className="max-w-7xl mx-auto">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                Bookings
              </h1>
              {shouldShowTours && (
                <TourButton onClick={handleStartTour} />
              )}
            </div>
            <p className="text-slate-600">
              View and manage your event registrations
            </p>
          </div>
        )}

        {!isLoading && bookings.length > 0 && (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by event, location, reference, attendee..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-bookings"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="default"
                onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
                data-testid="button-toggle-sort"
              >
                <ArrowUpDown className="h-4 w-4 mr-2" />
                Date {sortOrder === 'desc' ? 'Newest first' : 'Oldest first'}
              </Button>
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {filteredAndSortedGroups.length} booking{filteredAndSortedGroups.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="grid md:grid-cols-2 gap-6">
            {Array(4).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <CardHeader>
                  <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-1/2" />
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
        ) : bookings.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Calendar className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No bookings yet
              </h3>
              <p className="text-slate-600 mb-6">
                Your event registrations will appear here once you book tickets
              </p>
              <Link to={createPageUrl('Events')}>
                <button className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
                  Browse Events
                </button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {filteredAndSortedGroups.length === 0 && searchQuery ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <Search className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">
                    No matching bookings
                  </h3>
                  <p className="text-slate-600">
                    No bookings match "{searchQuery}". Try a different search term.
                  </p>
                </CardContent>
              </Card>
            ) : null}
            {filteredAndSortedGroups.map(([bookingRef, groupBookings], index) => {
              const displayRef = bookingRef.startsWith('complex:') ? bookingRef.slice(8) : bookingRef;
              const firstBooking = groupBookings[0];
              const isComplex = firstBooking._source === 'complex';
              const event = isComplex ? firstBooking._complexEvent : events.find(e => e.id === firstBooking.event_id);
              
              const isOneOffEvent = firstBooking.is_one_off_event || event?.is_one_off;
              const hasXeroData = !!(firstBooking.xero_invoice_id || firstBooking.xero_invoice_number);
              const showFinancials = isOneOffEvent || isComplex || hasXeroData;
              const eventTitle = event?.title || firstBooking.event_name || 'Event';
              const startDate = event?.start_date ? new Date(event.start_date) : null;
              const endDate = event?.end_date ? new Date(event.end_date) : null;
              const eventLocation = event?.location;
              const eventImageUrl = event?.image_url;
              const programTag = event?.program_tag;
              const complexSessions = isComplex ? (firstBooking._sessions || []) : [];

              return (
                <Card 
                  key={bookingRef} 
                  id={index === 0 ? "first-booking-card" : undefined}
                  className="border-slate-200 shadow-sm hover:shadow-md transition-shadow"
                >
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <CardTitle className="text-xl">{eventTitle}</CardTitle>
                          {isComplex && (
                            <Badge variant="outline" className="bg-indigo-100 text-indigo-700 border-indigo-200">
                              Multi-Session Event
                            </Badge>
                          )}
                          {isOneOffEvent && !isComplex && (
                            <Badge variant="outline" className="bg-purple-100 text-purple-700 border-purple-200">
                              One-off Event
                            </Badge>
                          )}
                          {programTag && !isOneOffEvent && !isComplex && (
                            <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200">
                              {programTag}
                            </Badge>
                          )}
                        </div>
                        
                        <div className="space-y-2">
                          {startDate && (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <Calendar className="w-4 h-4 text-slate-400" />
                              <span>
                                {format(startDate, "EEEE, MMMM d, yyyy")}
                                {isComplex && endDate && format(endDate, "yyyy-MM-dd") !== format(startDate, "yyyy-MM-dd") && (
                                  <> – {format(endDate, "EEEE, MMMM d, yyyy")}</>
                                )}
                              </span>
                            </div>
                          )}
                          
                          {startDate && !isComplex && (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <Clock className="w-4 h-4 text-slate-400" />
                              <span>{format(startDate, "h:mm a")}</span>
                            </div>
                          )}
                          
                          {eventLocation && (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <MapPin className="w-4 h-4 text-slate-400" />
                              <span>{eventLocation}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      {eventImageUrl && (
                        <img 
                          src={eventImageUrl} 
                          alt={eventTitle}
                          className="w-24 h-24 object-cover rounded-lg"
                        />
                      )}
                    </div>
                  </CardHeader>
                  
                  <CardContent className="pt-6">
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-sm">
                        <Ticket className="w-4 h-4 text-slate-400" />
                        <span className="text-slate-600">Booking Reference:</span>
                        <span className="font-semibold text-slate-900">{displayRef}</span>
                      </div>
                      
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                          <h4 className="text-sm font-semibold text-slate-700">
                            Attendees ({groupBookings.length})
                          </h4>
                          {allowTicketCancellation && groupBookings.filter(b => b.status !== 'cancelled' && !pendingCancelBookingIds.has(b.id)).length > 1 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleCancelClick(groupBookings[0], groupBookings)}
                              disabled={startDate && startDate < new Date()}
                              data-testid={`button-cancel-all-${bookingRef}`}
                            >
                              <XCircle className="w-4 h-4 mr-1" />
                              Cancel All
                            </Button>
                          )}
                        </div>
                        <div className="grid md:grid-cols-2 gap-3">
                          {groupBookings.map((booking, bookingIndex) => {
                            const isCancelled = booking.status === 'cancelled';
                            const hasPendingCancel = pendingCancelBookingIds.has(booking.id);
                            const hasPendingTransfer = pendingTransferBookingIds.has(booking.id);
                            const hasPendingRequest = hasPendingCancel || hasPendingTransfer;
                            
                            return (
                              <div 
                                key={booking.id}
                                id={index === 0 && bookingIndex === 0 ? "first-ticket-card" : undefined}
                                className={`flex flex-col gap-2 p-3 rounded-lg border ${
                                  isCancelled 
                                    ? 'bg-red-50/50 border-red-200' 
                                    : hasPendingRequest
                                    ? 'bg-warning/50 border-warning/30'
                                    : 'bg-slate-50 border-slate-200'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex items-center gap-2 flex-1 min-w-0">
                                    <User className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                                    <div className="flex-1 min-w-0">
                                      {booking.attendee_first_name && booking.attendee_last_name ? (
                                        <div>
                                          <p className={`text-sm font-medium truncate ${
                                            isCancelled ? 'line-through text-slate-500' : 'text-slate-900'
                                          }`}>
                                            {booking.attendee_first_name} {booking.attendee_last_name}
                                          </p>
                                          <p className={`text-xs truncate ${
                                            isCancelled ? 'text-slate-400' : 'text-slate-500'
                                          }`}>
                                            {booking.attendee_email}
                                          </p>
                                        </div>
                                      ) : booking.attendee_email ? (
                                        <p className={`text-sm truncate ${
                                          isCancelled ? 'line-through text-slate-500' : 'text-slate-700'
                                        }`}>
                                          {booking.attendee_email}
                                        </p>
                                      ) : (
                                        <p className="text-sm text-slate-500 italic">
                                          Pending confirmation
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                                    {hasPendingCancel ? (
                                      <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">
                                        Cancellation Requested
                                      </Badge>
                                    ) : hasPendingTransfer ? (
                                      <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200" data-testid={`badge-pending-transfer-${booking.id}`}>
                                        Transfer Pending
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className={getStatusColor(isCancelled ? 'cancelled' : booking.status)}>
                                        {isCancelled ? 'cancelled' : booking.status}
                                      </Badge>
                                    )}
                                    {!isCancelled && !hasPendingRequest && (
                                      <>
                                        {allowTicketTransfer && (
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleTransferClick(booking)}
                                            disabled={startDate && startDate < new Date()}
                                            data-testid={`button-transfer-ticket-${booking.id}`}
                                          >
                                            <ArrowRightLeft className="w-3.5 h-3.5 mr-1" />
                                            Transfer
                                          </Button>
                                        )}
                                        {allowTicketCancellation && (
                                          <Button
                                            id={index === 0 && bookingIndex === 0 ? "first-ticket-edit-button" : undefined}
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleCancelClick(booking)}
                                            disabled={startDate && startDate < new Date()}
                                            data-testid={`button-cancel-ticket-${booking.id}`}
                                          >
                                            <XCircle className="w-3.5 h-3.5 mr-1" />
                                            Cancel
                                          </Button>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                                
                                {booking.backstage_order_id && (
                                  <div className="flex items-center gap-2 text-xs text-slate-500 pl-6">
                                    <Ticket className="w-3 h-3 text-purple-400" />
                                    <span className="font-mono text-purple-600 bg-purple-50 px-2 py-0.5 rounded">
                                      {booking.backstage_order_id}
                                    </span>
                                  </div>
                                )}
                                {isComplex && booking.ticket_class_name && (
                                  <div className="flex items-center gap-2 text-xs text-slate-500 pl-6">
                                    <Ticket className="w-3 h-3 text-slate-400" />
                                    <span className="text-slate-600">Ticket: {booking.ticket_class_name}</span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      
                      {isComplex && complexSessions.length > 0 && (
                        <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
                          <h4 className="text-sm font-semibold text-indigo-700 mb-3">Session Schedule</h4>
                          <div className="space-y-2">
                            {complexSessions.map(session => (
                              <div key={session.id} className="flex items-start gap-3 text-sm">
                                <div className="flex items-center gap-1 text-indigo-600 shrink-0 min-w-[140px]">
                                  <Clock className="w-3 h-3" />
                                  {session.start_time ? (
                                    <span className="text-xs">
                                      {format(new Date(session.start_time), "MMM d, h:mm a")}
                                      {session.end_time && (<> – {format(new Date(session.end_time), "h:mm a")}</>)}
                                    </span>
                                  ) : (
                                    <span className="text-xs">TBC</span>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <span className="text-slate-800">{session.title}</span>
                                  {session.track_name && (
                                    <span className="ml-2 text-xs text-indigo-500">({session.track_name})</span>
                                  )}
                                  {session.location && (
                                    <span className="ml-2 text-xs text-slate-500">{session.location}</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {showFinancials && firstBooking.total_cost > 0 && (
                        <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                          <h4 className="text-sm font-semibold text-slate-700 mb-3">Payment Summary</h4>
                          <div className="space-y-2 text-sm">
                            {/* Calculate totals across all bookings in this group */}
                            {(() => {
                              const totalCost = groupBookings.reduce((sum, b) => sum + (b.total_cost || 0), 0);
                              const voucherAmount = groupBookings.reduce((sum, b) => sum + (b.voucher_amount || 0), 0);
                              const trainingFundAmount = groupBookings.reduce((sum, b) => sum + (b.training_fund_amount || 0), 0);
                              const discountAmount = groupBookings.reduce((sum, b) => sum + (parseFloat(b.discount_code_amount || b.discount_amount) || 0), 0);
                              const accountAmount = groupBookings.reduce((sum, b) => sum + (b.account_amount || 0), 0);
                              const cardAmount = firstBooking.stripe_payment_intent_id ? (totalCost - voucherAmount - trainingFundAmount - discountAmount - accountAmount) : 0;
                              
                              return (
                                <>
                                  <div className="flex justify-between">
                                    <span className="text-slate-600">Total Cost:</span>
                                    <span className="font-medium">£{totalCost.toFixed(2)}</span>
                                  </div>
                                  {voucherAmount > 0 && (
                                    <div className="flex justify-between text-green-700">
                                      <span>Training Vouchers:</span>
                                      <span>-£{voucherAmount.toFixed(2)}</span>
                                    </div>
                                  )}
                                  {trainingFundAmount > 0 && (
                                    <div className="flex justify-between text-green-700">
                                      <span>Training Fund:</span>
                                      <span>-£{trainingFundAmount.toFixed(2)}</span>
                                    </div>
                                  )}
                                  {discountAmount > 0 && (
                                    <div className="flex justify-between text-green-700">
                                      <span>Discount:</span>
                                      <span>-£{discountAmount.toFixed(2)}</span>
                                    </div>
                                  )}
                                  {accountAmount > 0 && (
                                    <div className="flex justify-between">
                                      <span className="text-slate-600">Charged to Account:</span>
                                      <span className="font-medium">£{accountAmount.toFixed(2)}</span>
                                    </div>
                                  )}
                                  {cardAmount > 0 && (
                                    <div className="flex justify-between">
                                      <span className="text-slate-600">Paid by Card:</span>
                                      <span className="font-medium">£{cardAmount.toFixed(2)}</span>
                                    </div>
                                  )}
                                  {firstBooking.purchase_order_number && (
                                    <div className="flex justify-between pt-2 border-t border-slate-200">
                                      <span className="text-slate-600">PO Number:</span>
                                      <span className="font-mono text-slate-900">{firstBooking.purchase_order_number}</span>
                                    </div>
                                  )}
                                  {firstBooking.po_to_follow && !firstBooking.purchase_order_number && (
                                    <div className="pt-2 border-t border-slate-200">
                                      <div className="flex items-center justify-between mb-2">
                                        <span className="text-slate-600">PO Number:</span>
                                        <span className="text-warning italic text-sm">To be supplied</span>
                                      </div>
                                      <div className="flex gap-2">
                                        <Input
                                          type="text"
                                          placeholder="Enter PO number"
                                          value={poInputValues[bookingRef] || ''}
                                          onChange={(e) => setPoInputValues(prev => ({ ...prev, [bookingRef]: e.target.value }))}
                                          className="flex-1 text-sm"
                                          data-testid={`input-po-number-${bookingRef}`}
                                          disabled={submittingPoFor === bookingRef}
                                        />
                                        <Button
                                          size="sm"
                                          onClick={() => handleSubmitPurchaseOrder(bookingRef, displayRef, firstBooking.id, !!firstBooking.xero_invoice_id, firstBooking._source || 'regular')}
                                          disabled={submittingPoFor === bookingRef || !poInputValues[bookingRef]?.trim()}
                                          data-testid={`button-submit-po-${bookingRef}`}
                                        >
                                          {submittingPoFor === bookingRef ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                          ) : (
                                            <Send className="w-4 h-4" />
                                          )}
                                        </Button>
                                      </div>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      )}
                      
                      {canAccessInvoices && showFinancials && firstBooking.xero_invoice_number && (
                        <div className="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded-lg">
                          <div className="flex items-center gap-2">
                            <FileText className="w-4 h-4 text-blue-600" />
                            <span className="text-sm text-blue-800">
                              Invoice: <span className="font-mono font-medium">{firstBooking.xero_invoice_number}</span>
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleViewInvoice(bookingRef, displayRef, firstBooking.xero_invoice_number)}
                              disabled={loadingInvoiceFor === bookingRef}
                              data-testid={`button-view-invoice-${bookingRef}`}
                              className="border-blue-300 text-blue-700 hover:bg-blue-100"
                            >
                              {loadingInvoiceFor === bookingRef ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <>
                                  <Eye className="w-4 h-4 mr-1" />
                                  View
                                </>
                              )}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleDownloadInvoice(bookingRef, displayRef, firstBooking.xero_invoice_number)}
                              disabled={loadingInvoiceFor === bookingRef}
                              data-testid={`button-download-invoice-${bookingRef}`}
                              className="border-blue-300 text-blue-700 hover:bg-blue-100"
                            >
                              {loadingInvoiceFor === bookingRef ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <>
                                  <Download className="w-4 h-4 mr-1" />
                                  Download
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      )}
                      
                      {(() => {
                        const creditNoteBooking = canAccessInvoices && showFinancials && groupBookings.find(b => b.xero_credit_note_number);
                        if (!creditNoteBooking) return null;
                        return (
                        <div className="flex items-center justify-between p-3 bg-warning/10 border border-warning/30 rounded-lg dark:bg-warning/30 dark:border-warning">
                          <div className="flex items-center gap-2">
                            <FileText className="w-4 h-4 text-warning dark:text-warning" />
                            <span className="text-sm text-warning dark:text-warning">
                              Credit Note: <span className="font-mono font-medium">{creditNoteBooking.xero_credit_note_number}</span>
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleViewCreditNote(bookingRef, displayRef, creditNoteBooking.xero_credit_note_number)}
                              disabled={loadingCreditNoteFor === bookingRef}
                              data-testid={`button-view-credit-note-${bookingRef}`}
                              className="border-warning/30 text-warning dark:border-warning dark:text-warning"
                            >
                              {loadingCreditNoteFor === bookingRef ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <>
                                  <Eye className="w-4 h-4 mr-1" />
                                  View
                                </>
                              )}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleDownloadCreditNote(bookingRef, displayRef, creditNoteBooking.xero_credit_note_number)}
                              disabled={loadingCreditNoteFor === bookingRef}
                              data-testid={`button-download-credit-note-${bookingRef}`}
                              className="border-warning/30 text-warning dark:border-warning dark:text-warning"
                            >
                              {loadingCreditNoteFor === bookingRef ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <>
                                  <Download className="w-4 h-4 mr-1" />
                                  Download
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                        );
                      })()}

                      {groupBookings.some(b => b.status === 'pending') && (
                        <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded-lg">
                          <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                          <p className="text-xs text-warning">
                            Some bookings are pending confirmation. Confirmation links have been sent to the attendees' email addresses.
                          </p>
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

      <Dialog open={showCancelDialog} onOpenChange={(open) => { if (!open) { setShowCancelDialog(false); setCancelTarget(null); setCancelReason(''); setTermsAgreed(false); setDeadlinePassed(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deadlinePassed ? 'Cancellation Not Available' : 'Request Cancellation'}</DialogTitle>
            <DialogDescription>
              {deadlinePassed
                ? `Cancellation requests cannot be submitted within ${cancellationDeadlineHours} hour${cancellationDeadlineHours !== 1 ? 's' : ''} of the event start time.`
                : cancelTarget?.type === 'group'
                  ? `Submit a cancellation request for ${cancelTarget.bookings.length} ticket(s). An administrator will review your request.`
                  : 'Submit a cancellation request for this ticket. An administrator will review your request.'}
            </DialogDescription>
          </DialogHeader>
          {deadlinePassed ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-warning/10 border border-warning/30 rounded-md">
                <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                <div className="text-sm text-warning">
                  <p className="font-medium mb-1">Cancellation deadline has passed</p>
                  <p>
                    Cancellation requests must be submitted at least {cancellationDeadlineHours} hour{cancellationDeadlineHours !== 1 ? 's' : ''} before the event starts. Please contact an administrator directly if you need to cancel.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => { setShowCancelDialog(false); setCancelTarget(null); setDeadlinePassed(false); }}
                  data-testid="button-deadline-close"
                >
                  Close
                </Button>
              </DialogFooter>
            </div>
          ) : (
          <>
          {cancelTarget && (
            <div className="space-y-4">
              <div className="space-y-2">
                {cancelTarget.bookings.map(b => (
                  <div key={b.id} className="flex items-center gap-2 text-sm p-2 bg-slate-50 rounded-md border border-slate-200">
                    <User className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="text-slate-700 truncate" data-testid={`text-cancel-attendee-${b.id}`}>
                      {b.attendee_first_name && b.attendee_last_name
                        ? `${b.attendee_first_name} ${b.attendee_last_name}`
                        : b.attendee_email || 'Unknown attendee'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Reason for cancellation (optional)
                </label>
                <Textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Let us know why you need to cancel..."
                  className="resize-none"
                  rows={3}
                  data-testid="input-cancel-reason"
                />
              </div>
              {bookingTermsContent && (
                <div className="space-y-2 pt-2 border-t border-slate-200">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="terms-agreement"
                      checked={termsAgreed}
                      onCheckedChange={setTermsAgreed}
                      data-testid="switch-terms-agreement"
                    />
                    <Label htmlFor="terms-agreement" className="text-sm text-slate-700 cursor-pointer">
                      I agree to the cancellation terms and conditions
                    </Label>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowTermsModal(true)}
                    className="text-sm text-blue-600 hover:text-blue-800 underline inline-block cursor-pointer"
                    data-testid="button-view-terms"
                  >
                    View Terms & Conditions
                  </button>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setShowCancelDialog(false); setCancelTarget(null); setCancelReason(''); setTermsAgreed(false); setDeadlinePassed(false); }}
              data-testid="button-cancel-dialog-close"
            >
              Keep Registration
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelSubmit}
              disabled={submittingCancel || (bookingTermsContent && !termsAgreed)}
              data-testid="button-submit-cancellation"
            >
              {submittingCancel ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                'Submit Cancellation Request'
              )}
            </Button>
          </DialogFooter>
          </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showTermsModal} onOpenChange={setShowTermsModal}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Terms & Conditions</DialogTitle>
          </DialogHeader>
          <div
            className="flex-1 overflow-y-auto prose prose-sm max-w-none text-slate-700"
            dangerouslySetInnerHTML={{ __html: bookingTermsContent }}
            data-testid="text-terms-content"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowTermsModal(false)}
              data-testid="button-close-terms"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice Preview Dialog */}
      <Dialog open={invoiceModalOpen} onOpenChange={handleInvoiceModalClose}>
        <DialogContent className="max-w-4xl h-[80vh] p-0 flex flex-col">
          <DialogHeader className="p-4 pb-2 border-b">
            <DialogTitle className="flex items-center justify-between">
              <span>Invoice {currentInvoiceNumber}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (currentInvoiceUrl) {
                    const baseBlobUrl = currentInvoiceUrl.split('#')[0];
                    const link = document.createElement('a');
                    link.href = baseBlobUrl;
                    link.download = `invoice-${currentInvoiceNumber || 'download'}.pdf`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    toast.success('Downloading invoice...');
                  }
                }}
                data-testid="button-download-from-preview"
              >
                <Download className="w-4 h-4 mr-2" />
                Download
              </Button>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden p-4">
            {currentInvoiceUrl && (
              <iframe
                src={currentInvoiceUrl}
                className="w-full h-full rounded border border-slate-200"
                title={`Invoice ${currentInvoiceNumber}`}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      {/* Credit Note Preview Dialog */}
      <Dialog open={creditNoteModalOpen} onOpenChange={handleCreditNoteModalClose}>
        <DialogContent className="max-w-4xl h-[80vh] p-0 flex flex-col">
          <DialogHeader className="p-4 pb-2 border-b">
            <DialogTitle className="flex items-center justify-between">
              <span>Credit Note {currentCreditNoteNumber}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (currentCreditNoteUrl) {
                    const baseBlobUrl = currentCreditNoteUrl.split('#')[0];
                    const link = document.createElement('a');
                    link.href = baseBlobUrl;
                    link.download = `credit-note-${currentCreditNoteNumber || 'download'}.pdf`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    toast.success('Downloading credit note...');
                  }
                }}
                data-testid="button-download-credit-note-from-preview"
              >
                <Download className="w-4 h-4 mr-2" />
                Download
              </Button>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden p-4">
            {currentCreditNoteUrl && (
              <iframe
                src={currentCreditNoteUrl}
                className="w-full h-full rounded border border-slate-200"
                title={`Credit Note ${currentCreditNoteNumber}`}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      <TransferTicketDialog
        open={showTransferDialog}
        onOpenChange={(open) => { if (!open) { setShowTransferDialog(false); setTransferTarget(null); } }}
        booking={transferTarget}
        bookingSource={transferTarget?._source || 'regular'}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ['my-transfer-requests'] });
          queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
          queryClient.invalidateQueries({ queryKey: ['my-complex-bookings'] });
        }}
      />
    </div>
  );
}
