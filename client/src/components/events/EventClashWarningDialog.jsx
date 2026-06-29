import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

const DEFAULT_TIMEZONE = "Europe/London";

function formatRange(start, end, tz) {
  try {
    const zone = tz || DEFAULT_TIMEZONE;
    const startStr = formatInTimeZone(new Date(start), zone, "EEE d MMM yyyy, h:mm a");
    const endStr = formatInTimeZone(new Date(end), zone, "h:mm a");
    return `${startStr} – ${endStr}`;
  } catch {
    return "";
  }
}

function clashTypeLabel(clash) {
  if (clash.type === "complex_session") {
    return `Complex event session — ${clash.parentTitle || "Untitled event"}`;
  }
  if (clash.member_group_id) {
    return `Member group event — ${clash.groupName || "Group"}`;
  }
  return "Event";
}

export default function EventClashWarningDialog({
  open,
  clashes = [],
  onConfirm,
  onCancel,
  isSaving = false,
}) {
  const count = clashes.length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel?.(); }}>
      <DialogContent data-testid="dialog-event-clash">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            Possible time clash
          </DialogTitle>
          <DialogDescription>
            {count === 1
              ? "This event overlaps in time with another event in your account."
              : `This event overlaps in time with ${count} other events in your account.`}
            {" "}You can still save it.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto space-y-2 py-1" data-testid="list-event-clashes">
          {clashes.map((clash) => (
            <div
              key={`${clash.type}-${clash.id}`}
              className="rounded-md border p-3"
              data-testid={`clash-item-${clash.id}`}
            >
              <div className="text-sm font-medium" data-testid={`text-clash-title-${clash.id}`}>
                {clash.type === "complex_session" && clash.parentTitle
                  ? `${clash.parentTitle}: ${clash.title}`
                  : clash.title}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground" data-testid={`text-clash-type-${clash.id}`}>
                {clashTypeLabel(clash)}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3 shrink-0" />
                <span data-testid={`text-clash-time-${clash.id}`}>
                  {formatRange(clash.start, clash.end, clash.timezone)}
                </span>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={isSaving}
            data-testid="button-clash-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isSaving}
            data-testid="button-clash-save-anyway"
          >
            Save anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
