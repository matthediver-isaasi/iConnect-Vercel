import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export default function DuplicateAudienceListDialog({ list, onClose, onCreated }) {
  const [name, setName] = useState(`${list.name} (copy)`.slice(0, 200));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  async function duplicate(event) {
    event.preventDefault();
    if (saving.current || !name.trim()) return;
    saving.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/audience-lists", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "duplicate", sourceId: list.id, name: name.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not duplicate this list.");
      onCreated(name.trim());
    } catch (err) {
      setError(err.message || "Could not duplicate this list.");
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !saving.current) onClose(); }}>
      <DialogContent className="max-w-lg">
        <form onSubmit={duplicate} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Duplicate email list</DialogTitle>
            <DialogDescription>
              Copy the audience rules, communication category, opt-out setting and external contacts.
              Existing consent records are preserved. Campaign history is not copied and no emails will be sent.
            </DialogDescription>
          </DialogHeader>
          {list.ignore_opt_outs && <p className="text-sm text-amber-800">This list is set to ignore opt-out choices. The copy will keep that setting.</p>}
          <div className="space-y-2">
            <Label htmlFor="duplicate-list-name">New list name</Label>
            <Input id="duplicate-list-name" value={name} onChange={e => setName(e.target.value)} maxLength={200} disabled={pending} required autoFocus />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {pending ? "Duplicating…" : "Duplicate list"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
