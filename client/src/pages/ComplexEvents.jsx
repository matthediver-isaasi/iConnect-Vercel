import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Plus, Calendar, Trash2, Pencil, Loader2, MapPin, Users } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

const STATUS_CONFIG = {
  draft: { label: "Draft", variant: "secondary" },
  published: { label: "Published", variant: "default" },
  tbc: { label: "TBC", variant: "outline" },
  closed: { label: "Closed", variant: "destructive" },
};

export default function ComplexEvents() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["/api/entities/ComplexEvent"],
    queryFn: () => base44.entities.ComplexEvent.list({ sort: { created_at: "desc" } }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const tracks = await base44.entities.ComplexEventTrack.filter({ complex_event_id: id });
      for (const track of tracks) {
        const sessions = await base44.entities.ComplexEventSession.filter({ complex_event_track_id: track.id });
        for (const session of sessions) {
          await base44.entities.ComplexEventSession.delete(session.id);
        }
        await base44.entities.ComplexEventTrack.delete(track.id);
      }
      await base44.entities.ComplexEvent.delete(id);
    },
    onSuccess: () => {
      toast.success("Complex event deleted");
      queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEvent"] });
      setDeleteTarget(null);
      setDeleteConfirmText("");
    },
    onError: (err) => {
      toast.error("Failed to delete: " + (err.message || "Unknown error"));
    },
  });

  const filtered = useMemo(() => {
    if (!searchQuery) return events;
    const q = searchQuery.toLowerCase();
    return events.filter(
      (e) =>
        e.title?.toLowerCase().includes(q) ||
        e.location?.toLowerCase().includes(q) ||
        e.summary?.toLowerCase().includes(q)
    );
  }, [events, searchQuery]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900" data-testid="text-page-title">
            Complex Events
          </h1>
          <Button
            onClick={() => (window.location.href = createPageUrl("CreateComplexEvent"))}
            data-testid="button-create-complex-event"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Event
          </Button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search complex events..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-complex-events"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Calendar className="w-12 h-12 text-slate-300 mb-4" />
              <p className="text-slate-500 text-lg mb-2" data-testid="text-empty-state">
                {searchQuery ? "No events match your search" : "No complex events yet"}
              </p>
              {!searchQuery && (
                <p className="text-slate-400 text-sm">Create your first multi-session event to get started.</p>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {filtered.map((event) => {
              const statusCfg = STATUS_CONFIG[event.status] || STATUS_CONFIG.draft;
              return (
                <Card
                  key={event.id}
                  className="hover:shadow-md transition-shadow cursor-pointer"
                  data-testid={`card-complex-event-${event.id}`}
                  onClick={() =>
                    (window.location.href = createPageUrl("CreateComplexEvent") + "?id=" + event.id)
                  }
                >
                  <CardContent className="flex flex-wrap items-center gap-4 p-4">
                    {event.image_url && (
                      <div className="w-20 h-14 rounded-md overflow-hidden flex-shrink-0 bg-slate-100">
                        <img
                          src={event.image_url}
                          alt={event.title}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <h3 className="font-semibold text-slate-900 truncate" data-testid={`text-event-title-${event.id}`}>
                          {event.title}
                        </h3>
                        <Badge variant={statusCfg.variant} data-testid={`badge-status-${event.id}`}>
                          {statusCfg.label}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
                        {event.start_date && (
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5" />
                            {format(parseISO(event.start_date), "dd MMM yyyy")}
                            {event.end_date && ` - ${format(parseISO(event.end_date), "dd MMM yyyy")}`}
                          </span>
                        )}
                        {event.location && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5" />
                            {event.location}
                          </span>
                        )}
                        {event.available_seats && (
                          <span className="flex items-center gap-1">
                            <Users className="w-3.5 h-3.5" />
                            {event.available_seats} seats
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.location.href = createPageUrl("CreateComplexEvent") + "?id=" + event.id;
                        }}
                        data-testid={`button-edit-${event.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(event);
                        }}
                        data-testid={`button-delete-${event.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={() => { setDeleteTarget(null); setDeleteConfirmText(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Complex Event</DialogTitle>
            <DialogDescription>
              This will permanently delete &quot;{deleteTarget?.title}&quot; including all its tracks and sessions.
              Type <strong>DELETE</strong> to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder='Type "DELETE" to confirm'
            data-testid="input-delete-confirm"
          />
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => { setDeleteTarget(null); setDeleteConfirmText(""); }} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirmText !== "DELETE" || deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(deleteTarget.id)}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
