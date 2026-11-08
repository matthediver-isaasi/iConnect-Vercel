import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { adminFetch } from "@/lib/adminFetch";
import { toast } from "sonner";

const isDate = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    && value >= "0001-01-01" && value <= "9998-12-31";
};

export function extensionError(record, newEnd, reason) {
  if (!isDate(record?.term_start_date) || !isDate(record?.term_end_date)
    || record.term_end_date < record.term_start_date) return "The existing membership term dates are not valid. Reload the membership before extending it.";
  if (!isDate(newEnd) || newEnd <= record.term_end_date) return "Choose a valid new end date later than the existing end date.";
  if (!reason.trim()) return "Enter an administrator reason for this extension.";
  return "";
}

export default function ExtendMemberDateTerm({ record, memberId, tenantId, canAdmin }) {
  const queryClient = useQueryClient();
  const sending = useRef(false);
  const [open, setOpen] = useState(false);
  const [newEnd, setNewEnd] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (!canAdmin || record?.term_source_snapshot?.type !== "member_date_field") return null;

  const submit = async event => {
    event.preventDefault();
    if (sending.current || !canAdmin) return;
    const validation = extensionError(record, newEnd, reason);
    if (validation) { setError(validation); return; }
    sending.current = true;
    setPending(true);
    setError("");
    try {
      const response = await adminFetch("/api/membership/member-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "extend-date-term", memberId, historyId: record.id,
          expectedEnd: record.term_end_date, newEnd, reason: reason.trim(),
        }),
      }, tenantId);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not extend membership. Reload the membership and try again.");
      if (result.history_id !== record.id || !result.audit_id || result.term_end_date !== newEnd) {
        throw new Error("The extension result could not be confirmed. Reload membership before trying again.");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["member-membership", memberId] }),
        queryClient.invalidateQueries({ queryKey: ["member-start", tenantId, memberId] }),
        queryClient.invalidateQueries({ queryKey: ["member-amendments", tenantId, memberId] }),
      ]);
      setOpen(false);
      toast.success("Membership extension recorded");
    } catch (failure) {
      setError(failure.message || "Could not extend membership. Try again.");
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  return <>
    <Button
      type="button" variant="outline" size="sm" className="mt-2"
      data-testid={`button-extend-membership-${record.id}`}
      onClick={() => { setNewEnd(""); setReason(""); setError(""); setOpen(true); }}
    >
      Extend membership
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!sending.current) setOpen(value); }}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Extend membership</DialogTitle>
          <DialogDescription>
            Extend this member date term without replacing the original evidence. The administrator reason is recorded with the extension.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div><dt className="text-muted-foreground">Existing start date</dt><dd className="font-medium">{record.term_start_date || "Not recorded"}</dd></div>
            <div><dt className="text-muted-foreground">Existing end date</dt><dd className="font-medium">{record.term_end_date || "Not recorded"}</dd></div>
          </dl>
          <p className="text-sm text-muted-foreground">
            Editing the member's date custom field does not automatically extend membership. Use this action to record a later end date; the original term evidence remains available.
          </p>
          <div className="space-y-2">
            <Label htmlFor={`extension-end-${record.id}`}>New end date</Label>
            <Input id={`extension-end-${record.id}`} type="date" required max="9998-12-31"
              value={newEnd} onChange={event => setNewEnd(event.target.value)} disabled={pending}
              aria-describedby={`extension-date-help-${record.id}`} />
            <p id={`extension-date-help-${record.id}`} className="text-xs text-muted-foreground">Must be later than {record.term_end_date || "the existing end date"}.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`extension-reason-${record.id}`}>Administrator reason (required)</Label>
            <Textarea id={`extension-reason-${record.id}`} required value={reason}
              onChange={event => setReason(event.target.value)} disabled={pending}
              placeholder="Explain why this membership is being extended" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Recording extension…" : "Extend membership"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
