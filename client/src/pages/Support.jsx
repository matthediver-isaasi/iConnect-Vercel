import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import {
  getSeverityLabel,
  getSeverityBadgeClass,
} from "@/lib/supportLevels";
import {
  getAreaLabel,
  AREA_BADGE_CLASS,
} from "@/lib/supportAreas";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, MessageSquare, Clock, Bell, Search, LayoutGrid, List, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import {
  typeIcons,
  typeLabels,
  statusColors,
  useSupportSettings,
  NewSupportTicketDialog,
  ViewSupportTicketDialog,
} from "@/components/support/SupportTicketDialogs";

function formatRelative(dateString) {
  if (!dateString) return "";
  try {
    return formatDistanceToNow(new Date(dateString), { addSuffix: true });
  } catch {
    return "";
  }
}

export default function SupportPage() {
  const { memberInfo } = useMemberAccess();
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");
  const [viewMode, setViewMode] = useState("card");
  const [currentPage, setCurrentPage] = useState(1);

  const queryClient = useQueryClient();

  const { supportLevels, supportAreas, supportInstructions, defaultSeverity } = useSupportSettings();

  const openNewTicket = () => setShowNewTicket(true);

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['support-tickets', memberInfo?.email],
    queryFn: async () => {
      const allTickets = await base44.entities.SupportTicket.list("-created_date");
      return allTickets.filter(t => t.submitter_email === memberInfo?.email);
    },
    enabled: !!memberInfo
  });

  // Inbox: admin_reply notifications for the submitter
  const { data: inboxData = { items: [], unread_count: 0 }, isLoading: inboxLoading } = useQuery({
    queryKey: ['support-inbox'],
    queryFn: async () => {
      const res = await fetch('/api/support/inbox', { credentials: 'include' });
      if (!res.ok) return { items: [], unread_count: 0 };
      const data = await res.json();
      // Submitter sees only admin_reply items on their own tickets
      const myTicketIds = new Set(tickets.map(t => t.id));
      const filtered = (data.items || []).filter(
        item => item.event_type === 'admin_reply' && myTicketIds.has(item.ticket_id)
      );
      const unread_count = filtered.filter(item => !item.read_at).length;
      return { items: filtered, unread_count };
    },
    enabled: !!memberInfo && tickets.length > 0,
    refetchInterval: 60000,
  });

  const markReadMutation = useMutation({
    mutationFn: async ({ item_ids, mark_all_read }) => {
      const res = await fetch('/api/support/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(item_ids ? { item_ids } : { mark_all_read: true }),
      });
      if (!res.ok) throw new Error('Failed to mark as read');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-inbox'] });
    },
  });

  const handleInboxItemClick = (item) => {
    if (!item.read_at) {
      markReadMutation.mutate({ item_ids: [item.id] });
    }
    const ticket = tickets.find(t => t.id === item.ticket_id);
    if (ticket) {
      setSelectedTicket(ticket);
      setInboxOpen(false);
    }
  };

  const PAGE_SIZE = 12;

  const filteredTickets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tickets.filter((ticket) => {
      const matchesSearch =
        q === "" ||
        (ticket.subject || "").toLowerCase().includes(q) ||
        (ticket.description || "").toLowerCase().includes(q);
      const matchesStatus = statusFilter === "all" || ticket.status === statusFilter;
      const matchesType = typeFilter === "all" || ticket.type === typeFilter;
      const matchesSeverity = severityFilter === "all" || ticket.severity === severityFilter;
      const matchesArea = areaFilter === "all" || ticket.area === areaFilter;
      return matchesSearch && matchesStatus && matchesType && matchesSeverity && matchesArea;
    });
  }, [tickets, searchQuery, statusFilter, typeFilter, severityFilter, areaFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredTickets.length / PAGE_SIZE));
  const safePage = Math.max(1, Math.min(currentPage, totalPages));
  const pagedTickets = useMemo(
    () => filteredTickets.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredTickets, safePage]
  );

  // Reset to first page when the filters/search change the result set size below
  // the current page, or when the user changes a filter.
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, typeFilter, severityFilter, areaFilter]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    severityFilter !== "all" ||
    areaFilter !== "all";

  const clearFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setTypeFilter("all");
    setSeverityFilter("all");
    setAreaFilter("all");
  };

  if (!memberInfo) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const unreadCount = inboxData.unread_count || 0;
  const inboxItems = inboxData.items || [];

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Support</h1>
            <p className="text-slate-600">Submit bug reports, feature requests, or ask questions</p>
          </div>
          <div className="flex items-center gap-3">
            {tickets.length > 0 && (
              <Button
                variant="outline"
                className="relative"
                onClick={() => setInboxOpen(true)}
                data-testid="button-support-inbox"
              >
                <Bell className="w-4 h-4 mr-2" />
                Updates
                {unreadCount > 0 && (
                  <span
                    className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-blue-600 text-white text-xs font-bold"
                    data-testid="text-unread-count"
                  >
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </Button>
            )}
            <Button onClick={openNewTicket} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              New Ticket
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-12">Loading tickets...</div>
        ) : tickets.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <MessageSquare className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Support Tickets Yet</h3>
              <p className="text-slate-600 mb-6">Submit your first ticket to get help from our team</p>
              <Button onClick={openNewTicket} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Ticket
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Search, filters and view toggle */}
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardContent className="p-4">
                <div className="flex flex-col lg:flex-row gap-4">
                  <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <Input
                      placeholder="Search my tickets..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                      data-testid="input-search-tickets"
                    />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="w-full sm:w-40" data-testid="select-status-filter">
                        <SelectValue placeholder="All Statuses" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Statuses</SelectItem>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                        <SelectItem value="closed">Closed</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select value={typeFilter} onValueChange={setTypeFilter}>
                      <SelectTrigger className="w-full sm:w-44" data-testid="select-type-filter">
                        <SelectValue placeholder="All Types" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="bug">Bug Report</SelectItem>
                        <SelectItem value="feature_request">Feature Request</SelectItem>
                        <SelectItem value="how_to">How-To Question</SelectItem>
                        <SelectItem value="general">General Message</SelectItem>
                      </SelectContent>
                    </Select>
                    {supportLevels.length > 0 && (
                      <Select value={severityFilter} onValueChange={setSeverityFilter}>
                        <SelectTrigger className="w-full sm:w-40" data-testid="select-severity-filter">
                          <SelectValue placeholder="All Severities" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Severities</SelectItem>
                          {supportLevels.map((lvl) => (
                            <SelectItem key={lvl.value} value={lvl.value}>{lvl.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {supportAreas.length > 0 && (
                      <Select value={areaFilter} onValueChange={setAreaFilter}>
                        <SelectTrigger className="w-full sm:w-40" data-testid="select-area-filter">
                          <SelectValue placeholder="All Areas" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Areas</SelectItem>
                          {supportAreas.map((area) => (
                            <SelectItem key={area.value} value={area.value}>{area.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <div className="flex items-center gap-1 rounded-md border border-slate-200 p-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={`toggle-elevate ${viewMode === 'card' ? 'toggle-elevated' : ''}`}
                        onClick={() => setViewMode('card')}
                        aria-label="Card view"
                        data-testid="button-view-card"
                      >
                        <LayoutGrid className="w-4 h-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={`toggle-elevate ${viewMode === 'list' ? 'toggle-elevated' : ''}`}
                        onClick={() => setViewMode('list')}
                        aria-label="List view"
                        data-testid="button-view-list"
                      >
                        <List className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {filteredTickets.length === 0 ? (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-12 text-center">
                  <Search className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">No tickets match your filters</h3>
                  <p className="text-slate-600 mb-6">Try adjusting your search or filters to see more results</p>
                  {hasActiveFilters && (
                    <Button variant="outline" onClick={clearFilters} data-testid="button-clear-filters">
                      Clear filters
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : viewMode === 'card' ? (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {pagedTickets.map((ticket) => {
                  const TypeIcon = typeIcons[ticket.type];
                  const ticketUnread = inboxItems.filter(i => i.ticket_id === ticket.id && !i.read_at).length;
                  return (
                    <Card
                      key={ticket.id}
                      className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                      onClick={() => setSelectedTicket(ticket)}
                      data-testid={`card-ticket-${ticket.id}`}
                    >
                      <CardHeader className="border-b border-slate-200">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2">
                            <TypeIcon className="w-5 h-5 text-blue-600" />
                            <Badge variant="outline" className="text-xs">
                              {typeLabels[ticket.type]}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge className={statusColors[ticket.status]}>
                              {ticket.status.replace('_', ' ')}
                            </Badge>
                            {ticketUnread > 0 && (
                              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-blue-600 text-white text-xs font-bold" data-testid={`unread-badge-${ticket.id}`}>
                                {ticketUnread}
                              </span>
                            )}
                          </div>
                        </div>
                        <CardTitle className="text-lg">{ticket.subject}</CardTitle>
                      </CardHeader>
                      <CardContent className="pt-4">
                        <p className="text-sm text-slate-600 mb-4 line-clamp-2">{ticket.description}</p>
                        <div className="flex items-center justify-between text-xs text-slate-500">
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {format(new Date(ticket.created_date), 'MMM d, yyyy')}
                          </div>
                          <div className="flex items-center gap-2">
                            {ticket.severity && (
                              <Badge className={getSeverityBadgeClass(ticket.severity)} variant="outline">
                                {getSeverityLabel(supportLevels, ticket.severity)}
                              </Badge>
                            )}
                            {ticket.area && (
                              <Badge className={AREA_BADGE_CLASS} data-testid={`badge-area-${ticket.id}`}>
                                {getAreaLabel(supportAreas, ticket.area)}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3">
                {pagedTickets.map((ticket) => {
                  const TypeIcon = typeIcons[ticket.type];
                  const ticketUnread = inboxItems.filter(i => i.ticket_id === ticket.id && !i.read_at).length;
                  return (
                    <Card
                      key={ticket.id}
                      className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                      onClick={() => setSelectedTicket(ticket)}
                      data-testid={`row-ticket-${ticket.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <TypeIcon className="w-4 h-4 text-blue-600 flex-shrink-0" />
                              <Badge variant="outline" className="text-xs">
                                {typeLabels[ticket.type]}
                              </Badge>
                              <Badge className={statusColors[ticket.status]}>
                                {ticket.status.replace('_', ' ')}
                              </Badge>
                              {ticket.severity && (
                                <Badge className={getSeverityBadgeClass(ticket.severity)} variant="outline">
                                  {getSeverityLabel(supportLevels, ticket.severity)}
                                </Badge>
                              )}
                              {ticket.area && (
                                <Badge className={AREA_BADGE_CLASS} data-testid={`badge-area-${ticket.id}`}>
                                  {getAreaLabel(supportAreas, ticket.area)}
                                </Badge>
                              )}
                              {ticketUnread > 0 && (
                                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-blue-600 text-white text-xs font-bold" data-testid={`unread-badge-${ticket.id}`}>
                                  {ticketUnread}
                                </span>
                              )}
                            </div>
                            <h3 className="font-semibold text-slate-900 truncate">{ticket.subject}</h3>
                            <p className="text-sm text-slate-600 line-clamp-1">{ticket.description}</p>
                          </div>
                          <div className="flex items-center gap-1 text-xs text-slate-500 flex-shrink-0 whitespace-nowrap">
                            <Clock className="w-3 h-3" />
                            {format(new Date(ticket.created_date), 'MMM d, yyyy')}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {filteredTickets.length > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-4 mt-6 flex-wrap" data-testid="tickets-pagination">
                <p className="text-sm text-slate-600" data-testid="text-pagination-range">
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredTickets.length)} of {filteredTickets.length}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setCurrentPage(1)}
                    disabled={safePage === 1}
                    aria-label="First page"
                    data-testid="button-page-first"
                  >
                    <ChevronsLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    aria-label="Previous page"
                    data-testid="button-page-prev"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm text-slate-600 px-2" data-testid="text-pagination-page">
                    Page {safePage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    aria-label="Next page"
                    data-testid="button-page-next"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={safePage === totalPages}
                    aria-label="Last page"
                    data-testid="button-page-last"
                  >
                    <ChevronsRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        <NewSupportTicketDialog
          open={showNewTicket}
          onOpenChange={setShowNewTicket}
          memberInfo={memberInfo}
          supportLevels={supportLevels}
          supportAreas={supportAreas}
          supportInstructions={supportInstructions}
          defaultSeverity={defaultSeverity}
        />

        <ViewSupportTicketDialog
          ticket={selectedTicket}
          onClose={() => setSelectedTicket(null)}
          memberInfo={memberInfo}
          supportLevels={supportLevels}
          supportAreas={supportAreas}
        />

        {/* Submitter Inbox — admin reply notifications */}
        <Sheet open={inboxOpen} onOpenChange={setInboxOpen}>
          <SheetContent className="w-full sm:max-w-md flex flex-col">
            <SheetHeader className="flex-shrink-0">
              <div className="flex items-center justify-between gap-2">
                <SheetTitle className="flex items-center gap-2">
                  <Bell className="w-5 h-5" />
                  Ticket Updates
                  {unreadCount > 0 && (
                    <Badge className="bg-blue-600 text-white" data-testid="text-inbox-unread-badge">
                      {unreadCount}
                    </Badge>
                  )}
                </SheetTitle>
                {unreadCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => markReadMutation.mutate({ mark_all_read: true })}
                    disabled={markReadMutation.isPending}
                    data-testid="button-mark-all-read"
                  >
                    Mark all read
                  </Button>
                )}
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-hidden mt-4">
              {inboxLoading ? (
                <div className="space-y-3 p-1">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-md border">
                      <Skeleton className="w-8 h-8 rounded-md flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : inboxItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center px-4">
                  <Bell className="w-10 h-10 text-slate-300 mb-3" />
                  <p className="text-sm text-muted-foreground">No updates yet</p>
                  <p className="text-xs text-muted-foreground mt-1">You'll be notified here when someone replies to your tickets</p>
                </div>
              ) : (
                <ScrollArea className="h-full pr-1">
                  <div className="flex flex-col gap-2">
                    {inboxItems.map(item => {
                      const isUnread = !item.read_at;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => handleInboxItemClick(item)}
                          className={`w-full text-left flex items-start gap-3 p-3 rounded-md border hover-elevate transition-colors ${
                            isUnread ? 'bg-primary/5 border-primary/30' : 'bg-background'
                          }`}
                          data-testid={`inbox-item-${item.id}`}
                        >
                          <div className="mt-0.5 flex-shrink-0">
                            <MessageSquare className={`w-4 h-4 ${isUnread ? 'text-primary' : 'text-muted-foreground'}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className={`text-sm truncate ${isUnread ? 'font-semibold' : 'font-medium'}`}>
                                {item.ticket_subject || item.metadata?.ticket_subject || 'Your ticket'}
                              </span>
                              {isUnread && (
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" aria-label="Unread" />
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">The support team replied to your ticket</div>
                            {item.metadata?.reply_excerpt && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                {item.metadata.reply_excerpt}
                              </p>
                            )}
                            <div className="text-xs text-muted-foreground/70 mt-1">
                              {formatRelative(item.created_at)}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
