import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getSeverityLabel, getSeverityBadgeClass } from "@/lib/supportLevels";
import { getAreaLabel, AREA_BADGE_CLASS } from "@/lib/supportAreas";
import { Plus, LifeBuoy, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import {
  typeIcons,
  typeLabels,
  statusColors,
  useSupportSettings,
  NewSupportTicketDialog,
  ViewSupportTicketDialog,
} from "@/components/support/SupportTicketDialogs";

const PAGE_SIZE = 5;

/**
 * Support section shown to group admins on /MemberGroupDetail (Task #2416).
 *
 * Group admins are identified by their group assignment (is_group_admin), not
 * by RBAC roles, so the tenant can hide the Support nav item via RBAC without
 * cutting group admins off from support: this section reuses the exact same
 * dialogs and entity routes as /support (admin notifications fire unchanged).
 * Tickets remain personal to the submitter — filtered to the current member's
 * email, same as /support.
 *
 * The caller is responsible for gating on the group-admin check; ticket data
 * is only fetched when this component is mounted.
 */
export default function GroupAdminSupportSection({ memberInfo }) {
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [page, setPage] = useState(1);

  const { supportLevels, supportAreas, supportInstructions, defaultSeverity } =
    useSupportSettings();

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ["support-tickets", memberInfo?.email],
    queryFn: async () => {
      const allTickets = await base44.entities.SupportTicket.list("-created_date");
      return allTickets.filter((t) => t.submitter_email === memberInfo?.email);
    },
    enabled: !!memberInfo,
  });

  // Keep the open ticket dialog in sync with live ticket updates.
  useEffect(() => {
    if (!selectedTicket) return;
    const fresh = tickets.find((t) => t.id === selectedTicket.id);
    if (fresh) {
      setSelectedTicket((prev) => (prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets]);

  const totalPages = Math.max(1, Math.ceil(tickets.length / PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const pagedTickets = tickets.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <Card className="mt-6" data-testid="card-group-support-section">
      <CardContent className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            <LifeBuoy className="w-5 h-5 text-slate-600" />
            <h2
              className="text-lg font-semibold text-slate-900"
              data-testid="text-support-heading"
            >
              Support
            </h2>
          </div>
          <Button
            onClick={() => setShowNewTicket(true)}
            data-testid="button-new-support-ticket"
          >
            <Plus className="w-4 h-4 mr-2" />
            New ticket
          </Button>
        </div>

        <p className="text-sm text-slate-600 mb-4">
          Need help? Submit a support ticket and follow up on your previous
          requests here.
        </p>

        {isLoading ? (
          <div
            className="text-center py-6 text-slate-500"
            data-testid="text-support-loading"
          >
            Loading your tickets...
          </div>
        ) : tickets.length === 0 ? (
          <div
            className="text-center py-6 text-slate-500"
            data-testid="text-no-support-tickets"
          >
            You haven't submitted any support tickets yet.
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {pagedTickets.map((ticket) => {
                const TypeIcon = typeIcons[ticket.type];
                return (
                  <Card
                    key={ticket.id}
                    className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => setSelectedTicket(ticket)}
                    data-testid={`row-support-ticket-${ticket.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            {TypeIcon && (
                              <TypeIcon className="w-4 h-4 text-blue-600 flex-shrink-0" />
                            )}
                            <Badge variant="outline" className="text-xs">
                              {typeLabels[ticket.type]}
                            </Badge>
                            <Badge className={statusColors[ticket.status]}>
                              {ticket.status.replace("_", " ")}
                            </Badge>
                            {ticket.severity && (
                              <Badge
                                className={getSeverityBadgeClass(ticket.severity)}
                                variant="outline"
                              >
                                {getSeverityLabel(supportLevels, ticket.severity)}
                              </Badge>
                            )}
                            {ticket.area && (
                              <Badge
                                className={AREA_BADGE_CLASS}
                                data-testid={`badge-area-${ticket.id}`}
                              >
                                {getAreaLabel(supportAreas, ticket.area)}
                              </Badge>
                            )}
                          </div>
                          <h3 className="font-semibold text-slate-900 truncate">
                            {ticket.subject}
                          </h3>
                          <p className="text-sm text-slate-600 line-clamp-1">
                            {ticket.description}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-slate-500 flex-shrink-0 whitespace-nowrap">
                          <Clock className="w-3 h-3" />
                          {format(new Date(ticket.created_date), "MMM d, yyyy")}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {tickets.length > PAGE_SIZE && (
              <div
                className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-200"
                data-testid="pagination-support-tickets"
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  data-testid="button-support-prev"
                >
                  <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                </Button>
                <div
                  className="text-sm text-slate-600"
                  data-testid="text-support-page-indicator"
                >
                  Page {safePage} of {totalPages}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  data-testid="button-support-next"
                >
                  Next <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
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
          onTicketUpdated={(updated) => setSelectedTicket(updated)}
        />
      </CardContent>
    </Card>
  );
}
