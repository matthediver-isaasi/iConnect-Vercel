import React, { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useRevokeFormAlert } from "@/hooks/useFormAlerts";

export default function RevokeSubmissionAlert({ formId, submissionId, tenantId }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const mutation = useRevokeFormAlert(tenantId);
  const revoke = async () => {
    try {
      await mutation.mutateAsync({ formId, submissionId });
      setRevoked(true);
      setConfirmOpen(false);
      toast.success("Submission alert links revoked");
    } catch {
      // Keep confirmation open so the administrator can retry.
    }
  };
  return (
    <div className="border-t border-slate-200 pt-4 space-y-2" data-testid="submission-alert-revoke">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-800">Submission alert links</p>
          <p className="text-xs text-slate-500">Revoke bearer links for this submission without deleting its answers.</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={revoked || !tenantId || !formId || !submissionId} onClick={() => setConfirmOpen(true)} data-testid="button-revoke-submission-alert">
          {revoked ? "Links revoked" : "Revoke alert links"}
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={open => { if (!mutation.isPending) setConfirmOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke submission alert links?</AlertDialogTitle>
            <AlertDialogDescription>Existing alert links for this submission will stop working for all recipients. This cannot be undone. The submission and future alerts are not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.isError && <p role="alert" className="text-sm text-red-600">{mutation.error?.message || "Unable to revoke links. Please try again."}</p>}
          <AlertDialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={mutation.isPending} onClick={revoke} data-testid="button-confirm-revoke-submission-alert">{mutation.isPending ? "Revoking…" : "Revoke links"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
