import React, { useState } from "react";
import { CreditCard, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import GoCardlessDropinFlow from "@/components/gocardless/GoCardlessDropinFlow";
import { useHistoricalInvoiceTenant } from "@/hooks/useHistoricalInvoices";
import { useMandateReplacement } from "./useMandateReplacement";

const statusLabels = {
  switching: "Direct Debit change in progress",
  authorizing: "Bank authorisation in progress",
  awaiting_confirmation: "Awaiting verified confirmation",
  action_required: "Action required — change not confirmed",
  completed: "Direct Debit change verified",
  cancelled: "Direct Debit change cancelled",
};

export function hostedMandateUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && ["pay.gocardless.com", "pay-sandbox.gocardless.com"].includes(url.hostname)
      ? url.href : null;
  } catch {
    return null;
  }
}

// Render in History's persistent header action area, outside !hasBanner.
// Identity-keying also discards an open provider flow on account/tenant changes.
export default function HistoryMandateReplacement({ memberInfo }) {
  const tenantId = useHistoricalInvoiceTenant(memberInfo?.tenant_id || memberInfo?.tenantId || null);
  return (
    <MandateReplacementAction
      key={`${tenantId || ""}:${memberInfo?.id || ""}`}
      memberId={memberInfo?.id}
      tenantId={tenantId}
    />
  );
}

function MandateReplacementAction({ memberId, tenantId }) {
  const { data, isLoading, isError, isFetching, refetch, busy, error, perform, refresh } =
    useMandateReplacement({ memberId, tenantId });
  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState(null);
  const [hostedUrl, setHostedUrl] = useState(null);
  const [notice, setNotice] = useState("");
  const [launchError, setLaunchError] = useState("");
  const pending = busy || isFetching || !!flow;
  const status = data?.operation?.status;
  const statusLabel = statusLabels[status] || "Direct Debit change awaiting verification";

  const launch = async () => {
    if (pending || !data?.eligible || !(data.canStart || data.canResume)) return;
    setNotice("");
    setLaunchError("");
    setHostedUrl(null);
    // The server's start action creates OR resumes the current operation.
    const result = await perform("start");
    if (!result) return;
    const url = hostedMandateUrl(result.authorisationUrl);
    setHostedUrl(url);
    // Never reopen authorisation when the server has moved to review/terminal state.
    if (!result.eligible || !["authorizing", undefined].includes(result.operation?.status)) return;
    if (result.flowId) {
      setOpen(false);
      setFlow({ flowId: result.flowId, environment: result.environment });
    } else if (url) {
      window.location.assign(url);
    } else {
      setLaunchError("GoCardless could not be opened. Check the status before trying again.");
    }
  };

  const finish = async (succeeded) => {
    setFlow(null);
    setOpen(true);
    setNotice(succeeded
      ? "Bank authorisation submitted. Your change is pending verified confirmation; it is not yet complete."
      : "GoCardless was closed. We are checking the provider status; your change is not confirmed.");
    await refresh();
  };

  const fallback = () => {
    setFlow(null);
    setOpen(true);
    setNotice("The GoCardless window could not load. Continue on the secure hosted page.");
    if (hostedUrl) window.location.assign(hostedUrl);
    else setLaunchError("The hosted link is unavailable. Check the status and try again.");
  };

  if (!memberId) return null;
  if (isLoading) return <div aria-label="Checking Direct Debit availability" className="h-9 w-44 animate-pulse rounded-md bg-slate-100" />;
  if (isError && !data) return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600" role="alert">
      <span>Direct Debit options could not be checked.</span>
      <Button type="button" size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()}>Retry</Button>
    </div>
  );
  // Eligibility is authoritative: do not infer DD eligibility from history rows.
  if (!data?.eligible) return null;

  return (
    <>
      <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
          <CreditCard className="mr-2 h-4 w-4" aria-hidden="true" />
          Change Direct Debit
        </Button>
        {data.operation && <p className="max-w-xs text-xs text-slate-600" role="status">{statusLabel}</p>}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Change your Direct Debit</DialogTitle>
            <DialogDescription>Securely authorise new bank details with GoCardless.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm text-slate-700">
            <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-600" aria-hidden="true" />
              <div className="space-y-2">
                <p>Enter your new bank details exclusively on GoCardless. We will never ask you to enter them here.</p>
                <p>Your old working mandate remains in place until a verified handover. Completing bank authorisation alone does not confirm this change or alter your membership.</p>
              </div>
            </div>
            {data.reason && <p>{data.reason}</p>}
            {data.operation && (
              <div className="space-y-1 rounded-md border border-slate-200 p-3" role="status">
                <p className="font-medium">{statusLabel}</p>
                {data.operation.message && <p>{data.operation.message}</p>}
                {status === "action_required" && <p>The replacement has not been confirmed. Please follow the guidance above or contact the membership team.</p>}
              </div>
            )}
            {notice && <p role="status">{notice}</p>}
            {(error || launchError || isError) && (
              <p role="alert" className="text-red-700">{error || launchError || "The latest status could not be loaded. Please check again."}</p>
            )}
            {!data.canStart && !data.canResume && !data.operation && !data.reason && (
              <p>A Direct Debit change cannot be started at the moment. Please contact the membership team.</p>
            )}
            {hostedUrl && status === "authorizing" && (
              <a href={hostedUrl} className="inline-flex items-center gap-2 text-sm font-medium underline underline-offset-4">
                Continue on GoCardless <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:flex-wrap sm:justify-end">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Close</Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => refresh()}>
                {busy ? "Checking…" : "Check status"}
              </Button>
              {(data.canStart || data.canResume) && (
                <Button type="button" disabled={pending} onClick={launch}>
                  {busy ? "Please wait…" : data.canResume ? "Resume with GoCardless" : "Continue to GoCardless"}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {flow && (
        <GoCardlessDropinFlow
          flowId={flow.flowId}
          environment={flow.environment}
          onSuccess={() => finish(true)}
          onExit={() => finish(false)}
          onLoadFailure={fallback}
        />
      )}
    </>
  );
}
