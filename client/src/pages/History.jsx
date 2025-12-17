
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Ticket, ShoppingCart, Calendar, ArrowUpCircle, ArrowDownCircle, FileText, Download, Eye, Loader2, CreditCard, User, Building2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { format } from "date-fns";
import { toast } from "sonner";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function HistoryPage({ hasBanner }) {
  const { memberInfo, organizationInfo, memberRole, isFeatureExcluded, reloadMemberInfo, refreshOrganizationInfo } = useMemberAccess();
  const [downloadingInvoice, setDownloadingInvoice] = useState(null);
  const [loadingBookingInvoice, setLoadingBookingInvoice] = useState(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [currentInvoiceUrl, setCurrentInvoiceUrl] = useState(null);
  const [currentInvoiceNumber, setCurrentInvoiceNumber] = useState(null);
  const [showTour, setShowTour] = useState(false);
  const [tourAutoShow, setTourAutoShow] = useState(false);
  const [activeTab, setActiveTab] = useState("all");

  // Determine if tours should be shown for this user
  const shouldShowTours = memberRole?.show_tours !== false;

  // Check if user has seen this page's tour
  const hasSeenTour = memberInfo?.page_tours_seen?.History === true;

  // Auto-show tour on first visit if tours are enabled
  useEffect(() => {
    if (shouldShowTours && !hasSeenTour && memberInfo) {
      setTourAutoShow(true);
      setShowTour(true);
    }
  }, [shouldShowTours, hasSeenTour, memberInfo]);

  const { data: transactions = [], isLoading: transactionsLoading } = useQuery({
    queryKey: ['program-transactions', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      const allTransactions = await base44.entities.ProgramTicketTransaction.list('-created_date');
      return allTransactions.filter((t) => t.organization_id === organizationInfo.id);
    },
    enabled: !!organizationInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch one-off event bookings for the organization
  const { data: bookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['org-bookings', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      // Filter bookings by organization_id and is_one_off_event
      const allBookings = await base44.entities.Booking.filter({ organization_id: organizationInfo.id });
      // Return only one-off event bookings sorted by date
      return allBookings
        .filter(b => b.is_one_off_event === true)
        .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    },
    enabled: !!organizationInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch events for display info
  const { data: events = [] } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list(),
    staleTime: 60000,
  });

  // Group bookings by booking_group_reference for display
  const bookingGroups = React.useMemo(() => {
    const groups = {};
    bookings.forEach(booking => {
      const ref = booking.booking_group_reference || booking.booking_reference || booking.id;
      if (!groups[ref]) {
        groups[ref] = [];
      }
      groups[ref].push(booking);
    });
    // Convert to array and sort by first booking's created_date (handle null dates)
    return Object.entries(groups)
      .map(([ref, items]) => ({
        reference: ref,
        bookings: items,
        firstBooking: items[0],
        created_date: items[0].created_date,
        event: events.find(e => e.id === items[0].event_id)
      }))
      .sort((a, b) => {
        const dateA = a.created_date ? new Date(a.created_date).getTime() : 0;
        const dateB = b.created_date ? new Date(b.created_date).getTime() : 0;
        return dateB - dateA;
      });
  }, [bookings, events]);

  const isLoading = transactionsLoading || bookingsLoading;

  if (!memberInfo || !organizationInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>);

  }

  
  const updateMemberTourStatus = async (tourKey) => {
    if (memberInfo && !memberInfo.is_team_member) {
      try {
        const allMembers = await base44.entities.Member.listAll();
        const currentMember = allMembers.find((m) => m.email === memberInfo.email);

        if (currentMember) {
          const updatedTours = { ...(currentMember.page_tours_seen || {}), [tourKey]: true };
          await base44.entities.Member.update(currentMember.id, {
            page_tours_seen: updatedTours
          });

          const updatedMemberInfo = { ...memberInfo, page_tours_seen: updatedTours };
          sessionStorage.setItem('agcas_member', JSON.stringify(updatedMemberInfo));
          
          // Notify Layout to reload memberInfo
          if (reloadMemberInfo) {
            reloadMemberInfo();
          }
        }
      } catch (error) {
        console.error('Failed to update tour status:', error);
      }
    }
  };

  const handleTourComplete = async () => {
    setShowTour(false);
    setTourAutoShow(false);
  };

  const handleTourDismiss = async () => {
    setShowTour(false);
    setTourAutoShow(false);
    await updateMemberTourStatus('History');
  };

  const handleStartTour = () => {
    setShowTour(false);
    setTourAutoShow(false);

    setTimeout(() => {
      setShowTour(true);
      setTourAutoShow(true);
    }, 10);
  };

  const handleViewInvoice = async (transaction) => {
    if (!transaction.xero_invoice_pdf_uri) {
      toast.error('Invoice not available');
      return;
    }

    setDownloadingInvoice(transaction.id);

    try {
      // Get signed URL from Base44
      const response = await base44.integrations.Core.CreateFileSignedUrl({
        file_uri: transaction.xero_invoice_pdf_uri,
        expires_in: 300
      });

      if (response.signed_url) {
        // Fetch the PDF as a blob with explicit type
        const pdfResponse = await fetch(response.signed_url);
        const arrayBuffer = await pdfResponse.arrayBuffer();

        // Create a blob with explicit PDF MIME type
        const pdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });

        // Create a blob URL for inline viewing
        const blobUrl = URL.createObjectURL(pdfBlob);

        // Add parameters to hide navigation panes and fit to page
        const pdfUrl = `${blobUrl}#view=Fit&navpanes=0&toolbar=0`;

        setCurrentInvoiceUrl(pdfUrl);
        setCurrentInvoiceNumber(transaction.xero_invoice_number);
        setInvoiceModalOpen(true);
      } else {
        toast.error('Failed to generate invoice link');
      }
    } catch (error) {
      console.error('Error loading invoice:', error);
      toast.error('Failed to load invoice');
    } finally {
      setDownloadingInvoice(null);
    }
  };

  const handleDownloadInvoice = () => {
    if (!currentInvoiceUrl) return;

    const link = document.createElement('a');
    link.href = currentInvoiceUrl;
    link.download = `invoice-${currentInvoiceNumber || 'download'}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Downloading invoice...');
  };

  // Handle viewing invoice for standard ticket bookings (uses API endpoint)
  const handleViewBookingInvoice = async (bookingGroupRef, invoiceNumber) => {
    setLoadingBookingInvoice(bookingGroupRef);
    
    try {
      const response = await fetch(`/api/booking-invoice/${encodeURIComponent(bookingGroupRef)}?inline=true`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to load invoice' }));
        throw new Error(error.error || 'Failed to load invoice');
      }
      
      const pdfBlob = await response.blob();
      const blobUrl = URL.createObjectURL(pdfBlob);
      const pdfUrl = `${blobUrl}#view=Fit&navpanes=0&toolbar=0`;
      
      setCurrentInvoiceUrl(pdfUrl);
      setCurrentInvoiceNumber(invoiceNumber);
      setInvoiceModalOpen(true);
    } catch (error) {
      console.error('Error loading invoice:', error);
      toast.error(error.message || 'Failed to load invoice');
    } finally {
      setLoadingBookingInvoice(null);
    }
  };

  const handleDownloadBookingInvoice = async (bookingGroupRef, invoiceNumber) => {
    setLoadingBookingInvoice(bookingGroupRef);
    
    try {
      const response = await fetch(`/api/booking-invoice/${encodeURIComponent(bookingGroupRef)}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to download invoice' }));
        throw new Error(error.error || 'Failed to download invoice');
      }
      
      const pdfBlob = await response.blob();
      const blobUrl = URL.createObjectURL(pdfBlob);
      
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `invoice-${invoiceNumber || bookingGroupRef}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
      toast.success('Downloading invoice...');
    } catch (error) {
      console.error('Error downloading invoice:', error);
      toast.error(error.message || 'Failed to download invoice');
    } finally {
      setLoadingBookingInvoice(null);
    }
  };

  // Cleanup blob URL when modal closes
  const handleModalClose = (open) => {
    if (!open && currentInvoiceUrl) {
      // Remove any URL parameters before revoking
      const baseBlobUrl = currentInvoiceUrl.split('#')[0];
      URL.revokeObjectURL(baseBlobUrl);
      setCurrentInvoiceUrl(null);
      setCurrentInvoiceNumber(null);
    }
    setInvoiceModalOpen(open);
  };

  // Component for standard ticket booking group
  const BookingGroupCard = ({ group, loadingBookingInvoice, handleViewBookingInvoice, handleDownloadBookingInvoice }) => {
    const { reference, bookings, firstBooking, event } = group;
    const eventTitle = event?.title || firstBooking.event_name || 'Event';
    const totalCost = bookings.reduce((sum, b) => sum + (b.total_cost || 0), 0);
    const attendeeCount = bookings.length;
    // Check both xero_invoice_number and xero_invoice_id for invoice availability (matching Bookings page logic)
    const hasInvoice = !!(firstBooking.xero_invoice_number || firstBooking.xero_invoice_id);

    return (
      <div className="flex flex-col gap-3 p-4 bg-slate-50 rounded-lg border border-slate-200">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-lg bg-blue-100 text-blue-600">
            <CreditCard className="w-5 h-5" />
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="font-semibold text-slate-900">{eventTitle}</h3>
              <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                One-off Event
              </Badge>
            </div>
            
            <div className="space-y-1">
              <p className="text-sm text-slate-600">
                {attendeeCount} attendee{attendeeCount > 1 ? 's' : ''} • £{totalCost.toFixed(2)}
              </p>
              <p className="text-xs text-slate-500">
                Ref: {reference}
              </p>
              {firstBooking.purchase_order_number && (
                <p className="text-xs text-slate-500">
                  PO: {firstBooking.purchase_order_number}
                </p>
              )}
              {hasInvoice && firstBooking.xero_invoice_number && (
                <p className="text-xs text-slate-500">
                  Invoice: {firstBooking.xero_invoice_number}
                </p>
              )}
            </div>
            
            {firstBooking.created_date && (
              <p className="text-xs text-slate-500 mt-1">
                {format(new Date(firstBooking.created_date), 'MMM d, yyyy • h:mm a')}
              </p>
            )}
          </div>
          
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-semibold text-blue-600">
              £{totalCost.toFixed(2)}
            </span>
          </div>
        </div>
        
        {/* Attendees list */}
        <div className="pl-[52px]">
          <div className="text-xs text-slate-500 mb-2">Attendees:</div>
          <div className="flex flex-wrap gap-2">
            {bookings.slice(0, 5).map((booking, idx) => (
              <Badge key={idx} variant="secondary" className="text-xs">
                <User className="w-3 h-3 mr-1" />
                {booking.attendee_first_name && booking.attendee_last_name 
                  ? `${booking.attendee_first_name} ${booking.attendee_last_name}`
                  : booking.attendee_email || 'Pending'}
              </Badge>
            ))}
            {bookings.length > 5 && (
              <Badge variant="secondary" className="text-xs">
                +{bookings.length - 5} more
              </Badge>
            )}
          </div>
        </div>
        
        {/* Invoice buttons */}
        {hasInvoice && (
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleViewBookingInvoice(reference, firstBooking.xero_invoice_number || reference)}
              disabled={loadingBookingInvoice === reference}
              data-testid={`button-view-invoice-${reference}`}
            >
              {loadingBookingInvoice === reference ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Eye className="w-4 h-4 mr-1" />
                  View Invoice
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDownloadBookingInvoice(reference, firstBooking.xero_invoice_number || reference)}
              disabled={loadingBookingInvoice === reference}
              data-testid={`button-download-invoice-${reference}`}
            >
              {loadingBookingInvoice === reference ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Download className="w-4 h-4 mr-1" />
                  Download
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    );
  };

  // Component for program ticket transaction
  const ProgramTransactionCard = ({ transaction, downloadingInvoice, handleViewInvoice }) => {
    let icon, colorClass, label;
    if (transaction.transaction_type === 'purchase') {
      icon = ShoppingCart;
      colorClass = 'bg-green-100 text-green-600';
      label = 'Purchase';
    } else if (transaction.transaction_type === 'refund') {
      icon = ArrowUpCircle;
      colorClass = 'bg-blue-100 text-blue-600';
      label = 'Return to balance';
    } else {
      icon = Calendar;
      colorClass = 'bg-purple-100 text-purple-600';
      label = 'Used for Event';
    }

    const Icon = icon;

    return (
      <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
        <div className={`p-3 rounded-lg ${colorClass}`}>
          <Icon className="w-5 h-5" />
        </div>
        
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-slate-900">{label}</h3>
            <Badge variant="outline" className="text-xs">
              {transaction.program_name}
            </Badge>
          </div>
          
          {transaction.transaction_type === 'purchase' ? (
            <div className="space-y-1">
              <p className="text-sm text-slate-600">
                {transaction.purchase_order_number && `PO: ${transaction.purchase_order_number} • `}
                {transaction.quantity} ticket{transaction.quantity > 1 ? 's' : ''}
              </p>
              {transaction.xero_invoice_number && (
                <p className="text-xs text-slate-500">
                  Invoice: {transaction.xero_invoice_number}
                </p>
              )}
            </div>
          ) : transaction.transaction_type === 'refund' ? (
            <p className="text-sm text-slate-600">
              {transaction.event_name} • {transaction.quantity} ticket{transaction.quantity > 1 ? 's' : ''} returned
              {transaction.booking_reference && ` • ${transaction.booking_reference}`}
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              {transaction.event_name} • {transaction.quantity} ticket{transaction.quantity > 1 ? 's' : ''}
              {transaction.booking_reference && ` • ${transaction.booking_reference}`}
            </p>
          )}
          
          {transaction.created_date && (
            <p className="text-xs text-slate-500 mt-1">
              {format(new Date(transaction.created_date), 'MMM d, yyyy • h:mm a')}
            </p>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1 font-semibold ${
            transaction.transaction_type === 'purchase' ? 'text-green-600' :
            transaction.transaction_type === 'refund' ? 'text-blue-600' :
            'text-purple-600'
          }`}>
            {transaction.transaction_type === 'purchase' ? (
              <ArrowUpCircle className="w-4 h-4" />
            ) : transaction.transaction_type === 'refund' ? (
              <ArrowUpCircle className="w-4 h-4" />
            ) : (
              <ArrowDownCircle className="w-4 h-4" />
            )}
            <span>
              {transaction.transaction_type === 'usage' ? '-' : '+'}
              {transaction.quantity}
            </span>
          </div>

          {transaction.xero_invoice_pdf_uri && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleViewInvoice(transaction)}
              disabled={downloadingInvoice === transaction.id}
              className="shrink-0"
              data-testid={`button-invoice-${transaction.id}`}
            >
              {downloadingInvoice === transaction.id ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <FileText className="w-4 h-4 mr-1" />
                  Invoice
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {showTour && shouldShowTours &&
      <PageTour
        tourGroupName="History"
        viewId={null}
        onComplete={handleTourComplete}
        onDismissPermanently={handleTourDismiss}
        autoShow={tourAutoShow} />

      }

      <div className="max-w-7xl mx-auto">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900" id="history-page-title">
                History
              </h1>
              {shouldShowTours &&
              <TourButton onClick={handleStartTour} />
              }
            </div>
            <p className="text-slate-600">View your organisation's transaction history
            </p>
          </div>
        )}

        {/* Transaction History with Tabs */}
        <Card className="border-slate-200 shadow-sm" id="transaction-history-card">
          <CardHeader className="border-b border-slate-200">
            <CardTitle>Transaction History</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isLoading ? (
              <div className="text-center py-8 text-slate-600">Loading transactions...</div>
            ) : (transactions.length === 0 && bookingGroups.length === 0) ? (
              <div className="text-center py-8">
                <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-600">No transactions yet</p>
              </div>
            ) : (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-4">
                  <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
                  <TabsTrigger value="tickets" data-testid="tab-tickets">
                    Standard Tickets ({bookingGroups.length})
                  </TabsTrigger>
                  <TabsTrigger value="program" data-testid="tab-program">
                    Program Tickets ({transactions.length})
                  </TabsTrigger>
                </TabsList>

                {/* All Transactions Tab */}
                <TabsContent value="all" className="space-y-6">
                  {/* Standard Ticket Purchases Section */}
                  {bookingGroups.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                        <CreditCard className="w-4 h-4" />
                        Standard Ticket Purchases
                      </h3>
                      {bookingGroups.map((group) => (
                        <BookingGroupCard
                          key={group.reference}
                          group={group}
                          loadingBookingInvoice={loadingBookingInvoice}
                          handleViewBookingInvoice={handleViewBookingInvoice}
                          handleDownloadBookingInvoice={handleDownloadBookingInvoice}
                        />
                      ))}
                    </div>
                  )}

                  {/* Program Ticket Transactions Section */}
                  {transactions.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                        <Ticket className="w-4 h-4" />
                        Program Ticket Transactions
                      </h3>
                      {transactions.map((transaction) => (
                        <ProgramTransactionCard
                          key={transaction.id}
                          transaction={transaction}
                          downloadingInvoice={downloadingInvoice}
                          handleViewInvoice={handleViewInvoice}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                {/* Standard Tickets Tab */}
                <TabsContent value="tickets" className="space-y-3">
                  {bookingGroups.length === 0 ? (
                    <div className="text-center py-8">
                      <CreditCard className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-slate-600">No standard ticket purchases</p>
                    </div>
                  ) : (
                    bookingGroups.map((group) => (
                      <BookingGroupCard
                        key={group.reference}
                        group={group}
                        loadingBookingInvoice={loadingBookingInvoice}
                        handleViewBookingInvoice={handleViewBookingInvoice}
                        handleDownloadBookingInvoice={handleDownloadBookingInvoice}
                      />
                    ))
                  )}
                </TabsContent>

                {/* Program Tickets Tab */}
                <TabsContent value="program" className="space-y-3">
                  {transactions.length === 0 ? (
                    <div className="text-center py-8">
                      <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-slate-600">No program ticket transactions</p>
                    </div>
                  ) : (
                    transactions.map((transaction) => (
                      <ProgramTransactionCard
                        key={transaction.id}
                        transaction={transaction}
                        downloadingInvoice={downloadingInvoice}
                        handleViewInvoice={handleViewInvoice}
                      />
                    ))
                  )}
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Invoice Viewer Modal */}
      <Dialog open={invoiceModalOpen} onOpenChange={handleModalClose}>
        <DialogContent className="max-w-4xl h-[90vh] p-0 flex flex-col">
          <DialogHeader className="p-6 pb-4 border-b border-slate-200 shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle>
                Invoice {currentInvoiceNumber || 'Preview'}
              </DialogTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadInvoice}
                className="gap-2">

                <Download className="w-4 h-4" />
                Download
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            {currentInvoiceUrl ?
            <iframe
              src={currentInvoiceUrl}
              className="w-full h-full border-0"
              title="Invoice PDF" /> :


            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
              </div>
            }
          </div>
        </DialogContent>
      </Dialog>
    </div>);

}
