
import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Ticket, ShoppingCart, Calendar, ArrowUpCircle, ArrowDownCircle, FileText, Download, Eye, Loader2, CreditCard, User, Building2, Wallet, Gift, Search, ChevronLeft, ChevronRight, ArrowUpDown, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { format } from "date-fns";
import { toast } from "sonner";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const ITEMS_PER_PAGE = 10;

export default function HistoryPage({ hasBanner }) {
  const { memberInfo, organizationInfo, memberRole, isFeatureExcluded, reloadMemberInfo, refreshOrganizationInfo } = useMemberAccess();
  
  const canAccessInvoices = !isFeatureExcluded('commerce.history.access-invoices');
  
  const [downloadingInvoice, setDownloadingInvoice] = useState(null);
  const [loadingBookingInvoice, setLoadingBookingInvoice] = useState(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [currentInvoiceUrl, setCurrentInvoiceUrl] = useState(null);
  const [currentInvoiceNumber, setCurrentInvoiceNumber] = useState(null);
  const [showTour, setShowTour] = useState(false);
  const [tourAutoShow, setTourAutoShow] = useState(false);
  const [activeTab, setActiveTab] = useState("all");

  // Search, filter, sort, and pagination state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState("newest");
  const [typeFilter, setTypeFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortOrder, typeFilter, activeTab]);

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

  // Fetch training fund transactions for the organization
  const { data: trainingFundTransactions = [], isLoading: trainingFundLoading } = useQuery({
    queryKey: ['training-fund-transactions', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      const allTransactions = await base44.entities.TrainingFundTransaction.list();
      return allTransactions
        .filter(t => t.organization_id === organizationInfo.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },
    enabled: !!organizationInfo?.id,
    staleTime: 0,
  });

  // Fetch voucher transactions for the organization
  const { data: voucherTransactions = [], isLoading: voucherTransactionsLoading } = useQuery({
    queryKey: ['voucher-transactions-org', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      const allTransactions = await base44.entities.VoucherTransaction.list();
      return allTransactions
        .filter(t => t.organization_id === organizationInfo.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },
    enabled: !!organizationInfo?.id,
    staleTime: 0,
  });

  // Group bookings by booking_group_reference for display
  const bookingGroups = useMemo(() => {
    const groups = {};
    bookings.forEach(booking => {
      const ref = booking.booking_group_reference || booking.booking_reference || booking.id;
      if (!groups[ref]) {
        groups[ref] = [];
      }
      groups[ref].push(booking);
    });
    // Convert to array and sort by first booking's created_date or created_at (handle null dates)
    return Object.entries(groups)
      .map(([ref, items]) => ({
        reference: ref,
        bookings: items,
        firstBooking: items[0],
        created_date: items[0].created_date || items[0].created_at,
        event: events.find(e => e.id === items[0].event_id)
      }))
      .sort((a, b) => {
        const dateA = a.created_date ? new Date(a.created_date).getTime() : 0;
        const dateB = b.created_date ? new Date(b.created_date).getTime() : 0;
        return dateB - dateA;
      });
  }, [bookings, events]);

  // Filter and sort functions
  const filterAndSortData = (data, searchFields, dateField = 'created_date') => {
    let filtered = data;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = data.filter(item => {
        return searchFields.some(field => {
          const value = field.split('.').reduce((obj, key) => obj?.[key], item);
          return value && String(value).toLowerCase().includes(query);
        });
      });
    }

    // Apply sort
    const sorted = [...filtered].sort((a, b) => {
      const dateA = new Date(a[dateField] || a.created_at || 0).getTime();
      const dateB = new Date(b[dateField] || b.created_at || 0).getTime();
      return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
    });

    return sorted;
  };

  // Filter booking groups
  const filteredBookingGroups = useMemo(() => {
    let filtered = bookingGroups;

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = bookingGroups.filter(group => {
        const eventTitle = group.event?.title || group.firstBooking.event_name || '';
        const reference = group.reference || '';
        const invoiceNumber = group.firstBooking.xero_invoice_number || '';
        const poNumber = group.firstBooking.purchase_order_number || '';
        const attendees = group.bookings.map(b => 
          `${b.attendee_first_name || ''} ${b.attendee_last_name || ''} ${b.attendee_email || ''}`
        ).join(' ');
        
        return eventTitle.toLowerCase().includes(query) ||
               reference.toLowerCase().includes(query) ||
               invoiceNumber.toLowerCase().includes(query) ||
               poNumber.toLowerCase().includes(query) ||
               attendees.toLowerCase().includes(query);
      });
    }

    // Apply sort
    const sorted = [...filtered].sort((a, b) => {
      const dateA = new Date(a.created_date || 0).getTime();
      const dateB = new Date(b.created_date || 0).getTime();
      return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
    });

    return sorted;
  }, [bookingGroups, searchQuery, sortOrder]);

  // Filter program transactions
  const filteredTransactions = useMemo(() => {
    let filtered = transactions;

    if (typeFilter !== 'all') {
      filtered = transactions.filter(t => t.transaction_type === typeFilter);
    }

    return filterAndSortData(
      filtered, 
      ['program_name', 'event_name', 'booking_reference', 'purchase_order_number', 'xero_invoice_number']
    );
  }, [transactions, searchQuery, sortOrder, typeFilter]);

  // Filter training fund transactions
  const filteredTrainingFundTransactions = useMemo(() => {
    let filtered = trainingFundTransactions;

    if (typeFilter !== 'all') {
      filtered = trainingFundTransactions.filter(t => {
        if (typeFilter === 'credit') return t.type === 'add' || t.type === 'credit' || t.type === 'credit_adjustment';
        if (typeFilter === 'debit') return t.type === 'deduct' || t.type === 'debit_adjustment' || t.type === 'usage' || t.type === 'booking_usage';
        return true;
      });
    }

    return filterAndSortData(
      filtered, 
      ['reason', 'event_title', 'booking_reference'],
      'created_at'
    );
  }, [trainingFundTransactions, searchQuery, sortOrder, typeFilter]);

  // Filter voucher transactions
  const filteredVoucherTransactions = useMemo(() => {
    let filtered = voucherTransactions;

    if (typeFilter !== 'all') {
      filtered = voucherTransactions.filter(t => {
        if (typeFilter === 'credit') return t.type === 'credit_adjustment';
        if (typeFilter === 'debit') return t.type === 'debit_adjustment' || t.type === 'booking_usage';
        return true;
      });
    }

    return filterAndSortData(
      filtered, 
      ['event_title', 'booking_reference'],
      'created_at'
    );
  }, [voucherTransactions, searchQuery, sortOrder, typeFilter]);

  // Pagination helper
  const paginateData = (data) => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return {
      items: data.slice(startIndex, endIndex),
      totalItems: data.length,
      totalPages: Math.ceil(data.length / ITEMS_PER_PAGE),
      startIndex: startIndex + 1,
      endIndex: Math.min(endIndex, data.length)
    };
  };

  // Get current tab's data length for filter options
  const getTypeFilterOptions = () => {
    switch (activeTab) {
      case 'program':
        return [
          { value: 'all', label: 'All Types' },
          { value: 'purchase', label: 'Purchases' },
          { value: 'usage', label: 'Usage' },
          { value: 'refund', label: 'Returns' }
        ];
      case 'training-fund':
      case 'vouchers':
        return [
          { value: 'all', label: 'All Types' },
          { value: 'credit', label: 'Credits' },
          { value: 'debit', label: 'Debits' }
        ];
      default:
        return [];
    }
  };

  const isLoading = transactionsLoading || bookingsLoading || trainingFundLoading || voucherTransactionsLoading;

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
          localStorage.setItem('agcas_member', JSON.stringify(updatedMemberInfo));
          
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

  // Clear filters
  const clearFilters = () => {
    setSearchQuery("");
    setTypeFilter("all");
    setSortOrder("newest");
    setCurrentPage(1);
  };

  const hasActiveFilters = searchQuery.trim() || typeFilter !== 'all' || sortOrder !== 'newest';

  // Pagination Controls Component
  const PaginationControls = ({ pagination }) => {
    if (pagination.totalPages <= 1) return null;

    return (
      <div className="flex items-center justify-between pt-4 border-t border-slate-200 mt-4">
        <p className="text-sm text-slate-600">
          Showing {pagination.startIndex}-{pagination.endIndex} of {pagination.totalItems}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            data-testid="button-prev-page"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </Button>
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
              let pageNum;
              if (pagination.totalPages <= 5) {
                pageNum = i + 1;
              } else if (currentPage <= 3) {
                pageNum = i + 1;
              } else if (currentPage >= pagination.totalPages - 2) {
                pageNum = pagination.totalPages - 4 + i;
              } else {
                pageNum = currentPage - 2 + i;
              }
              
              return (
                <Button
                  key={pageNum}
                  variant={currentPage === pageNum ? "default" : "outline"}
                  size="sm"
                  className="w-8 h-8 p-0"
                  onClick={() => setCurrentPage(pageNum)}
                  data-testid={`button-page-${pageNum}`}
                >
                  {pageNum}
                </Button>
              );
            })}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(p => Math.min(pagination.totalPages, p + 1))}
            disabled={currentPage === pagination.totalPages}
            data-testid="button-next-page"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    );
  };

  // Component for standard ticket booking group with date column
  const BookingGroupCard = ({ group, loadingBookingInvoice, handleViewBookingInvoice, handleDownloadBookingInvoice, canAccessInvoices }) => {
    const { reference, bookings, firstBooking, event } = group;
    const eventTitle = event?.title || firstBooking.event_name || 'Event';
    const totalCost = bookings.reduce((sum, b) => sum + (b.total_cost || 0), 0);
    const attendeeCount = bookings.length;
    // Check both xero_invoice_number and xero_invoice_id for invoice availability (matching Bookings page logic)
    const hasInvoice = !!(firstBooking.xero_invoice_number || firstBooking.xero_invoice_id);
    const dateValue = firstBooking.created_date || firstBooking.created_at;
    const transactionDate = dateValue ? new Date(dateValue) : null;

    return (
      <div className="flex flex-col gap-3 p-4 bg-slate-50 rounded-lg border border-slate-200">
        <div className="flex items-start gap-4">
          {/* Date Column */}
          <div className="w-20 shrink-0 text-center">
            {transactionDate ? (
              <div className="flex flex-col">
                <span className="text-lg font-bold text-slate-900">{format(transactionDate, 'd')}</span>
                <span className="text-xs text-slate-600 uppercase">{format(transactionDate, 'MMM yyyy')}</span>
                <span className="text-xs text-slate-500">{format(transactionDate, 'h:mm a')}</span>
              </div>
            ) : (
              <span className="text-xs text-slate-400">No date</span>
            )}
          </div>
          
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
          </div>
          
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-semibold text-blue-600">
              £{totalCost.toFixed(2)}
            </span>
          </div>
        </div>
        
        {/* Attendees list */}
        <div className="pl-24">
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
        {canAccessInvoices && hasInvoice && (
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

  // Component for program ticket transaction with date column
  const ProgramTransactionCard = ({ transaction, downloadingInvoice, handleViewInvoice, canAccessInvoices }) => {
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
    const transactionDate = transaction.created_date ? new Date(transaction.created_date) : null;

    return (
      <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
        {/* Date Column */}
        <div className="w-20 shrink-0 text-center">
          {transactionDate ? (
            <div className="flex flex-col">
              <span className="text-lg font-bold text-slate-900">{format(transactionDate, 'd')}</span>
              <span className="text-xs text-slate-600 uppercase">{format(transactionDate, 'MMM yyyy')}</span>
              <span className="text-xs text-slate-500">{format(transactionDate, 'h:mm a')}</span>
            </div>
          ) : (
            <span className="text-xs text-slate-400">No date</span>
          )}
        </div>
        
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

          {canAccessInvoices && transaction.xero_invoice_pdf_uri && (
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

  // Component for training fund transaction with date column
  const TrainingFundTransactionCard = ({ transaction }) => {
    const isCredit = transaction.type === 'add' || transaction.type === 'credit' || transaction.type === 'credit_adjustment';
    
    const getTypeInfo = () => {
      switch (transaction.type) {
        case 'add':
        case 'credit':
        case 'credit_adjustment':
          return { label: 'Credit', color: 'bg-green-100 text-green-600' };
        case 'deduct':
        case 'debit_adjustment':
          return { label: 'Debit', color: 'bg-amber-100 text-amber-600' };
        case 'usage':
        case 'booking_usage':
          return { label: 'Booking', color: 'bg-blue-100 text-blue-600' };
        default:
          return { label: transaction.type || 'Usage', color: 'bg-slate-100 text-slate-600' };
      }
    };
    
    const typeInfo = getTypeInfo();
    const transactionDate = transaction.created_at || transaction.created_date 
      ? new Date(transaction.created_at || transaction.created_date) 
      : null;

    return (
      <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
        {/* Date Column */}
        <div className="w-20 shrink-0 text-center">
          {transactionDate ? (
            <div className="flex flex-col">
              <span className="text-lg font-bold text-slate-900">{format(transactionDate, 'd')}</span>
              <span className="text-xs text-slate-600 uppercase">{format(transactionDate, 'MMM yyyy')}</span>
              <span className="text-xs text-slate-500">{format(transactionDate, 'h:mm a')}</span>
            </div>
          ) : (
            <span className="text-xs text-slate-400">No date</span>
          )}
        </div>
        
        <div className={`p-3 rounded-lg ${typeInfo.color}`}>
          <Wallet className="w-5 h-5" />
        </div>
        
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-slate-900">Training Fund</h3>
            <Badge variant="outline" className={`text-xs ${typeInfo.color}`}>
              {typeInfo.label}
            </Badge>
          </div>
          
          {transaction.reason && (
            <p className="text-sm text-slate-600">{transaction.reason}</p>
          )}
          {transaction.event_title && (
            <p className="text-sm text-slate-600">Event: {transaction.event_title}</p>
          )}
          {transaction.booking_reference && (
            <p className="text-xs text-slate-500">Ref: {transaction.booking_reference}</p>
          )}
          
          <div className="flex items-center gap-4 text-xs text-slate-500 mt-1">
            <span>Before: £{(transaction.balance_before || 0).toFixed(2)}</span>
            <span>→</span>
            <span>After: £{(transaction.balance_after || 0).toFixed(2)}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-1">
          <span className={`text-lg font-semibold ${isCredit ? 'text-green-600' : 'text-red-600'}`}>
            {isCredit ? '+' : '-'}£{(transaction.amount || 0).toFixed(2)}
          </span>
        </div>
      </div>
    );
  };

  // Component for voucher transaction with date column
  const VoucherTransactionCard = ({ transaction }) => {
    const isCredit = transaction.type === 'credit_adjustment';
    
    const getTypeInfo = () => {
      switch (transaction.type) {
        case 'credit_adjustment':
          return { label: 'Credit', color: 'bg-green-100 text-green-600' };
        case 'debit_adjustment':
          return { label: 'Debit', color: 'bg-amber-100 text-amber-600' };
        case 'booking_usage':
          return { label: 'Booking', color: 'bg-blue-100 text-blue-600' };
        default:
          return { label: transaction.type || 'Usage', color: 'bg-slate-100 text-slate-600' };
      }
    };
    
    const typeInfo = getTypeInfo();
    const transactionDate = transaction.created_at ? new Date(transaction.created_at) : null;

    return (
      <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
        {/* Date Column */}
        <div className="w-20 shrink-0 text-center">
          {transactionDate ? (
            <div className="flex flex-col">
              <span className="text-lg font-bold text-slate-900">{format(transactionDate, 'd')}</span>
              <span className="text-xs text-slate-600 uppercase">{format(transactionDate, 'MMM yyyy')}</span>
              <span className="text-xs text-slate-500">{format(transactionDate, 'h:mm a')}</span>
            </div>
          ) : (
            <span className="text-xs text-slate-400">No date</span>
          )}
        </div>
        
        <div className={`p-3 rounded-lg ${typeInfo.color}`}>
          <Gift className="w-5 h-5" />
        </div>
        
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-slate-900">Training Voucher</h3>
            <Badge variant="outline" className={`text-xs ${typeInfo.color}`}>
              {typeInfo.label}
            </Badge>
          </div>
          
          {transaction.event_title && (
            <p className="text-sm text-slate-600">Event: {transaction.event_title}</p>
          )}
          {transaction.booking_reference && (
            <p className="text-xs text-slate-500">Ref: {transaction.booking_reference}</p>
          )}
          
          <div className="flex items-center gap-4 text-xs text-slate-500 mt-1">
            <span>Before: £{(transaction.balance_before || 0).toFixed(2)}</span>
            <span>→</span>
            <span>After: £{(transaction.balance_after || 0).toFixed(2)}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-1">
          <span className={`text-lg font-semibold ${isCredit ? 'text-green-600' : 'text-red-600'}`}>
            {isCredit ? '+' : '-'}£{(transaction.amount || 0).toFixed(2)}
          </span>
        </div>
      </div>
    );
  };

  // Search and Filter Bar Component
  const SearchFilterBar = () => {
    const typeFilterOptions = getTypeFilterOptions();
    const showTypeFilter = typeFilterOptions.length > 0;

    return (
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search transactions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search"
          />
        </div>
        
        <div className="flex gap-2">
          {showTypeFilter && (
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-type-filter">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                {typeFilterOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          
          <Select value={sortOrder} onValueChange={setSortOrder}>
            <SelectTrigger className="w-[140px]" data-testid="select-sort-order">
              <ArrowUpDown className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest First</SelectItem>
              <SelectItem value="oldest">Oldest First</SelectItem>
            </SelectContent>
          </Select>
          
          {hasActiveFilters && (
            <Button
              variant="outline"
              size="icon"
              onClick={clearFilters}
              title="Clear filters"
              data-testid="button-clear-filters"
            >
              <X className="w-4 h-4" />
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
            ) : (transactions.length === 0 && bookingGroups.length === 0 && trainingFundTransactions.length === 0 && voucherTransactions.length === 0) ? (
              <div className="text-center py-8">
                <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-600">No transactions yet</p>
              </div>
            ) : (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-4 flex-wrap">
                  <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
                  <TabsTrigger value="tickets" data-testid="tab-tickets">
                    Standard Tickets ({bookingGroups.length})
                  </TabsTrigger>
                  <TabsTrigger value="program" data-testid="tab-program">
                    Program Tickets ({transactions.length})
                  </TabsTrigger>
                  <TabsTrigger value="training-fund" data-testid="tab-training-fund">
                    Training Fund ({trainingFundTransactions.length})
                  </TabsTrigger>
                  <TabsTrigger value="vouchers" data-testid="tab-vouchers">
                    Vouchers ({voucherTransactions.length})
                  </TabsTrigger>
                </TabsList>

                {/* Search and Filter Bar */}
                <SearchFilterBar />

                {/* All Transactions Tab */}
                <TabsContent value="all" className="space-y-6">
                  {/* Standard Ticket Purchases Section */}
                  {filteredBookingGroups.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                        <CreditCard className="w-4 h-4" />
                        Standard Ticket Purchases ({filteredBookingGroups.length})
                      </h3>
                      {filteredBookingGroups.slice(0, 5).map((group) => (
                        <BookingGroupCard
                          key={group.reference}
                          group={group}
                          loadingBookingInvoice={loadingBookingInvoice}
                          handleViewBookingInvoice={handleViewBookingInvoice}
                          handleDownloadBookingInvoice={handleDownloadBookingInvoice}
                          canAccessInvoices={canAccessInvoices}
                        />
                      ))}
                      {filteredBookingGroups.length > 5 && (
                        <Button 
                          variant="link" 
                          onClick={() => setActiveTab('tickets')}
                          className="text-sm"
                        >
                          View all {filteredBookingGroups.length} standard ticket transactions
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Program Ticket Transactions Section */}
                  {filteredTransactions.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                        <Ticket className="w-4 h-4" />
                        Program Ticket Transactions ({filteredTransactions.length})
                      </h3>
                      {filteredTransactions.slice(0, 5).map((transaction) => (
                        <ProgramTransactionCard
                          key={transaction.id}
                          transaction={transaction}
                          downloadingInvoice={downloadingInvoice}
                          handleViewInvoice={handleViewInvoice}
                          canAccessInvoices={canAccessInvoices}
                        />
                      ))}
                      {filteredTransactions.length > 5 && (
                        <Button 
                          variant="link" 
                          onClick={() => setActiveTab('program')}
                          className="text-sm"
                        >
                          View all {filteredTransactions.length} program ticket transactions
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Training Fund Transactions Section */}
                  {filteredTrainingFundTransactions.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                        <Wallet className="w-4 h-4" />
                        Training Fund Transactions ({filteredTrainingFundTransactions.length})
                      </h3>
                      {filteredTrainingFundTransactions.slice(0, 5).map((transaction) => (
                        <TrainingFundTransactionCard
                          key={transaction.id}
                          transaction={transaction}
                        />
                      ))}
                      {filteredTrainingFundTransactions.length > 5 && (
                        <Button 
                          variant="link" 
                          onClick={() => setActiveTab('training-fund')}
                          className="text-sm"
                        >
                          View all {filteredTrainingFundTransactions.length} training fund transactions
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Voucher Transactions Section */}
                  {filteredVoucherTransactions.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                        <Gift className="w-4 h-4" />
                        Training Voucher Transactions ({filteredVoucherTransactions.length})
                      </h3>
                      {filteredVoucherTransactions.slice(0, 5).map((transaction) => (
                        <VoucherTransactionCard
                          key={transaction.id}
                          transaction={transaction}
                        />
                      ))}
                      {filteredVoucherTransactions.length > 5 && (
                        <Button 
                          variant="link" 
                          onClick={() => setActiveTab('vouchers')}
                          className="text-sm"
                        >
                          View all {filteredVoucherTransactions.length} voucher transactions
                        </Button>
                      )}
                    </div>
                  )}

                  {/* No results message */}
                  {filteredBookingGroups.length === 0 && 
                   filteredTransactions.length === 0 && 
                   filteredTrainingFundTransactions.length === 0 && 
                   filteredVoucherTransactions.length === 0 && 
                   searchQuery.trim() && (
                    <div className="text-center py-8">
                      <Search className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                      <p className="text-slate-600">No transactions match your search</p>
                      <Button variant="link" onClick={clearFilters} className="mt-2">
                        Clear filters
                      </Button>
                    </div>
                  )}
                </TabsContent>

                {/* Standard Tickets Tab */}
                <TabsContent value="tickets" className="space-y-3">
                  {(() => {
                    const pagination = paginateData(filteredBookingGroups);
                    return filteredBookingGroups.length === 0 ? (
                      <div className="text-center py-8">
                        <CreditCard className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                        <p className="text-slate-600">
                          {searchQuery.trim() ? 'No matching standard ticket purchases' : 'No standard ticket purchases'}
                        </p>
                        {searchQuery.trim() && (
                          <Button variant="link" onClick={clearFilters} className="mt-2">
                            Clear filters
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        {pagination.items.map((group) => (
                          <BookingGroupCard
                            key={group.reference}
                            group={group}
                            loadingBookingInvoice={loadingBookingInvoice}
                            handleViewBookingInvoice={handleViewBookingInvoice}
                            handleDownloadBookingInvoice={handleDownloadBookingInvoice}
                            canAccessInvoices={canAccessInvoices}
                          />
                        ))}
                        <PaginationControls pagination={pagination} />
                      </>
                    );
                  })()}
                </TabsContent>

                {/* Program Tickets Tab */}
                <TabsContent value="program" className="space-y-3">
                  {(() => {
                    const pagination = paginateData(filteredTransactions);
                    return filteredTransactions.length === 0 ? (
                      <div className="text-center py-8">
                        <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                        <p className="text-slate-600">
                          {searchQuery.trim() || typeFilter !== 'all' ? 'No matching program ticket transactions' : 'No program ticket transactions'}
                        </p>
                        {(searchQuery.trim() || typeFilter !== 'all') && (
                          <Button variant="link" onClick={clearFilters} className="mt-2">
                            Clear filters
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        {pagination.items.map((transaction) => (
                          <ProgramTransactionCard
                            key={transaction.id}
                            transaction={transaction}
                            downloadingInvoice={downloadingInvoice}
                            handleViewInvoice={handleViewInvoice}
                            canAccessInvoices={canAccessInvoices}
                          />
                        ))}
                        <PaginationControls pagination={pagination} />
                      </>
                    );
                  })()}
                </TabsContent>

                {/* Training Fund Tab */}
                <TabsContent value="training-fund" className="space-y-3">
                  {(() => {
                    const pagination = paginateData(filteredTrainingFundTransactions);
                    return filteredTrainingFundTransactions.length === 0 ? (
                      <div className="text-center py-8">
                        <Wallet className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                        <p className="text-slate-600">
                          {searchQuery.trim() || typeFilter !== 'all' ? 'No matching training fund transactions' : 'No training fund transactions'}
                        </p>
                        {(searchQuery.trim() || typeFilter !== 'all') && (
                          <Button variant="link" onClick={clearFilters} className="mt-2">
                            Clear filters
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        {pagination.items.map((transaction) => (
                          <TrainingFundTransactionCard
                            key={transaction.id}
                            transaction={transaction}
                          />
                        ))}
                        <PaginationControls pagination={pagination} />
                      </>
                    );
                  })()}
                </TabsContent>

                {/* Vouchers Tab */}
                <TabsContent value="vouchers" className="space-y-3">
                  {(() => {
                    const pagination = paginateData(filteredVoucherTransactions);
                    return filteredVoucherTransactions.length === 0 ? (
                      <div className="text-center py-8">
                        <Gift className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                        <p className="text-slate-600">
                          {searchQuery.trim() || typeFilter !== 'all' ? 'No matching voucher transactions' : 'No voucher transactions'}
                        </p>
                        {(searchQuery.trim() || typeFilter !== 'all') && (
                          <Button variant="link" onClick={clearFilters} className="mt-2">
                            Clear filters
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        {pagination.items.map((transaction) => (
                          <VoucherTransactionCard
                            key={transaction.id}
                            transaction={transaction}
                          />
                        ))}
                        <PaginationControls pagination={pagination} />
                      </>
                    );
                  })()}
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
