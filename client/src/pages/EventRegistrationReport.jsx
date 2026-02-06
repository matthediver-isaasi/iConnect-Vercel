import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Download, Calendar, Building2, CreditCard, Receipt, Ticket, Users, Banknote, ChevronLeft, ChevronRight } from "lucide-react";
import { format, parseISO } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const ITEMS_PER_PAGE = 25;

function formatCurrency(amount) {
  if (amount === null || amount === undefined) return "\u00A30.00";
  return `\u00A3${Number(amount).toFixed(2)}`;
}

function PaymentMethodBadge({ method, totalCost }) {
  if (method === 'card') {
    return (
      <Badge variant="outline" className="gap-1">
        <CreditCard className="w-3 h-3" />
        Stripe
      </Badge>
    );
  }
  if (method === 'account') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Building2 className="w-3 h-3" />
        Account
      </Badge>
    );
  }
  if (method === 'free' || Number(totalCost) === 0) {
    return <Badge variant="secondary">Free</Badge>;
  }
  return <span className="text-muted-foreground">{method || '-'}</span>;
}

export default function EventRegistrationReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState("date_desc");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_EventRegistrationReport')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: reportData, isLoading } = useQuery({
    queryKey: ['event-registration-report', selectedEventId],
    queryFn: async () => {
      let url = '/api/reports/event-registration-report';
      if (selectedEventId) {
        url += `?eventId=${encodeURIComponent(selectedEventId)}`;
      }
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch report data');
      }
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const events = reportData?.events || [];
  const bookingGroups = reportData?.bookingGroups || [];
  const organizations = reportData?.organizations || {};
  const summary = reportData?.summary || {};

  const selectedEvent = useMemo(() => {
    return events.find(e => e.id === selectedEventId);
  }, [events, selectedEventId]);

  const filteredGroups = useMemo(() => {
    let result = bookingGroups;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(group =>
        group.attendees.some(a =>
          (a.attendee_first_name || '').toLowerCase().includes(q) ||
          (a.attendee_last_name || '').toLowerCase().includes(q) ||
          (a.attendee_email || '').toLowerCase().includes(q) ||
          (organizations[a.organization_id] || '').toLowerCase().includes(q) ||
          (a.ticket_class_name || '').toLowerCase().includes(q)
        ) ||
        (group.groupPayment.purchaseOrderNumber || '').toLowerCase().includes(q) ||
        (group.groupPayment.bookingReference || '').toLowerCase().includes(q) ||
        (group.groupPayment.xeroInvoiceNumber || '').toLowerCase().includes(q)
      );
    }

    result = [...result].sort((a, b) => {
      const aFirst = a.attendees[0];
      const bFirst = b.attendees[0];
      switch (sortBy) {
        case 'name_asc':
          return (`${aFirst?.attendee_last_name} ${aFirst?.attendee_first_name}`).localeCompare(`${bFirst?.attendee_last_name} ${bFirst?.attendee_first_name}`);
        case 'name_desc':
          return (`${bFirst?.attendee_last_name} ${bFirst?.attendee_first_name}`).localeCompare(`${aFirst?.attendee_last_name} ${aFirst?.attendee_first_name}`);
        case 'org_asc':
          return (organizations[aFirst?.organization_id] || 'zzz').localeCompare(organizations[bFirst?.organization_id] || 'zzz');
        case 'total_desc':
          return (b.groupPayment.totalCost || 0) - (a.groupPayment.totalCost || 0);
        case 'total_asc':
          return (a.groupPayment.totalCost || 0) - (b.groupPayment.totalCost || 0);
        case 'date_desc':
          return new Date(bFirst?.created_at || 0) - new Date(aFirst?.created_at || 0);
        case 'date_asc':
          return new Date(aFirst?.created_at || 0) - new Date(bFirst?.created_at || 0);
        default:
          return 0;
      }
    });

    return result;
  }, [bookingGroups, searchQuery, sortBy, organizations]);

  const totalAttendees = useMemo(() => {
    return filteredGroups.reduce((sum, g) => sum + g.attendees.length, 0);
  }, [filteredGroups]);

  const totalPages = Math.ceil(filteredGroups.length / ITEMS_PER_PAGE);
  const paginatedGroups = filteredGroups.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedEventId, searchQuery]);

  const handleExportCSV = () => {
    if (filteredGroups.length === 0) return;

    const headers = [
      'Booking Group',
      'Name',
      'Email',
      'Organisation',
      'Ticket Type',
      'Ticket Price',
      'Group Discount',
      'Group Total',
      'Voucher Amount',
      'Training Fund',
      'Account Amount',
      'Payment Method',
      'PO Number',
      'PO To Follow',
      'Stripe Payment',
      'Xero Invoice',
      'Booking Reference',
      'Status',
      'Date',
      'Guest Booking'
    ];

    const rows = [];
    for (const group of filteredGroups) {
      const gp = group.groupPayment;
      group.attendees.forEach((a, idx) => {
        const isFirstInGroup = idx === 0;
        rows.push([
          group.isGroup ? (group.groupRef || 'Group') : '',
          `${a.attendee_first_name || ''} ${a.attendee_last_name || ''}`.trim(),
          a.attendee_email || '',
          organizations[a.organization_id] || (a.is_guest_booking ? 'Guest' : 'Non-member'),
          a.ticket_class_name || '',
          Number(a.ticket_price || 0).toFixed(2),
          isFirstInGroup ? (gp.discount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.totalCost || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.voucherAmount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.trainingFundAmount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.accountAmount || 0).toFixed(2) : '',
          isFirstInGroup ? (gp.paymentMethod || '') : '',
          isFirstInGroup ? (gp.purchaseOrderNumber || '') : '',
          isFirstInGroup ? (gp.poToFollow ? 'Yes' : 'No') : '',
          isFirstInGroup ? (gp.stripePaymentIntentId ? 'Yes' : 'No') : '',
          isFirstInGroup ? (gp.xeroInvoiceNumber || '') : '',
          isFirstInGroup ? (gp.bookingReference || '') : '',
          a.status || '',
          a.created_at ? format(parseISO(a.created_at), 'yyyy-MM-dd HH:mm') : '',
          a.is_guest_booking ? 'Yes' : 'No'
        ]);
      });
    }

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const eventTitle = selectedEvent?.title?.replace(/[^a-zA-Z0-9]/g, '_') || 'event';
    link.download = `registration_report_${eventTitle}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="loading-access">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-full">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Event Registration Report</h1>
          <p className="text-sm text-muted-foreground mt-1">
            View registration details and payment breakdowns for each event
          </p>
        </div>
        {selectedEventId && filteredGroups.length > 0 && (
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExportCSV}
            data-testid="button-export-csv"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium mb-1.5 block">Select Event</label>
              <Select value={selectedEventId} onValueChange={setSelectedEventId}>
                <SelectTrigger data-testid="select-event">
                  <SelectValue placeholder="Choose an event to view registrations..." />
                </SelectTrigger>
                <SelectContent>
                  {events.map(event => (
                    <SelectItem key={event.id} value={event.id} data-testid={`select-event-${event.id}`}>
                      <span className="flex items-center gap-2">
                        {event.title}
                        {event.start_date && (
                          <span className="text-muted-foreground text-xs">
                            ({format(parseISO(event.start_date), 'dd MMM yyyy')})
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center h-32" data-testid="loading-data">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {selectedEventId && !isLoading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Attendees</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-registrations">{summary.totalBookings || 0}</p>
                {summary.totalGroups > 0 && summary.totalGroups !== summary.totalBookings && (
                  <p className="text-xs text-muted-foreground mt-0.5">{summary.totalGroups} booking{summary.totalGroups !== 1 ? 's' : ''}</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Banknote className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Total Revenue</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-revenue">{formatCurrency(summary.totalRevenue)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Ticket className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Vouchers Used</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-vouchers">{formatCurrency(summary.totalVoucher)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Training Fund</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-fund">{formatCurrency(summary.totalTrainingFund)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Receipt className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Discounts</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-discounts">{formatCurrency(summary.totalDiscount)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <CreditCard className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Stripe Payments</span>
                </div>
                <p className="text-xl font-bold" data-testid="text-total-stripe">{formatCurrency(summary.totalStripePayments)}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-4">
              <CardTitle className="text-base">
                Registrations
                {totalAttendees > 0 && (
                  <span className="text-muted-foreground font-normal text-sm ml-2">
                    ({totalAttendees} attendee{totalAttendees !== 1 ? 's' : ''} in {filteredGroups.length} booking{filteredGroups.length !== 1 ? 's' : ''})
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search registrations..."
                    className="pl-8 w-[200px]"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    data-testid="input-search"
                  />
                </div>
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="w-[160px]" data-testid="select-sort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name_asc">Name A-Z</SelectItem>
                    <SelectItem value="name_desc">Name Z-A</SelectItem>
                    <SelectItem value="org_asc">Organisation A-Z</SelectItem>
                    <SelectItem value="total_desc">Total (High-Low)</SelectItem>
                    <SelectItem value="total_asc">Total (Low-High)</SelectItem>
                    <SelectItem value="date_desc">Newest First</SelectItem>
                    <SelectItem value="date_asc">Oldest First</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {filteredGroups.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground" data-testid="text-no-registrations">
                  {searchQuery ? 'No registrations match your search' : 'No registrations found for this event'}
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Name</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Organisation</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Ticket</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Price</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Discount</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Total</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Voucher</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap text-right">Fund</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Method</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">PO Number</th>
                          <th className="pb-3 pr-3 font-medium text-muted-foreground whitespace-nowrap">Invoice</th>
                          <th className="pb-3 font-medium text-muted-foreground whitespace-nowrap">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedGroups.map((group) => {
                          const gp = group.groupPayment;

                          if (!group.isGroup) {
                            const attendee = group.attendees[0];
                            const orgName = organizations[attendee.organization_id] || null;
                            const isGuest = attendee.is_guest_booking || (!attendee.organization_id && !attendee.member_id);

                            return (
                              <tr key={attendee.id} className="border-b last:border-0" data-testid={`row-booking-${attendee.id}`}>
                                <td className="py-3 pr-3">
                                  <div className="font-medium whitespace-nowrap">
                                    {`${attendee.attendee_first_name || ''} ${attendee.attendee_last_name || ''}`.trim() || 'Unknown'}
                                  </div>
                                  <div className="text-xs text-muted-foreground">{attendee.attendee_email}</div>
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {orgName ? orgName : <span className="italic text-muted-foreground">{isGuest ? 'Guest' : 'Non-member'}</span>}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">{attendee.ticket_class_name || '-'}</td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">{formatCurrency(attendee.ticket_price)}</td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">
                                  {gp.discount > 0 ? <span className="text-green-600">-{formatCurrency(gp.discount)}</span> : '-'}
                                </td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap font-medium">{formatCurrency(gp.totalCost)}</td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">
                                  {gp.voucherAmount > 0 ? formatCurrency(gp.voucherAmount) : '-'}
                                </td>
                                <td className="py-3 pr-3 text-right whitespace-nowrap">
                                  {gp.trainingFundAmount > 0 ? formatCurrency(gp.trainingFundAmount) : '-'}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  <PaymentMethodBadge method={gp.paymentMethod} totalCost={gp.totalCost} />
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {gp.purchaseOrderNumber ? (
                                    <span className="text-xs">{gp.purchaseOrderNumber}</span>
                                  ) : gp.poToFollow ? (
                                    <span className="text-xs italic text-amber-600">To follow</span>
                                  ) : '-'}
                                </td>
                                <td className="py-3 pr-3 whitespace-nowrap">
                                  {gp.xeroInvoiceNumber ? <span className="text-xs font-mono">{gp.xeroInvoiceNumber}</span> : '-'}
                                </td>
                                <td className="py-3 whitespace-nowrap">
                                  <Badge variant={attendee.status === 'confirmed' ? 'default' : attendee.status === 'cancelled' ? 'destructive' : 'secondary'}>
                                    {attendee.status || 'unknown'}
                                  </Badge>
                                </td>
                              </tr>
                            );
                          }

                          return group.attendees.map((attendee, idx) => {
                            const isFirst = idx === 0;
                            const isLast = idx === group.attendees.length - 1;
                            const orgName = organizations[attendee.organization_id] || null;
                            const isGuest = attendee.is_guest_booking || (!attendee.organization_id && !attendee.member_id);

                            return (
                              <tr
                                key={attendee.id}
                                className={`${isLast ? 'border-b' : ''} ${isFirst ? 'border-t' : ''}`}
                                style={isFirst ? { borderTopWidth: '2px' } : undefined}
                                data-testid={`row-booking-${attendee.id}`}
                              >
                                <td className="py-2 pr-3">
                                  <div className="flex items-center gap-2">
                                    {isFirst && (
                                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                        {group.attendeeCount}
                                      </Badge>
                                    )}
                                    <div>
                                      <div className="font-medium whitespace-nowrap">
                                        {`${attendee.attendee_first_name || ''} ${attendee.attendee_last_name || ''}`.trim() || 'Unknown'}
                                      </div>
                                      <div className="text-xs text-muted-foreground">{attendee.attendee_email}</div>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap">
                                  {orgName ? orgName : <span className="italic text-muted-foreground">{isGuest ? 'Guest' : 'Non-member'}</span>}
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap">{attendee.ticket_class_name || '-'}</td>
                                <td className="py-2 pr-3 text-right whitespace-nowrap">{formatCurrency(attendee.ticket_price)}</td>
                                {isFirst ? (
                                  <>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.discount > 0 ? <span className="text-green-600">-{formatCurrency(gp.discount)}</span> : '-'}
                                    </td>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap font-medium" rowSpan={group.attendeeCount}>
                                      {formatCurrency(gp.totalCost)}
                                    </td>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.voucherAmount > 0 ? formatCurrency(gp.voucherAmount) : '-'}
                                    </td>
                                    <td className="py-2 pr-3 text-right whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.trainingFundAmount > 0 ? formatCurrency(gp.trainingFundAmount) : '-'}
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      <PaymentMethodBadge method={gp.paymentMethod} totalCost={gp.totalCost} />
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.purchaseOrderNumber ? (
                                        <span className="text-xs">{gp.purchaseOrderNumber}</span>
                                      ) : gp.poToFollow ? (
                                        <span className="text-xs italic text-amber-600">To follow</span>
                                      ) : '-'}
                                    </td>
                                    <td className="py-2 pr-3 whitespace-nowrap" rowSpan={group.attendeeCount}>
                                      {gp.xeroInvoiceNumber ? <span className="text-xs font-mono">{gp.xeroInvoiceNumber}</span> : '-'}
                                    </td>
                                  </>
                                ) : null}
                                <td className="py-2 whitespace-nowrap">
                                  <Badge variant={attendee.status === 'confirmed' ? 'default' : attendee.status === 'cancelled' ? 'destructive' : 'secondary'}>
                                    {attendee.status || 'unknown'}
                                  </Badge>
                                </td>
                              </tr>
                            );
                          });
                        })}
                      </tbody>
                      {filteredGroups.length > 0 && (
                        <tfoot>
                          <tr className="border-t-2 font-medium">
                            <td className="pt-3 pr-3" colSpan={3}>
                              Totals ({totalAttendees} attendees, {filteredGroups.length} bookings)
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(summary.totalRevenue + summary.totalDiscount)}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap text-green-600">
                              {summary.totalDiscount > 0 ? `-${formatCurrency(summary.totalDiscount)}` : '-'}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(summary.totalRevenue)}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(summary.totalVoucher)}
                            </td>
                            <td className="pt-3 pr-3 text-right whitespace-nowrap">
                              {formatCurrency(summary.totalTrainingFund)}
                            </td>
                            <td className="pt-3 pr-3" colSpan={4}>
                              <div className="flex gap-3 text-xs text-muted-foreground">
                                <span>Account: {summary.countByMethod?.account || 0}</span>
                                <span>Card: {summary.countByMethod?.card || 0}</span>
                              </div>
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-between mt-4 pt-4 border-t">
                      <span className="text-sm text-muted-foreground">
                        Page {currentPage} of {totalPages}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={currentPage <= 1}
                          onClick={() => setCurrentPage(p => p - 1)}
                          data-testid="button-prev-page"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={currentPage >= totalPages}
                          onClick={() => setCurrentPage(p => p + 1)}
                          data-testid="button-next-page"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {!selectedEventId && !isLoading && (
        <Card>
          <CardContent className="py-16 text-center">
            <Calendar className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2" data-testid="text-select-prompt">Select an event to view registrations</h3>
            <p className="text-sm text-muted-foreground">
              Choose an event from the dropdown above to see all registration details and payment breakdowns
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
