import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export default function CampaignUnsavedChangesDialog({ guard }) {
  return <Dialog open={!!guard.pending} onOpenChange={open => { if (!open) guard.stay(); }}>
    <DialogContent className="w-[calc(100%-2rem)] max-w-xl" hideCloseButton={guard.saving}
      data-testid="dialog-campaign-unsaved-changes">
      <DialogHeader>
        <DialogTitle>Unsaved campaign changes</DialogTitle>
        <DialogDescription>Save your campaign before leaving, save and keep editing, or leave without saving your changes.</DialogDescription>
      </DialogHeader>
      {guard.error && <p role="alert" className="text-sm text-destructive">{guard.error}</p>}
      <DialogFooter className="gap-2 sm:flex-wrap sm:space-x-0">
        <Button variant="outline" disabled={guard.saving} onClick={guard.discard}>Leave without saving</Button>
        <Button variant="outline" disabled={guard.saving} onClick={guard.saveAndStay}>Save and stay</Button>
        <Button disabled={guard.saving} onClick={guard.saveAndLeave}>Save and leave</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
