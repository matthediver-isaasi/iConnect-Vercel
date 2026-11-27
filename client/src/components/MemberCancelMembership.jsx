import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useFormAlertTenant } from "@/hooks/useFormAlerts";
import { adminFetch } from "@/lib/adminFetch";
import { memberChangeEndpoint, readMemberChangeResponse, requestDate, requestMoney } from "@/lib/memberChangeRequests";
import MemberCancelUnpaidMembership from "@/components/MemberCancelUnpaidMembership";

// CRM entry point for the existing administrator cancellation workflow.
// The server re-verifies membership, policy and billing evidence on every
// preview and confirmation; this component never decides eligibility alone.

const PROVIDER_NAMES = { stripe: "Stripe", gocardless: "GoCardless" };
const BLOCKER_TEXT = {
  already_cancelled: "This membership has already been cancelled.",
  no_current_membership: "There is no current membership to cancel.",
  multiple_current_memberships: "More than one current membership is recorded. Review the membership history before cancelling.",
  organisation_funded: "This membership is paid for by the member's organisation, so it can't be cancelled from the member's record. Cancel it from the organisation's record instead.",
};

export function paymentStopText(provider, state) {
  const name = PROVIDER_NAMES[provider] || "the payment provider";
  switch (state) {
    case "not_required": return "No recurring payments needed stopping.";
    case "stopped": return `Recurring payments have been stopped with ${name}.`;
    case "pending": case "claimed": return `Stopping recurring payments with ${name} is in progress.`;
    case "not_started": return `Recurring payments with ${name} will be stopped when access ends.`;
    default: return `We couldn't confirm that recurring payments with ${name} were stopped. Use "Check payment stop" to try again.`;
  }
}
const needsPaymentCheck = latest => !!latest?.access_ended_at
  && !["stopped", "not_required"].includes(latest.providerState);

function outcomeFrom(record, provider) {
  const prepared = record?.authority?.providerPrepared;
  const providerKey = prepared?.authority?.provider || null;
  const state = !prepared ? "not_required" : !record.access_ended_at ? "not_started"
    : provider?.state || "uncertain";
  return {
    access: record.access_ended_at ? "Membership access has ended."
      : `Cancellation scheduled. Access continues until ${requestDate(record.effective_date)}.`,
    payments: paymentStopText(providerKey, state),
  };
}

async function post(tenantId, memberId, payload) {
  return readMemberChangeResponse(await adminFetch(memberChangeEndpoint, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, memberId }),
  }, tenantId));
}

export default function MemberCancelMembership({ memberId, tenantId }) {
  const scope = useFormAlertTenant("commerce.monthly-finance-report");
  // Only finance administrators may cancel; everyone else sees nothing here.
  if (!memberId || scope.status !== "ready" || scope.tenantId !== tenantId) return null;
  return <CancelMembershipCard key={`${tenantId}:${memberId}:${scope.scopeKey}`} memberId={memberId} tenantId={tenantId} />;
}

