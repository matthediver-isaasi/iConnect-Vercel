import React from "react";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export default function PopupUnsavedChangesDialog({ guard, subject = "popup" }) {
  return <AlertDialog open={!!guard.pending} onOpenChange={(open) => { if (!open) guard.stay(); }}>
    <AlertDialogContent data-testid="dialog-popup-unsaved-changes">
      <AlertDialogHeader>
        <AlertDialogTitle>Leave with unsaved changes?</AlertDialogTitle>
        <AlertDialogDescription>Your {subject} changes have not been saved. Save before leaving, discard them, or stay and keep editing.</AlertDialogDescription>
      </AlertDialogHeader>
      {guard.error && <p role="alert" className="text-sm text-destructive">{guard.error}</p>}
      <AlertDialogFooter>
        <Button variant="outline" disabled={guard.saving} onClick={guard.stay}>Stay here</Button>
        <Button variant="destructive" disabled={guard.saving} onClick={guard.discard}>Leave without saving</Button>
        {guard.canSave && <Button disabled={guard.saving} onClick={guard.saveAndLeave}>{guard.saving ? "Saving…" : "Save and leave"}</Button>}
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
