import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FlaskConical, Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function formatDate(value, withTime = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return withTime
    ? date.toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    })
    : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatAmount(amountMinor, currency) {
  if (amountMinor == null) return null;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
    }).format(amountMinor / 100);
  } catch {
    return `${currency || ""} ${(amountMinor / 100).toFixed(2)}`.trim();
  }
}

const statusVariant = status => ({
  would_run: "default",
  eligible: "default",
  due: "default",
  conditional: "secondary",
  blocked: "destructive",
  error: "destructive",
  skipped: "outline",
  not_due: "outline",
  no_action: "outline",
}[status] || "secondary");

const statusLabel = status => String(status || "unknown").replace(/_/g, " ");

export async function requestDirectDebitDryRun(planId, { signal } = {}) {
  const response = await fetch("/api/admin/gocardless-dd", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "dry_run", planId }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export function DryRunReport({ result }) {
  if (!result) return null;
  const jobs = Array.isArray(result.jobs) ? result.jobs : [];
  const limitations = Array.isArray(result.limitations) ? result.limitations : [];

  return (
    <div className="space-y-4" data-testid="dry-run-report">
      <Alert className="border-emerald-600/40 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-100">
        <FlaskConical className="h-4 w-4" />
        <AlertDescription>
          <strong>No changes were made.</strong> This preview did not collect money, update records,
          send messages, or claim scheduled work.
        </AlertDescription>
      </Alert>

      <div className="text-sm">
        <span className="font-medium">{result.plan?.ownerLabel || "Unknown payer"}</span>
        {result.plan?.id && <span className="text-muted-foreground"> · Plan {result.plan.id}</span>}
        {result.evaluatedAt && (
          <p className="text-xs text-muted-foreground" data-testid="text-dry-run-evaluated">
            Evaluated {formatDate(result.evaluatedAt, true)}
          </p>
        )}
      </div>

      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="text-xs">
          Scheduled jobs run independently. This preview does not guarantee their order or that this
          plan will be included in a future bounded batch. Actions remain conditional on successful
          claims, fresh data, and provider acceptance at execution time.
        </AlertDescription>
      </Alert>

      <div className="space-y-3" aria-label="Scheduled job results">
        {jobs.length === 0 && (
          <p className="text-sm text-muted-foreground">No scheduled job evaluations were returned.</p>
        )}
        {jobs.map((job, jobIndex) => (
          <section key={job.id || jobIndex} className="rounded-md border p-3 space-y-3"
            data-testid={`dry-run-job-${job.id || jobIndex}`}>
            <h3 className="font-semibold">{job.label || job.id || "Scheduled job"}</h3>
            {(job.evidence || []).length > 0 && (
              <div className="rounded-sm bg-muted/50 p-2 space-y-1" aria-label={`${job.label || job.id || "Job"} evidence`}>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fresh evidence</h4>
                <ul className="text-xs space-y-1">
                  {job.evidence.map((evidence, evidenceIndex) => (
                    <li key={`${evidence.method || evidence.providerMethod || "evidence"}-${evidenceIndex}`}>
                      <span className="font-medium">
                        {evidence.method || evidence.providerMethod || evidence.description || evidence.type || "Evidence check"}
                      </span>
                      {evidence.status && <span> · {statusLabel(evidence.status)}</span>}
                      {evidence.evidenceAt && <span className="text-muted-foreground"> · checked {formatDate(evidence.evidenceAt, true)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(job.stages || []).map((stage, stageIndex) => (
              <div key={`${stage.stage || "stage"}-${stageIndex}`} className="border-l-2 pl-3 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="text-sm font-medium">{stage.stage || "Evaluation"}</h4>
                  <Badge variant={statusVariant(stage.status)}>{statusLabel(stage.status)}</Badge>
                </div>
                {stage.reason && <p className="text-sm">{stage.reason}</p>}
                {stage.evidenceAt && (
                  <p className="text-xs text-muted-foreground">
                    Evidence checked {formatDate(stage.evidenceAt, true)}
                  </p>
                )}
                {(stage.operations || []).length > 0 && (
                  <ul className="list-disc pl-5 text-sm space-y-1" aria-label={`${stage.stage || "Stage"} operations`}>
                    {stage.operations.map((operation, operationIndex) => {
                      const amount = formatAmount(operation.amountMinor, operation.currency);
                      const continuations = [
                        operation.continuation,
                        typeof operation.conditional === "string" ? operation.conditional : null,
                      ].filter((value, index, values) => value && values.indexOf(value) === index);
                      return (
                        <li key={`${operation.type || "operation"}-${operationIndex}`}>
                          <div>
                            <span>{operation.description || statusLabel(operation.type)}</span>
                            {amount && <span> · {amount}</span>}
                            {operation.date && <span> · {formatDate(operation.date)}</span>}
                            {operation.conditional && <span className="text-muted-foreground"> · conditional</span>}
                          </div>
                          {continuations.map((continuation, continuationIndex) => (
                            <p key={continuationIndex} className="text-xs text-muted-foreground mt-0.5">
                              Downstream intention: {continuation}
                            </p>
                          ))}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>

      {limitations.length > 0 && (
        <section className="space-y-1" aria-labelledby="dry-run-limitations-title">
          <h3 id="dry-run-limitations-title" className="text-sm font-semibold">Limitations</h3>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function DirectDebitDryRun({ plan }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const controllerRef = useRef(null);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);

  const cancelRequest = useCallback(() => {
    requestRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    loadingRef.current = false;
    setLoading(false);
  }, []);

  useEffect(() => {
    cancelRequest();
    setOpen(false);
    setResult(null);
    setError("");
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      loadingRef.current = false;
    };
  }, [plan.id, cancelRequest]);

  const run = useCallback(async (event) => {
    event?.stopPropagation();
    if (loadingRef.current) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    loadingRef.current = true;
    setOpen(true);
    setLoading(true);
    setResult(null);
    setError("");

    try {
      const nextResult = await requestDirectDebitDryRun(plan.id, { signal: controller.signal });
      if (requestRef.current !== requestId || controller.signal.aborted) return;
      setResult(nextResult);
    } catch (requestError) {
      if (requestRef.current !== requestId || controller.signal.aborted || requestError.name === "AbortError") return;
      setError(requestError.message || "The dry run could not be evaluated.");
    } finally {
      if (requestRef.current === requestId && !controller.signal.aborted) {
        loadingRef.current = false;
        setLoading(false);
        controllerRef.current = null;
      }
    }
  }, [plan.id]);

  const close = useCallback(() => {
    cancelRequest();
    setOpen(false);
    setResult(null);
    setError("");
  }, [cancelRequest]);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={run}
        disabled={loading}
        data-testid={`button-dry-run-${plan.id}`}
        aria-label={`Dry run scheduled jobs for ${plan.payer_name || `plan ${plan.id}`}`}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
        Dry run
      </Button>

      <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) close(); }}>
        <DialogContent
          className="max-w-3xl max-h-[85vh] overflow-y-auto"
          data-testid="dialog-dd-dry-run"
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>
              Direct Debit dry run — {result?.plan?.ownerLabel || plan.payer_name || `Plan ${plan.id}`}
            </DialogTitle>
            <DialogDescription>
              Preview what scheduled Direct Debit jobs would currently do for this adopted plan.
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <div className="flex items-center gap-2 py-8 justify-center" role="status" aria-live="polite">
              <Loader2 className="h-5 w-5 animate-spin" />
              Evaluating current scheduled-job evidence…
            </div>
          )}
          {!loading && error && (
            <Alert variant="destructive" data-testid="alert-dry-run-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <p>The dry run could not be evaluated. {error}</p>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={run}
                  data-testid="button-dry-run-retry">
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!loading && !error && <DryRunReport result={result} />}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} data-testid="button-dry-run-close">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}