function CancelMembershipCard({ memberId, tenantId }) {
  const queryClient = useQueryClient();
  const statusKey = ["member-cancellation-status", tenantId, memberId];
  const status = useQuery({
    queryKey: statusKey,
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      const query = new URLSearchParams({ action: "cancellation_status", memberId });
      return readMemberChangeResponse(await adminFetch(`${memberChangeEndpoint}?${query}`, { credentials: "include", cache: "no-store" }, tenantId));
    },
  });
  const [dialog, setDialog] = useState(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState(null);

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: statusKey });
    void queryClient.invalidateQueries({ queryKey: ["member-amendments", tenantId, memberId] });
    void queryClient.invalidateQueries({ queryKey: ["member-membership", memberId] });
    void queryClient.invalidateQueries({ queryKey: ["member-detail", memberId] });
    void queryClient.invalidateQueries({ queryKey: ["member-membership-instalments"] });
    void queryClient.invalidateQueries({ queryKey: ["member-deletion-billing", memberId] });
  }

  async function checkPaymentStop(latest) {
    if (checking) return;
    setChecking(true); setNotice(null);
    try {
      const result = await post(tenantId, memberId, { action: "recover_cancellation", id: latest.id });
      setNotice({ tone: "status", text: outcomeFrom(result.record, result.provider).payments });
    } catch (failure) {
      setNotice({ tone: "alert", text: failure.message || "The payment stop could not be checked." });
    } finally {
      setChecking(false);
      refreshAll();
    }
  }

  const data = status.data;
  const latest = data?.latest || null;
  const scheduled = latest && !latest.access_ended_at ? latest : null;
  const current = data?.current;

  return <Card data-testid="card-member-cancel-membership">
    <CardHeader>
      <CardTitle className="text-base">Cancel membership</CardTitle>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      {status.isLoading && <p role="status" className="text-muted-foreground">Checking whether this membership can be cancelled…</p>}
      {status.isError && <div role="alert" className="space-y-2">
        <p>Cancellation options could not be loaded: {status.error.message}</p>
        <Button size="sm" variant="outline" onClick={() => status.refetch()} data-testid="button-cancel-membership-retry">Try again</Button>
      </div>}
      {notice && <p role={notice.tone} className="rounded-md bg-muted/50 p-3">{notice.text}</p>}
      {data && <>
        {latest?.mode === "member_paid_period" && <div className="space-y-1 rounded-md border p-3" data-testid="cancel-membership-member-request">
          <p><strong>{latest.access_ended_at ? "Cancelled" : "Cancellation scheduled"}</strong> by the member on {requestDate(latest.created_at)}.
            {" "}Paid up to {requestDate(latest.paidThroughDate)}; {latest.access_ended_at ? "access changed" : "access changes"} on {requestDate(latest.effective_date)}
            {latest.fallbackRoleName ? ` to ${latest.fallbackRoleName}` : ""}. New membership collections were stopped at confirmation.</p>
          {latest.reason && <p><span className="text-muted-foreground">Reason:</span> {latest.reason}</p>}
          {latest.roleOutcome && latest.roleOutcome !== "applied" && latest.roleOutcome !== "already_assigned" && <p>
            The role was not changed because it had been changed manually or is an administrator role. Review it if needed.</p>}
          {latest.providerState !== "not_required" && latest.providerState !== "stopped" && <p role="status">
            Direct Debit stop: {latest.providerState === "pending" ? "requested" : "not yet confirmed — review with the payment provider"}.</p>}
          {latest.financial_state === "manual_review" && <p role="status">A late or in-flight collection needs manual reconciliation.</p>}
        </div>}
        {scheduled && latest?.mode !== "member_paid_period" && <div className="space-y-2" data-testid="cancel-membership-scheduled">
          <p><strong>Cancellation scheduled.</strong> Access continues until {requestDate(scheduled.effective_date)}, then ends.
            {scheduled.providerState !== "not_required" ? " Recurring payments continue until then and are stopped when access ends." : ""}</p>
          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "withdraw", record: scheduled })} data-testid="button-withdraw-cancellation">
            Withdraw scheduled cancellation
          </Button>
        </div>}
        {latest?.access_ended_at && latest.mode !== "member_paid_period" && <div className="space-y-2" data-testid="cancel-membership-applied">
          <p><strong>Membership cancelled.</strong> Access ended on {requestDate(latest.access_ended_at)}. {paymentStopText(latest.provider, latest.providerState)}</p>
          {needsPaymentCheck(latest) && <Button size="sm" variant="outline" disabled={checking} onClick={() => checkPaymentStop(latest)} data-testid="button-check-payment-stop">
            {checking ? "Checking payment stop…" : "Check payment stop"}
          </Button>}
        </div>}
        {data.eligible ? <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground">
            {current?.tierLabel ? `${current.tierLabel} membership` : "Current membership"}, {requestDate(current?.termStartDate)} to {requestDate(current?.renewalDate)}.
            {" "}{data.timing === "immediate" ? "Under your cancellation policy, access ends on the day you cancel." : data.timing === "end_of_term" ? "Under your cancellation policy, access continues until the end of the current membership year." : ""}
          </p>
          <Button variant="destructive" size="sm" onClick={() => setDialog({ kind: "cancel" })} data-testid="button-cancel-membership">Cancel membership</Button>
        </div> : !scheduled && (data.blocker === "no_current_membership"
          ? <MemberCancelUnpaidMembership memberId={memberId} tenantId={tenantId} onChanged={refreshAll} />
          : BLOCKER_TEXT[data.blocker] && <p className="text-muted-foreground" data-testid="text-cancel-membership-blocked">{BLOCKER_TEXT[data.blocker]}</p>)}
      </>}
    </CardContent>
    {dialog?.kind === "cancel" && <CancelDialog memberId={memberId} tenantId={tenantId} onClose={() => setDialog(null)} onChanged={refreshAll} />}
    {dialog?.kind === "withdraw" && <WithdrawDialog memberId={memberId} tenantId={tenantId} record={dialog.record} onClose={() => setDialog(null)} onChanged={refreshAll} />}
  </Card>;
}

