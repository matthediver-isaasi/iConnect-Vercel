import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Calendar, MapPin, Video, ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import GroupEventForm from "@/components/group-events/GroupEventForm";
import { getFocalPointStyle } from "@/components/FocalPointPicker";

export default function GroupEventDetail() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const isNew = eventId === "new";
  const newGroupId = isNew ? new URLSearchParams(location.search).get("groupId") : null;

  const [editing, setEditing] = useState(isNew);
  const [response, setResponse] = useState(null);
  const [responding, setResponding] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["group-event", eventId],
    enabled: !isNew && !!eventId,
    queryFn: async () => {
      const res = await fetch(`/api/member-group-events/${eventId}`, { credentials: "include" });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Failed");
      }
      return res.json();
    },
  });

  useEffect(() => {
    if (data?.myRsvp?.response) setResponse(data.myRsvp.response);
  }, [data]);

  const { data: attendeesData } = useQuery({
    queryKey: ["group-event-attendees", eventId],
    enabled: !isNew && !!eventId && !!data?.canEdit,
    queryFn: async () => {
      const res = await fetch(`/api/member-group-events/${eventId}/attendees`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  if (isNew) {
    if (!newGroupId) {
      return <div className="p-6">Missing group id.</div>;
    }
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/GroupEvents")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Group Events
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>New group event</CardTitle>
          </CardHeader>
          <CardContent>
            <GroupEventForm
              memberGroupId={newGroupId}
              onSaved={(ev) => navigate(`/GroupEvents/${ev.id}`)}
              onCancel={() => navigate("/GroupEvents")}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const ev = data.event;

  const submitRsvp = async (resp) => {
    setResponding(true);
    try {
      const res = await fetch(`/api/member-group-events/${eventId}/rsvp`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: resp }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "RSVP failed");
      setResponse(resp);
      toast.success(`RSVP saved: ${resp.replace("_", " ")}`);
      queryClient.invalidateQueries({ queryKey: ["group-event", eventId] });
      queryClient.invalidateQueries({ queryKey: ["member-group-events", "qualifying-groups"] });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setResponding(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this event? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/member-group-events/${eventId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("Event deleted");
      navigate("/GroupEvents");
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate("/GroupEvents")}>
        <ArrowLeft className="w-4 h-4 mr-2" /> Back to Group Events
      </Button>

      {editing ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit event</CardTitle>
          </CardHeader>
          <CardContent>
            <GroupEventForm
              initial={ev}
              memberGroupId={ev.member_group_id}
              onSaved={() => { setEditing(false); refetch(); }}
              onCancel={() => setEditing(false)}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
            <div className="space-y-1">
              <CardTitle>{ev.title}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{data.group?.name || "Group event"}</Badge>
                {ev.is_online ? (
                  <Badge variant="secondary" className="gap-1"><Video className="w-3 h-3" /> Online</Badge>
                ) : ev.location ? (
                  <Badge variant="secondary" className="gap-1"><MapPin className="w-3 h-3" /> {ev.location}</Badge>
                ) : null}
              </div>
            </div>
            {data.canEdit && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)} data-testid="button-edit-event">
                  <Pencil className="w-4 h-4 mr-2" /> Edit
                </Button>
                <Button size="sm" variant="outline" onClick={handleDelete} data-testid="button-delete-event">
                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {ev.image_url && (
              <div className="rounded-xl overflow-hidden shadow-sm aspect-video max-h-[28rem] w-full bg-muted">
                <img
                  src={ev.image_url}
                  alt={ev.title}
                  className="w-full h-full object-cover"
                  style={getFocalPointStyle(ev.image_focal_point)}
                />
              </div>
            )}
            {ev.start_date && (
              <div className="text-sm flex items-center gap-2">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                {format(parseISO(ev.start_date), "PPpp")}
                {ev.end_date && <> – {format(parseISO(ev.end_date), "PPpp")}</>}
              </div>
            )}
            {ev.summary && <p className="text-sm">{ev.summary}</p>}
            {ev.description && <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: ev.description }} />}
            {ev.is_online && ev.online_meeting_url && (
              <div className="rounded-md border border-border p-3 bg-muted/30">
                <div className="text-xs font-semibold uppercase mb-1">Meeting link</div>
                <a href={ev.online_meeting_url} target="_blank" rel="noreferrer" className="text-sm underline break-all">
                  {ev.online_meeting_url}
                </a>
              </div>
            )}

            <div className="border-t pt-4">
              <div className="text-xs font-semibold uppercase mb-2">Your RSVP</div>
              <div className="flex flex-wrap gap-2">
                {["going", "maybe", "not_going"].map((r) => (
                  <Button
                    key={r}
                    size="sm"
                    variant={response === r ? "default" : "outline"}
                    disabled={responding}
                    onClick={() => submitRsvp(r)}
                    data-testid={`button-rsvp-${r}`}
                  >
                    {r === "going" ? "Going" : r === "maybe" ? "Maybe" : "Not going"}
                  </Button>
                ))}
              </div>
            </div>

            {data.canEdit && attendeesData?.attendees && (
              <div className="border-t pt-4">
                <div className="text-xs font-semibold uppercase mb-2">Attendees</div>
                {["going", "maybe", "not_going"].map((r) => (
                  <div key={r} className="mb-3">
                    <div className="text-sm font-medium capitalize mb-1">
                      {r.replace("_", " ")} ({attendeesData.attendees[r]?.length || 0})
                    </div>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      {(attendeesData.attendees[r] || []).map((a) => (
                        <div key={a.identity_id}>{a.name || a.email}</div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
