import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import TimezoneAwareDateTimeInput from "@/components/events/TimezoneAwareDateTimeInput";
import EventImageUpload from "@/components/events/EventImageUpload";
import EventDocumentsManager from "@/components/events/EventDocumentsManager";

function formatInTimezone(iso, tz) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz || undefined,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return iso;
  }
}

function describeClashKind(c) {
  if (c.kind === "member_group_event") {
    return `Member group event${c.groupName ? ` — ${c.groupName}` : ""}`;
  }
  if (c.kind === "complex_event_session") {
    return `Complex event session${c.parentTitle ? ` — ${c.parentTitle}` : ""}`;
  }
  return "Event";
}

const DEFAULT_TZ = "Europe/London";

export default function GroupEventForm({ initial = null, memberGroupId, onSaved, onCancel }) {
  const isEdit = !!initial;
  const [form, setForm] = useState({
    title: initial?.title || "",
    summary: initial?.summary || "",
    description: initial?.description || "",
    start_date: initial?.start_date || "",
    end_date: initial?.end_date || "",
    timezone: initial?.timezone || DEFAULT_TZ,
    location: initial?.location || "",
    is_online: !!initial?.is_online,
    online_meeting_url: initial?.online_meeting_url || "",
    image_url: initial?.image_url || "",
    image_focal_point: initial?.image_focal_point || null,
    event_state: initial?.event_state || "active",
    attached_documents: initial?.attached_documents || [],
    documents_section_title: initial?.documents_section_title || "",
  });
  const [saving, setSaving] = useState(false);
  const [clashes, setClashes] = useState([]);
  const [clashOpen, setClashOpen] = useState(false);

  const handleField = (k) => (val) => setForm((f) => ({ ...f, [k]: val }));

  const persist = async () => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        location: form.is_online ? "Online Event" : form.location,
        online_meeting_url: form.is_online ? form.online_meeting_url.trim() : null,
      };
      let res;
      if (isEdit) {
        res = await fetch(`/api/member-group-events/${initial.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch(`/api/member-group-events`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberGroupId, ...payload }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Save failed");
      toast.success(isEdit ? "Event updated" : "Event created");
      onSaved?.(data.event);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.title.trim()) return toast.error("Title is required");
    if (!form.start_date) return toast.error("Start date is required");
    if (form.is_online) {
      try {
        const u = new URL(form.online_meeting_url);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      } catch {
        return toast.error("Online events require a valid meeting URL");
      }
    }

    // Pre-save clash check. Skip if start/end missing or invalid.
    if (form.start_date && form.end_date) {
      const sMs = Date.parse(form.start_date);
      const eMs = Date.parse(form.end_date);
      if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs) {
        setSaving(true);
        try {
          const res = await fetch(`/api/member-group-events/check-clashes`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              start: form.start_date,
              end: form.end_date,
              excludeEventId: isEdit ? initial.id : undefined,
            }),
          });
          if (res.ok) {
            const body = await res.json().catch(() => ({}));
            if (Array.isArray(body.clashes) && body.clashes.length > 0) {
              setClashes(body.clashes);
              setClashOpen(true);
              setSaving(false);
              return;
            }
          }
        } catch {
          // Clash check is advisory — fall through to save on network failure.
        } finally {
          setSaving(false);
        }
      }
    }

    await persist();
  };

  const handleSaveAnyway = async () => {
    setClashOpen(false);
    await persist();
  };

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="ge-title">Title *</Label>
        <Input
          id="ge-title"
          value={form.title}
          onChange={(e) => handleField("title")(e.target.value)}
          data-testid="input-event-title"
        />
      </div>

      <div>
        <Label htmlFor="ge-summary">Summary</Label>
        <Input
          id="ge-summary"
          value={form.summary}
          onChange={(e) => handleField("summary")(e.target.value)}
          data-testid="input-event-summary"
        />
      </div>

      <div>
        <Label htmlFor="ge-description">Description</Label>
        <Textarea
          id="ge-description"
          rows={5}
          value={form.description}
          onChange={(e) => handleField("description")(e.target.value)}
          data-testid="textarea-event-description"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TimezoneAwareDateTimeInput
          label="Start *"
          value={form.start_date}
          timezone={form.timezone}
          onChange={handleField("start_date")}
          onTimezoneChange={handleField("timezone")}
        />
        <TimezoneAwareDateTimeInput
          label="End"
          value={form.end_date}
          timezone={form.timezone}
          onChange={handleField("end_date")}
          onTimezoneChange={handleField("timezone")}
        />
      </div>

      <div className="flex items-center gap-3">
        <Switch
          checked={form.is_online}
          onCheckedChange={(v) => setForm((f) => ({ ...f, is_online: v }))}
          data-testid="switch-online"
        />
        <Label>Online event</Label>
      </div>

      {form.is_online ? (
        <div>
          <Label htmlFor="ge-url">Meeting URL *</Label>
          <Input
            id="ge-url"
            placeholder="https://zoom.us/j/..."
            value={form.online_meeting_url}
            onChange={(e) => handleField("online_meeting_url")(e.target.value)}
            data-testid="input-meeting-url"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Visible only to members who RSVP "Going" and to event creators.
          </p>
        </div>
      ) : (
        <div>
          <Label htmlFor="ge-location">Location</Label>
          <Input
            id="ge-location"
            value={form.location}
            onChange={(e) => handleField("location")(e.target.value)}
            data-testid="input-location"
          />
        </div>
      )}

      <EventImageUpload
        value={form.image_url}
        focalPoint={form.image_focal_point}
        onChange={(url, focal) => setForm((f) => ({ ...f, image_url: url, image_focal_point: focal }))}
      />

      <EventDocumentsManager
        documents={form.attached_documents}
        sectionTitle={form.documents_section_title}
        onChange={(documents, sectionTitle) =>
          setForm((f) => ({ ...f, attached_documents: documents, documents_section_title: sectionTitle }))
        }
      />

      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button onClick={handleSubmit} disabled={saving} data-testid="button-save-event">
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {isEdit ? "Save changes" : "Create event"}
        </Button>
      </div>

      <Dialog open={clashOpen} onOpenChange={setClashOpen}>
        <DialogContent data-testid="dialog-event-clash">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-warning" />
              Possible time clash
            </DialogTitle>
            <DialogDescription>
              The time you chose overlaps with {clashes.length === 1 ? "another event" : `${clashes.length} other events`} in this tenant. You can save anyway or go back and adjust the time.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto space-y-2 border-t border-b py-3">
            {clashes.map((c) => (
              <div
                key={`${c.kind}-${c.id}`}
                className="text-sm"
                data-testid={`clash-row-${c.id}`}
              >
                <div className="font-medium">{c.title || "(untitled)"}</div>
                <div className="text-xs text-muted-foreground">
                  {formatInTimezone(c.start, c.timezone)}
                  {c.end ? ` – ${formatInTimezone(c.end, c.timezone)}` : ""}
                  {c.timezone ? ` (${c.timezone})` : ""}
                </div>
                <div className="text-xs text-muted-foreground">{describeClashKind(c)}</div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClashOpen(false)}
              disabled={saving}
              data-testid="button-clash-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveAnyway}
              disabled={saving}
              data-testid="button-clash-save-anyway"
            >
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
