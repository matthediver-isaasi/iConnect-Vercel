import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Kept independent of editor state so all event forms can use the same
// confirmation and the decision can be applied only after persistence.
export default function SpeakerBadgeRemovalDialog({ open, speakers = [], onKeep, onRemove, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel?.(); }}>
      <DialogContent data-testid="speaker-badge-removal-dialog">
        <DialogHeader>
          <DialogTitle>Remove awarded speaker badge?</DialogTitle>
          <DialogDescription>
            {speakers.length === 1
              ? "A speaker assignment has been removed from this event or agenda item."
              : `${speakers.length} speakers have removed assignments on this event or its agenda items.`}
            {" "}Their awarded badge can be kept, or removed after the event is saved. A badge still held through another valid assignment or a manual award will be retained. Training vouchers always remain unchanged.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel save</Button>
          <Button variant="secondary" onClick={onKeep} data-testid="button-keep-speaker-badge">Keep badge</Button>
          <Button variant="destructive" onClick={onRemove} data-testid="button-remove-speaker-badge">Remove badge</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}