import React, { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export async function requestCollection(body) {
  const response = await fetch("/api/admin/gocardless-dd", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Collection request failed (${response.status})`);
  return data;
}

export default function DirectDebitCollection({ plan }) {
  const queries = useQueryClient();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const refresh = () => queries.invalidateQueries({ queryKey: ["/api/admin/gocardless-dd"] });
  const request = async execute => {
    if (pending.current || (execute && attempted)) return;
    pending.current = true;
    setBusy(true);
    setOpen(true);
    if (execute) setAttempted(true);
    try {
      setResult(await requestCollection(execute
        ? { action: "run_collection", planId: plan.id, confirmed: true, confirmationToken: result.confirmation.token, reason }
        : { action: "preview_collection", planId: plan.id }));
    } catch (error) {
      setResult({ status: execute ? "uncertain" : "blocked", reason: execute
        ? "The response was not confirmed. Do not retry: a payment may have been submitted. A finance operator must verify and reconcile the exact existing payment. Refresh only reads records; it does not recover or resubmit."
        : error.message });
    } finally {
      if (execute) refresh();
      pending.current = false;
      setBusy(false);
    }
  };
  const confirmation = result?.status === "ready" ? result.confirmation : null;
  return <>
    <Button type="button" size="sm" variant="outline" disabled={busy || attempted}
      data-testid={`button-live-collection-${plan.id}`} onClick={event => { event.stopPropagation(); request(false); }}>
      {busy ? "Checking…" : "Run collection now"}
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!pending.current) setOpen(value); }}>
      <DialogContent onClick={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>Collect this period now</DialogTitle>
          <DialogDescription>Finance-authorized timing override for this plan only. No renewals, completion or notification stages run.</DialogDescription>
        </DialogHeader>
        <p className="text-sm">Limited to the current London calendar month, or tomorrow’s due date. Only one manual attempt per plan per London calendar month is permitted. The intended period and future cadence stay unchanged. Provider notice dates and all collection holds still apply.</p>
        {busy && <p role="status">Please wait. Do not submit again or close this page.</p>}
        {confirmation && <div className="space-y-3 text-sm">
          <dl className="space-y-1">
            <div><dt className="inline font-semibold">Owner: </dt><dd className="inline">{confirmation.ownerLabel}</dd></div>
            <div><dt className="inline font-semibold">Plan: </dt><dd className="inline">{plan.id}</dd></div>
            <div><dt className="inline font-semibold">Mandate: </dt><dd className="inline">{confirmation.mandate}</dd></div>
            <div><dt className="inline font-semibold">Amount: </dt><dd className="inline">{confirmation.currency} {(confirmation.amountMinor / 100).toFixed(2)}</dd></div>
            <div><dt className="inline font-semibold">Intended period due: </dt><dd className="inline">{confirmation.dueDate}</dd></div>
            <div><dt className="inline font-semibold">Provider earliest debit: </dt><dd className="inline">{confirmation.date}</dd></div>
            <div><dt className="inline font-semibold">GoCardless environment: </dt><dd className="inline uppercase">{confirmation.environment}</dd></div>
          </dl>
          <p className="rounded border border-red-400 bg-red-50 p-3 text-red-950" role="alert">
            This is NOT a dry run. A live environment submits a real-money payment against this mandate, even before the scheduled processing time. Sandbox uses test payments. This authorizes one attempt only; ambiguous outcomes must be reconciled, not retried.
          </p>
          <label className="block">Reason for collecting now (10–500 characters)
            <textarea className="mt-1 w-full rounded border p-2" value={reason} minLength={10} maxLength={500}
              disabled={busy || attempted} onChange={event => setReason(event.target.value)} />
          </label>
        </div>}
        {result && !confirmation && <div role="status" className="space-y-2 text-sm">
          <strong className="uppercase">{result.status}</strong><p>{result.reason}</p>
          {result.payment && <p>Payment {result.payment.id} · {result.payment.currency} {(result.payment.amountMinor / 100).toFixed(2)} · Bank debit {result.payment.date} · {result.payment.status}</p>}
          {(result.errors || []).map((error, index) => <p key={index}>{error.stage}: {error.error}</p>)}
        </div>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { refresh(); setOpen(false); }}>Close and refresh records</Button>
          {confirmation && <Button variant="destructive" disabled={busy || attempted || reason.trim().length < 10}
            onClick={() => request(true)}>Confirm collection now</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}