function PreviewSummary({ authority }) {
  const calculation = authority.calculation || {};
  const policy = authority.policySnapshot?.policy || {};
  const providerKey = authority.providerPrepared?.authority?.provider;
  const providerName = PROVIDER_NAMES[providerKey];
  const immediate = authority.timing === "immediate";
  const when = immediate ? "today" : `on ${requestDate(authority.effectiveDate)}`;
  const due = Number.isSafeInteger(calculation.paymentDueMinor) ? requestMoney(calculation.paymentDueMinor, calculation.currency) : "To be worked out by finance";
  const unused = policy.cancellationUnusedValue === "none" ? "Kept by the organisation. No refund or credit is due under your policy."
    : policy.cancellationUnusedValue === "tenant_surplus_policy" ? ({
      credit: "May be given as member credit after finance review. Nothing is issued now.",
      refund: "May be refunded after finance review. Nothing is refunded now.",
      approval: "Needs separate finance approval. Nothing is refunded or credited now.",
    }[policy.surplusHandling] || "Decided in finance review. Nothing is refunded or credited now.")
      : "Decided in finance review. Nothing is refunded or credited now.";
  return <dl className="space-y-3 text-sm" data-testid="cancel-membership-preview">
    <div><dt className="font-medium">When access ends</dt>
      <dd>{immediate ? `Today (${requestDate(authority.effectiveDate)}). The member loses access straight away.` : `${requestDate(authority.effectiveDate)}, the end of the current membership year. The member keeps access until then.`}</dd></div>
    <div><dt className="font-medium">Recurring payments</dt>
      <dd>{providerKey === "stripe" ? `The monthly card payments with ${providerName} will be stopped ${when}.`
        : providerKey === "gocardless" ? `The Direct Debit subscription with ${providerName} will be stopped ${when}. The Direct Debit mandate itself stays in place; cancel it from the Direct Debit console if needed.`
          : authority.planSnapshot ? "This plan has no provider subscription to stop. Check the Direct Debit console for any remaining collections."
            : "Paid upfront. There are no recurring payments to stop."}</dd></div>
    <div><dt className="font-medium">Balance due for time already used</dt><dd>{due}</dd></div>
    <div><dt className="font-medium">Unused value</dt><dd>{unused}</dd></div>
    {authority.financialReviewReason && <p className="text-muted-foreground">Finance will need to review the payments for this membership after cancelling.</p>}
    <p className="text-muted-foreground">Invoices, payments and membership history are kept.</p>
  </dl>;
}

