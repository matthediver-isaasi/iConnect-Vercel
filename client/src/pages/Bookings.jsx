
import React from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, MapPin, Clock, User, Ticket, AlertCircle, Pencil, Send, Loader2, FileText, Download, Eye } from "lucide-react";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { toast } from "sonner";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";

export default function BookingsPage() {
  const { memberInfo, memberRole, isFeatureExcluded } = useMemberAccess();
  
  const canAccessInvoices = !isFeatureExcluded('commerce.bookings.access-invoices');
  const { hasBanner } = useLayoutContext();
  const queryClient = useQueryClient();
  const [cancellingTicketId, setCancellingTicketId] = React.useState(null);
  const [showCancelDialog, setShowCancelDialog] = React.useState(false);
  const [ticketToCancel, setTicketToCancel] = React.useState(null);
  const [cancelledTicketIds, setCancelledTicketIds] = React.useState(new Set());
  const [showTour, setShowTour] = React.useState(false);
  const [tourAutoShow, setTourAutoShow] = React.useState(false);
  const [poInputValues, setPoInputValues] = React.useState({});
  const [submittingPoFor, setSubmittingPoFor] = React.useState(null);
  const [loadingInvoiceFor, setLoadingInvoiceFor] = React.useState(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = React.useState(false);
  const [currentInvoiceUrl, setCurrentInvoiceUrl] = React.useState(null);
  const [currentInvoiceNumber, setCurrentInvoiceNumber] = React.useState(null);
  
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

  const { data: bookings = [], isLoading: loadingBookings } = useQuery({
    queryKey: ['my-bookings', memberInfo?.id || memberInfo?.email],
    queryFn: async () => {
      if (!memberInfo) return [];
      
      // Use member ID directly from memberInfo if available
      const memberId = memberInfo.id;
      
      if (!memberId) {
        console.log('[Bookings] No member ID in memberInfo');
        return [];
      }
      
      // Filter bookings by member_id directly using the filter API
      const myBookings = await base44.entities.Booking.filter({ member_id: memberId });
      // Sort by created_date descending
      return myBookings.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    },
    enabled: !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: events = [], isLoading: loadingEvents } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

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

  const handleCancelClick = (booking) => {
    setTicketToCancel(booking);
    setShowCancelDialog(true);
  };

  const handleCancelConfirm = async () => {
    if (!ticketToCancel || !ticketToCancel.backstage_order_id) {
      toast.error('Unable to cancel: Missing ticket information');
      setShowCancelDialog(false);
      return;
    }

    setCancellingTicketId(ticketToCancel.id);
    setShowCancelDialog(false);

    try {
      const allMembers = await base44.entities.Member.listAll();
      const currentMember = allMembers.find(m => m.email === memberInfo.email);
      
      if (!currentMember) {
        toast.error('Unable to verify member identity');
        setCancellingTicketId(null);
        setTicketToCancel(null);
        return;
      }

      const response = await base44.functions.invoke('cancelTicketViaFlow', {
        orderId: ticketToCancel.backstage_order_id,
        cancelReason: 'Cancelled by member via iConnect',
        memberId: currentMember.id
      });

      if (response.data.success) {
        setCancelledTicketIds(prev => new Set([...prev, ticketToCancel.id]));
        toast.success('Ticket cancelled successfully');
        
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } else {
        throw new Error(response.data.error || 'Failed to cancel ticket');
      }
    } catch (error) {
      console.error('Cancellation error:', error);
      toast.error('Failed to cancel ticket. Please try again or contact support.');
    } finally {
      setCancellingTicketId(null);
      setTicketToCancel(null);
    }
  };

  const handleSubmitPurchaseOrder = async (bookingReference, bookingId, hasXeroInvoice) => {
    const poNumber = poInputValues[bookingReference]?.trim();
    if (!poNumber) {
      toast.error('Please enter a PO number');
      return;
    }

    setSubmittingPoFor(bookingReference);
    
    try {
      if (hasXeroInvoice) {
        // Update Xero invoice reference and refresh the PDF
        try {
          const response = await base44.functions.invoke('updateXeroInvoicePO', {
            bookingGroupReference: bookingReference,
            purchaseOrderNumber: poNumber
          });
          
          if (!response.data.success) {
            throw new Error(response.data.error || 'Failed to update invoice');
          }

          toast.success('PO number added and invoice updated successfully');
        } catch (invokeError) {
          console.error('Xero invoice update error:', invokeError?.message);
          // If Xero update fails, fall back to just updating the booking
          await base44.entities.Booking.update(bookingId, {
            purchase_order_number: poNumber,
            po_to_follow: false
          });
          toast.info('PO number saved. Invoice will be updated shortly.');
        }
      } else {
        // No Xero invoice - just update the booking directly
        await base44.entities.Booking.update(bookingId, {
          purchase_order_number: poNumber,
          po_to_follow: false
        });

        toast.success('Purchase order number submitted successfully');
      }

      setPoInputValues(prev => ({ ...prev, [bookingReference]: '' }));
      queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['pending-po-bookings'] });
    } catch (error) {
      console.error('Error submitting PO number:', error);
      toast.error(error.message || 'Failed to submit PO number. Please try again.');
    } finally {
      setSubmittingPoFor(null);
    }
  };

  const handleViewInvoice = async (bookingGroupRef, invoiceNumber) => {
    setLoadingInvoiceFor(bookingGroupRef);
    
    try {
      // Fetch the PDF with inline=true for preview (include credentials for session auth)
      const response = await fetch(`/api/booking-invoice/${encodeURIComponent(bookingGroupRef)}?inline=true`, {
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

  const handleDownloadInvoice = async (bookingGroupRef, invoiceNumber) => {
    setLoadingInvoiceFor(bookingGroupRef);
    
    try {
      // Fetch the PDF for download (include credentials for session auth)
      const response = await fetch(`/api/booking-invoice/${encodeURIComponent(bookingGroupRef)}`, {
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
      link.download = `invoice-${invoiceNumber || bookingGroupRef}.pdf`;
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
      // Remove any URL parameters before revoking
      const baseBlobUrl = currentInvoiceUrl.split('#')[0];
      URL.revokeObjectURL(baseBlobUrl);
      setCurrentInvoiceUrl(null);
      setCurrentInvoiceNumber(null);
    }
    setInvoiceModalOpen(open);
  };

  if (!memberInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const isLoading = loadingBookings || loadingEvents;

  // Group bookings by booking_group_reference (for multi-attendee bookings) 
  // or fallback to booking_reference for single-attendee/legacy bookings
  const bookingsByReference = bookings.reduce((acc, booking) => {
    const ref = booking.booking_group_reference || booking.booking_reference || 'unknown';
    if (!acc[ref]) {
      acc[ref] = [];
    }
    acc[ref].push(booking);
    return acc;
  }, {});

  const getStatusColor = (status) => {
    switch (status) {
      case 'confirmed':
        return 'bg-green-100 text-green-700 border-green-200';
      case 'pending':
        return 'bg-amber-100 text-amber-700 border-amber-200';
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
            {Object.entries(bookingsByReference).map(([bookingRef, groupBookings], index) => {
              const firstBooking = groupBookings[0];
              const event = events.find(e => e.id === firstBooking.event_id);
              
              // Use event data if available, otherwise use booking data as fallback
              const isOneOffEvent = firstBooking.is_one_off_event || event?.is_one_off;
              const eventTitle = event?.title || firstBooking.event_name || 'Event';
              const startDate = event?.start_date ? new Date(event.start_date) : null;
              const eventLocation = event?.location;
              const eventImageUrl = event?.image_url;
              const programTag = event?.program_tag;

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
                          {isOneOffEvent && (
                            <Badge className="bg-purple-100 text-purple-700 border-purple-200">
                              One-off Event
                            </Badge>
                          )}
                          {programTag && !isOneOffEvent && (
                            <Badge className="bg-blue-100 text-blue-700 border-blue-200">
                              {programTag}
                            </Badge>
                          )}
                        </div>
                        
                        <div className="space-y-2">
                          {startDate && (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <Calendar className="w-4 h-4 text-slate-400" />
                              <span>{format(startDate, "EEEE, MMMM d, yyyy")}</span>
                            </div>
                          )}
                          
                          {startDate && (
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
                        <span className="font-semibold text-slate-900">{bookingRef}</span>
                      </div>
                      
                      <div>
                        <h4 className="text-sm font-semibold text-slate-700 mb-3">
                          Attendees ({groupBookings.length})
                        </h4>
                        <div className="grid md:grid-cols-2 gap-3">
                          {groupBookings.map((booking, bookingIndex) => {
                            const isCancelled = booking.status === 'cancelled' || cancelledTicketIds.has(booking.id);
                            
                            return (
                              <div 
                                key={booking.id}
                                id={index === 0 && bookingIndex === 0 ? "first-ticket-card" : undefined}
                                className={`flex flex-col gap-2 p-3 rounded-lg border ${
                                  isCancelled 
                                    ? 'bg-red-50/50 border-red-200' 
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
                                  <div className="flex items-center gap-2 shrink-0">
                                    <Badge className={`${getStatusColor(isCancelled ? 'cancelled' : booking.status)}`}>
                                      {isCancelled ? 'cancelled' : booking.status}
                                    </Badge>
                                    {!isCancelled && booking.backstage_order_id && (
                                      <Button
                                        id={index === 0 && bookingIndex === 0 ? "first-ticket-edit-button" : undefined}
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-red-600 hover:text-red-700 hover:bg-red-50"
                                        onClick={() => handleCancelClick(booking)}
                                        disabled={cancellingTicketId === booking.id}
                                      >
                                        <Pencil className="w-3 h-3" />
                                      </Button>
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
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      
                      {/* Payment summary for one-off events */}
                      {isOneOffEvent && firstBooking.total_cost > 0 && (
                        <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
                          <h4 className="text-sm font-semibold text-slate-700 mb-3">Payment Summary</h4>
                          <div className="space-y-2 text-sm">
                            {/* Calculate totals across all bookings in this group */}
                            {(() => {
                              const totalCost = groupBookings.reduce((sum, b) => sum + (b.total_cost || 0), 0);
                              const voucherAmount = groupBookings.reduce((sum, b) => sum + (b.voucher_amount || 0), 0);
                              const trainingFundAmount = groupBookings.reduce((sum, b) => sum + (b.training_fund_amount || 0), 0);
                              const accountAmount = groupBookings.reduce((sum, b) => sum + (b.account_amount || 0), 0);
                              const cardAmount = firstBooking.stripe_payment_intent_id ? (totalCost - voucherAmount - trainingFundAmount - accountAmount) : 0;
                              
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
                                        <span className="text-amber-600 italic text-sm">To be supplied</span>
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
                                          onClick={() => handleSubmitPurchaseOrder(bookingRef, firstBooking.id, !!firstBooking.xero_invoice_id)}
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
                      
                      {/* Invoice download/preview for one-off events with Xero invoice */}
                      {canAccessInvoices && isOneOffEvent && firstBooking.xero_invoice_number && (
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
                              onClick={() => handleViewInvoice(bookingRef, firstBooking.xero_invoice_number)}
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
                              onClick={() => handleDownloadInvoice(bookingRef, firstBooking.xero_invoice_number)}
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
                      
                      {groupBookings.some(b => b.status === 'pending') && (
                        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          <p className="text-xs text-amber-800">
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

      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Registration?</AlertDialogTitle>
            <AlertDialogDescription>
              Cancelling this registration will make the ticket available for reallocation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No, keep registration</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancelConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              Yes, cancel registration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  );
}
