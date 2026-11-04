import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { surveyLifecycleRequest, useSurveyLifecycleMutation } from "@/hooks/useSurveyLifecycle";
import { surveyActionLabels } from "@/lib/surveyLifecycle";

export default function SurveyLifecycleDialog({ request, onClose, onComplete }) {
  if (!request) return null;
  // A fresh transaction gets fresh acknowledgements, even when reopening the same action.
  return <LifecycleTransaction key={`${request.form_id}:${request.assignment_id || ""}:${request.action}:${JSON.stringify(request.changes || {})}`} request={request} onClose={onClose} onComplete={onComplete} />;
}

function LifecycleTransaction({ request, onClose, onComplete }) {
  const [stage, setStage] = useState(1);
  const [acknowledged, setAcknowledged] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const preview = useQuery({
    queryKey: ["survey-lifecycle-impact", request.form_id, request.action, request.assignment_id, request.changes || null],
    queryFn: ({ signal }) => surveyLifecycleRequest({ operation: "preview", ...request }, { signal }),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const execute = useSurveyLifecycleMutation();
  const impact = preview.data?.impact;
  const token = preview.data?.confirmation_token;
  const deleting = request.action === "delete";
  const allowed = !!impact && !!token && impact.form_id === request.form_id
    && impact.action === request.action
    && (!request.assignment_id || impact.assignment_id === request.assignment_id)
    && (!deleting || impact.deletion_allowed === true);
  const title = surveyActionLabels[request.action] || "Update Survey";
  const proposedChanges = request.action === "update_assignment" ? request.changes : null;
  const proposedDate = (value, fallback) => value ? new Date(value).toLocaleString() : fallback;
  const count = value => Number.isFinite(Number(value)) && value != null ? Number(value).toLocaleString() : "Not verified";
  const refresh = () => {
    setStage(1);
    setAcknowledged(false);
    setDeleteConfirmation("");
    execute.reset();
    preview.refetch();
  };
  const confirm = () => {
    if (!allowed || !acknowledged || stage !== 2 || (deleting && deleteConfirmation !== "DELETE")) return;
    execute.mutate({
      ...request, confirmation_token: token, acknowledged: true,
      ...(deleting ? { delete_confirmation: deleteConfirmation } : {}),
    }, {
      onSuccess: result => {
        toast.success(`${title} completed`);
        onComplete?.(result);
        onClose();
      },
      onError: error => {
        // Never reuse acknowledgement after a stale impact or competing write.
        if (error.status === 409 || error.status === 410 || error.code === "STALE_IMPACT") {
          refresh();
          toast.error("Survey activity changed. Review the refreshed impact before confirming again.");
        }
      },
    });
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !execute.isPending) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" data-testid="survey-lifecycle-dialog" onInteractOutside={event => { if (execute.isPending) event.preventDefault(); }} onEscapeKeyDown={event => { if (execute.isPending) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Step {stage} of 2 · {stage === 1 ? "Review the impact" : "Explicit acknowledgement"}</DialogDescription>
        </DialogHeader>
        {preview.isFetching ? (
          <div className="space-y-3 py-4 animate-pulse" role="status" aria-label="Checking survey dependencies">
            <div className="h-5 w-2/3 rounded bg-slate-200" /><div className="h-20 rounded bg-slate-100" /><div className="h-12 rounded bg-slate-100" />
          </div>
        ) : preview.isError ? (
          <div role="alert" className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p>{preview.error.message}</p><p>No changes have been made.</p>
            <Button variant="outline" onClick={refresh}>Retry impact check</Button>
          </div>
        ) : impact ? (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="font-semibold text-slate-900">{impact.name || "Survey"}</p>
              <p className="mt-1 text-slate-600">Current lifecycle: <span className="capitalize">{impact.state}</span></p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                <dt>Retained responses</dt><dd className="text-right font-medium">{count(impact.response_count)}</dd>
                <dt>Event assignments</dt><dd className="text-right font-medium">{count(impact.assignment_count)}</dd>
                <dt>Recorded invitations</dt><dd className="text-right font-medium">{count(impact.invitation_count)}</dd>
              </dl>
              <p className="mt-3 text-xs text-slate-500">Unrecorded shared links may also exist. No recorded invitation does not mean a link has never been shared.</p>
            </div>
            {proposedChanges && <div className="rounded-lg border border-slate-200 p-4" data-testid="assignment-proposed-changes">
              <h4 className="font-medium text-slate-900">Proposed event response settings</h4>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-slate-600">
                <dt>Opens</dt><dd className="text-right font-medium">{proposedDate(proposedChanges.opens_at, "Immediately")}</dd>
                <dt>Closes</dt><dd className="text-right font-medium">{proposedDate(proposedChanges.closes_at, "No close date")}</dd>
                <dt>Access</dt><dd className="text-right font-medium">{proposedChanges.access_mode === "authenticated" ? "Members only · sign-in required" : "Public · anyone with the link"}</dd>
              </dl>
              <p className="mt-3 text-xs text-slate-500">Dates are shown in your local time. Existing tokens are retained. These changes do not publish draft edits or override the underlying survey lifecycle.</p>
            </div>}
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-warning">
              <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p className="font-medium">
                {impact.stops_submissions ? "Existing affected links will stop accepting responses." : deleting ? "This permanently deletes the unused survey." : "Existing access and original expiry rules still apply."}
              </p></div>
              <p className="mt-2">{impact.reversible ? "This action is reversible. Restoring access does not extend original expiry dates or bypass eligibility checks." : "This action cannot be undone."}</p>
              {!deleting && <p className="mt-2">Responses, published versions and historical event associations are retained. An event assignment action does not change the underlying survey lifecycle.</p>}
            </div>
            <div>
              <h4 className="font-medium text-slate-900">Associated events</h4>
              {impact.events?.length ? (
                <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-slate-600">{impact.events.map((event, index) => <li key={`${event.id}:${index}`}>{event.title || "Untitled event"}{event.status ? ` · ${event.status}` : ""}</li>)}</ul>
              ) : <p className="mt-1 text-slate-500">No associated events reported by the impact check.</p>}
            </div>
            {deleting && !impact.deletion_allowed && <p role="alert" className="rounded-md bg-red-50 p-3 text-red-800">Permanent deletion is blocked by retained dependencies. Archive this survey instead.</p>}
            {stage === 2 && (
              <div className="space-y-4 border-t border-slate-200 pt-4">
                <div className="flex items-start gap-3">
                  <Checkbox id="survey-impact-acknowledgement" checked={acknowledged} onCheckedChange={value => setAcknowledged(value === true)} disabled={execute.isPending} />
                  <Label htmlFor="survey-impact-acknowledgement" className="text-sm leading-relaxed">
                    {impact.stops_submissions ? "I understand that this action will prevent members from submitting responses using the affected existing survey links." : deleting ? "I understand that this permanently deletes the unused survey and cannot be undone." : "I have reviewed the impact and understand that original link expiry and access conditions still apply."}
                  </Label>
                </div>
                {deleting && <div className="space-y-2"><Label htmlFor="survey-delete-confirmation">Type DELETE to confirm permanent deletion</Label><Input id="survey-delete-confirmation" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} autoComplete="off" disabled={execute.isPending} /></div>}
              </div>
            )}
            {execute.isError && <div role="alert" className="text-red-700">{execute.error.message} No changes were confirmed. <button className="underline" onClick={refresh}>Review impact again</button></div>}
          </div>
        ) : <p role="alert">Impact details are incomplete. No changes can be made.</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={execute.isPending} onClick={onClose}>Cancel</Button>
          {stage === 2 && <Button variant="outline" disabled={execute.isPending} onClick={() => { setStage(1); setAcknowledged(false); }}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>}
          {stage === 1 ? <Button disabled={!allowed || preview.isFetching} onClick={() => setStage(2)}>Continue to acknowledgement</Button> : <Button variant={deleting || impact?.stops_submissions ? "destructive" : "default"} disabled={!allowed || !acknowledged || execute.isPending || preview.isFetching || (deleting && deleteConfirmation !== "DELETE")} onClick={confirm}>{execute.isPending ? "Applying change…" : title}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