function CancelDialog({ memberId, tenantId, onClose, onChanged }) {
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function run(action) {
    if (lock.current) return;
    lock.current = true; setBusy(action); setError(null);
    try {
      if (action === "preview") {
        const result = await post(tenantId, memberId, { action: "preview_cancellation", selection: { reason: reason.trim() } });
        if (!result?.authority?.effectiveDate || !result.authority.timing || !/^[a-f0-9]{64}$/.test(result.fingerprint || "")) {
          throw new Error("A valid cancellation summary was not returned. Try again.");
        }
        if (alive.current) { setPreview(result); setConfirmed(false); }
        return;
      }
      if (action === "confirm") {
        // One stable key per approval: a lost response is recovered, never repeated blindly.
        const stable = attempt || { key: crypto.randomUUID(), fingerprint: preview.fingerprint, selection: { reason: reason.trim() } };
        setAttempt(stable);
        const result = await post(tenantId, memberId, { action: "confirm_cancellation", ...stable, approve: true });
        if (!result?.record?.id) throw new Error("The cancellation outcome was not confirmed. Use \"Check outcome\".");
        if (alive.current) setOutcome(outcomeFrom(result.record, result.provider));
        onChanged();
        return;
      }
      // Recover by the original key and fingerprint.
      const result = await post(tenantId, memberId, { action: "recover_cancellation", key: attempt.key, fingerprint: attempt.fingerprint });
      if (result?.record === null) {
        // Nothing was saved: start a fresh review rather than replaying an old summary.
        if (alive.current) { setAttempt(null); setPreview(null); setConfirmed(false); setError(new Error("No cancellation was saved. Review the cancellation again.")); }
        return;
      }
      if (!result?.record?.id) throw new Error("The cancellation outcome was not confirmed.");
      if (alive.current) setOutcome(outcomeFrom(result.record, result.provider));
      onChanged();
    } catch (failure) {
      if (alive.current) setError(failure);
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
    }
  }

  const awaitingRecovery = !!attempt && !outcome;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent data-testid="dialog-cancel-membership">
      <DialogHeader>
        <DialogTitle>Cancel membership</DialogTitle>
        <DialogDescription>Review what happens before confirming. The timing follows your organisation's cancellation policy.</DialogDescription>
      </DialogHeader>
      {outcome ? <div role="status" className="space-y-2 text-sm" data-testid="cancel-membership-outcome">
        <p className="font-medium">{outcome.access}</p>
        <p>{outcome.payments}</p>
        <p className="text-muted-foreground">Any balance or unused value is handled in the finance review on the Membership tab.</p>
      </div> : <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="cancel-membership-reason">Reason (required)</Label>
          <Textarea id="cancel-membership-reason" maxLength={2000} value={reason} disabled={!!attempt || !!busy}
            onChange={event => { setReason(event.target.value); setPreview(null); setConfirmed(false); setError(null); }}
            data-testid="input-cancel-membership-reason" />
        </div>
        {!preview && <Button type="button" variant="outline" disabled={!reason.trim() || !!busy} onClick={() => run("preview")} data-testid="button-review-cancellation">
          {busy === "preview" ? "Checking…" : "Review cancellation"}
        </Button>}
        {preview && <>
          <PreviewSummary authority={preview.authority} />
          {!attempt && <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} data-testid="checkbox-confirm-cancel-membership" />
            <span>I confirm this membership should be cancelled as described above.</span>
          </label>}
        </>}
        {awaitingRecovery && !busy && <p role="status" className="text-sm">We couldn't confirm whether the cancellation was saved. Check the outcome before trying again.</p>}
      </div>}
      {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{error.message}</p>}
      <DialogFooter>
        {outcome ? <Button onClick={onClose} data-testid="button-cancel-membership-done">Done</Button> : <>
          <Button variant="outline" disabled={!!busy} onClick={onClose} data-testid="button-cancel-membership-keep">Keep membership</Button>
          {awaitingRecovery ? <Button disabled={!!busy} onClick={() => run("recover")} data-testid="button-cancel-membership-check">
            {busy === "recover" ? "Checking…" : "Check outcome"}
          </Button> : preview && <Button variant="destructive" disabled={!confirmed || !!busy} onClick={() => run("confirm")} data-testid="button-confirm-cancel-membership">
            {busy === "confirm" ? "Cancelling…" : "Cancel membership"}
          </Button>}
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function WithdrawDialog({ memberId, tenantId, record, onClose, onChanged }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  async function submit() {
    if (busy || !reason.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await post(tenantId, memberId, { action: "withdraw_cancellation", id: record.id, reason: reason.trim() });
      if (!result?.record?.withdrawn_at) throw new Error("The withdrawal was not confirmed. Reload and check before trying again.");
      setDone(true);
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent data-testid="dialog-withdraw-cancellation">
      <DialogHeader>
        <DialogTitle>Withdraw scheduled cancellation</DialogTitle>
        <DialogDescription>The membership will continue as normal and will not end on {requestDate(record.effective_date)}.</DialogDescription>
      </DialogHeader>
      {done ? <p role="status" className="text-sm">The scheduled cancellation has been withdrawn.</p> : <div className="space-y-1.5">
        <Label htmlFor="withdraw-cancellation-reason">Reason (required)</Label>
        <Textarea id="withdraw-cancellation-reason" maxLength={2000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} data-testid="input-withdraw-cancellation-reason" />
      </div>}
      {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{error.message}</p>}
      <DialogFooter>
        {done ? <Button onClick={onClose}>Done</Button> : <>
          <Button variant="outline" disabled={busy} onClick={onClose}>Keep cancellation</Button>
          <Button disabled={busy || !reason.trim()} onClick={submit} data-testid="button-confirm-withdraw-cancellation">{busy ? "Withdrawing…" : "Withdraw cancellation"}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
