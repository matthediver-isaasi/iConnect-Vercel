import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar, Plus, Loader2, MapPin, Video, Users } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { getFocalPointStyle } from "@/components/FocalPointPicker";

export default function GroupEventsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const navigate = useNavigate();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("membership.member-group-events")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const {
    data: groups = [],
    isLoading,
  } = useQuery({
    queryKey: ["member-group-events", "qualifying-groups"],
    queryFn: async () => {
      const res = await fetch("/api/member-group-events/qualifying-groups", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return data.groups || [];
    },
    enabled: accessChecked,
  });

  if (!accessChecked || isLoading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const goToEvent = (eventId) => navigate(`/GroupEvents/${eventId}`);
  const goToNew = (groupId) => navigate(`/GroupEvents/new?groupId=${groupId}`);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto" data-testid="page-group-events">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Calendar className="w-5 h-5" /> Group Events
        </h1>
        <p className="text-sm text-muted-foreground">
          Events private to the member groups you belong to.
        </p>
      </div>

      {groups.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You don't belong to any groups with events enabled.
          </CardContent>
        </Card>
      )}

      {groups.map((group) => {
        const now = new Date();
        const upcoming = (group.events || []).filter((e) => !e.start_date || new Date(e.start_date) >= now);
        const past = (group.events || []).filter((e) => e.start_date && new Date(e.start_date) < now);
        return (
          <Card key={group.id} data-testid={`card-group-${group.id}`}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">{group.name}</CardTitle>
                <Badge variant="outline">{group.callerRole}</Badge>
              </div>
              {group.canCreate && (
                <Button size="sm" onClick={() => goToNew(group.id)} data-testid={`button-new-event-${group.id}`}>
                  <Plus className="w-4 h-4 mr-2" /> New event
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <EventGrid title="Upcoming" events={upcoming} onOpen={goToEvent} canCreate={group.canCreate} />
              {past.length > 0 && (
                <EventGrid title="Past" events={past} onOpen={goToEvent} canCreate={group.canCreate} muted />
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function EventGrid({ title, events, onOpen, canCreate, muted }) {
  if (events.length === 0) {
    return (
      <div>
        <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">{title}</p>
        <p className="text-sm text-muted-foreground">No {title.toLowerCase()} events.</p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">{title}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {events.map((ev) => (
          <button
            key={ev.id}
            onClick={() => onOpen(ev.id)}
            className={`text-left rounded-md border border-border overflow-hidden hover-elevate active-elevate-2 ${muted ? "opacity-80" : ""}`}
            data-testid={`button-open-event-${ev.id}`}
          >
            {ev.image_url && (
              <div className="h-32 overflow-hidden bg-muted">
                <img
                  src={ev.image_url}
                  alt={ev.title}
                  className="w-full h-full object-cover"
                  style={getFocalPointStyle(ev.image_focal_point)}
                />
              </div>
            )}
            <div className="p-3 space-y-2">
            <div className="font-medium truncate">{ev.title}</div>
            {ev.start_date && (
              <div className="text-xs text-muted-foreground">
                {format(parseISO(ev.start_date), "PPp")}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {ev.is_online ? (
                <Badge variant="secondary" className="gap-1"><Video className="w-3 h-3" /> Online</Badge>
              ) : ev.location ? (
                <Badge variant="secondary" className="gap-1"><MapPin className="w-3 h-3" /> {ev.location}</Badge>
              ) : null}
              {ev.my_rsvp && (
                <Badge variant={ev.my_rsvp === "going" ? "default" : "outline"}>
                  RSVP: {ev.my_rsvp.replace("_", " ")}
                </Badge>
              )}
              {canCreate && (
                <Badge variant="outline" className="gap-1">
                  <Users className="w-3 h-3" /> {ev.rsvp_counts?.going || 0} going
                </Badge>
              )}
            </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
