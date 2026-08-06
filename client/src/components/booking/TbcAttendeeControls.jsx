import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UserPlus } from "lucide-react";

/**
 * Minimal attendee controls shown on the complex event detail page while the
 * TBC "replace standard booking elements" display is active (toggle on and
 * nothing is owed). The full ticket selector cards — prices, availability,
 * early-bird badges, discount inputs, per-ticket selection — are hidden;
 * only the attendee input (Add Attendee / Register Myself) and the added
 * count remain, so terms enforcement and the booking payload are unchanged.
 */
export default function TbcAttendeeControls({
  ticketClass,
  attendeeCount = 0,
  onAdd,
  isGroupEvent = false,
  disabled = false,
}) {
  if (!ticketClass) {
    return (
      <p className="text-sm text-center text-slate-500" data-testid="text-tbc-no-tickets">
        No tickets are currently available for public registration.
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2" data-testid="tbc-attendee-controls">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAdd(ticketClass.id)}
        disabled={disabled}
        data-testid={`button-add-attendee-${ticketClass.id}`}
      >
        <UserPlus className="w-3.5 h-3.5 mr-1" />
        {isGroupEvent ? 'Register Myself' : 'Add Attendee'}
      </Button>
      {attendeeCount > 0 && (
        <Badge className="bg-indigo-600 text-white" data-testid="badge-tbc-attendee-count">
          {attendeeCount} added
        </Badge>
      )}
    </div>
  );
}
