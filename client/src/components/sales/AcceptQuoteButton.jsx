import { useRef, useState } from "react";
import { useQuoteNaming } from "@/hooks/useSalesSettings";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function AcceptQuoteButton({ status, permitted, pending, onAccept }) {
  const { singular } = useQuoteNaming();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  if (!permitted || !["issued", "sent"].includes(status)) return null;
  const busy = pending || saving;
  const accept = async () => {
    if (busy || lock.current) return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      await onAccept({ status: "accepted", note: note.trim() });
      setOpen(false);
    } catch (failure) {
      setError(failure.message || `Could not accept the ${singular}. Please try again.`);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  return <>
    <Button variant="outline" disabled={busy} onClick={() => { setNote(""); setError(""); setOpen(true); }}><Check className="mr-2 h-4 w-4" />Mark as accepted</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Accept {singular} on the customer’s behalf?</DialogTitle><DialogDescription>
          Confirm that the customer has agreed to this {singular}. Your acceptance will be recorded in its history and will run any configured acceptance tasks, just like acceptance through the emailed link.
        </DialogDescription></DialogHeader>
        <div className="space-y-2"><Label htmlFor="quote-acceptance-note">Approval note (optional)</Label><Textarea id="quote-acceptance-note" maxLength={1000} disabled={busy} value={note} onChange={event => setNote(event.target.value)} placeholder="For example, approved by phone or purchase order." /></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy} onClick={accept}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Confirm acceptance</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
