import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import {
  Landmark, AlertCircle, RefreshCw, Search, ArrowLeft, Loader2,
} from "lucide-react";

const FEATURE_ID = "page_DirectDebitAdmin";

function money(minor, currency) {
  if (minor == null) return "—";
  const symbol = { GBP: "\u00a3", USD: "$", EUR: "\u20ac" }[currency] || `${currency || ""} `;
  return `${symbol}${(minor / 100).toFixed(2)}`;
}
function fmtDate(v, withTime = false) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return withTime
    ? d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_VARIANTS = {
  active: "default",
  pending: "secondary",
  mandate_pending: "secondary",
  payment_grace_period: "warning",
  payment_overdue: "destructive",
  payment_failed: "destructive",
  suspended: "destructive",
  restricted: "warning",
  completed: "secondary",
  cancelled: "outline",
  pending_activation: "warning",
};
function StatusBadge({ status }) {
  if (!status) return null;
  return (
    <Badge variant={STATUS_VARIANTS[status] || "outline"} data-testid={`badge-dd-status-${status}`}>
      {String(status).replace(/_/g, " ")}
    </Badge>
  );
}

const PLAN_STATUS_FILTERS = [
  "all", "pending_activation", "active", "payment_grace_period", "payment_overdue", "suspended",
  "restricted", "mandate_pending", "completed", "cancelled",
];

const RECON_BUCKETS = [
  { key: "all", label: "All payments" },
  { key: "awaiting_confirmation", label: "Awaiting confirmation" },
  { key: "confirmed_not_paid_out", label: "Confirmed, not paid out" },
  { key: "paid_out", label: "Paid out" },
  { key: "failed", label: "Failed" },
  { key: "charged_back", label: "Charged back" },
  { key: "refunded", label: "Refunded" },
  { key: "accounting_failed", label: "Accounting sync failed" },
  { key: "chargeback_after_payout", label: "Chargeback after payout" },
];

async function api(url, opts) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// ---------------------------------------------------------------------------
// Action dialog — one generic confirm/param dialog for all plan actions.

const ACTIONS = {
  manual_activate: { label: "Activate membership", destructive: false, desc: "Approves this membership and grants access. This is available only when the tier requires manual activation and the membership is still awaiting approval." },
  retry: { label: "Retry failed payment", destructive: false, desc: "GoCardless is asked to re-collect the failed payment. The retry only happens if GoCardless confirms the payment is in a failed state — it can never double-charge." },
  refund: { label: "Issue refund", destructive: true, desc: "Refunds part or all of a collected payment back to the payer's bank account. This cannot be undone.", fields: ["amount", "reason"] },
  cancel_subscription: { label: "Cancel subscription", destructive: true, desc: "Stops all future collections on this plan. The bank mandate stays in place, so a new plan can be started without the payer re-authorising.", fields: ["reason"] },
  pause_subscription: { label: "Pause subscription", destructive: false, desc: "Temporarily pauses collections at GoCardless. The mandate and plan stay in place; use Resume to restart charging.", fields: ["reason"] },
  resume_subscription: { label: "Resume subscription", destructive: false, desc: "Restarts collections on a paused subscription." },
  reconcile: { label: "Reconcile payment", destructive: false, desc: "Refreshes this payment's status from GoCardless and re-runs the accounting posting if it previously failed." },
  cancel_mandate: { label: "Cancel mandate", destructive: true, desc: "Cancels the Direct Debit authorisation itself at the payer's bank. Nothing further can ever be collected until the payer sets up a new mandate.", fields: ["reason"] },
  extend_grace: { label: "Extend grace period", destructive: false, desc: "Gives the payer more time before the arrears policy is applied.", fields: ["days"] },
  manual_resolve: { label: "Mark resolved manually", destructive: false, desc: "Use when the payment was settled outside GoCardless (e.g. bank transfer) or you're writing it off. The plan returns to active and arrears flags are cleared.", fields: ["note"] },
  remind: { label: "Send reminder email", destructive: false, desc: "Re-sends the payment-failed/overdue email to the billing contact." },
  new_mandate_link: { label: "Send new mandate link", destructive: false, desc: "Emails the billing contact a fresh secure link to authorise a replacement Direct Debit mandate. The current plan is untouched until the new mandate is active." },
  note: { label: "Add note", destructive: false, desc: "Adds a note to this plan's audit trail.", fields: ["note"] },
};

function ActionDialog({ action, plan, payment, open, onClose, onDone }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("7");
  const [note, setNote] = useState("");
  const meta = ACTIONS[action] || {};

  useEffect(() => {
    if (open) {
      setAmount(payment ? ((payment.amount_minor - (payment.amount_refunded_minor || 0)) / 100).toFixed(2) : "");
      setReason(""); setDays("7"); setNote("");
    }
  }, [open, payment]);

  const run = async () => {
    setBusy(true);
    try {
      const body = { action, planId: plan.id };
      if ((action === "retry" || action === "reconcile") && payment) body.paymentId = payment.gocardless_payment_id;
      if (action === "refund") {
        body.paymentId = payment?.gocardless_payment_id;
        body.amountMinor = Math.round(parseFloat(amount) * 100);
        body.reason = reason || undefined;
      }
      if (meta.fields?.includes("reason") && action !== "refund") body.reason = reason || undefined;
      if (action === "extend_grace") body.days = parseInt(days, 10);
      if (meta.fields?.includes("note")) body.note = note;
      const result = await api("/api/admin/gocardless-dd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast({ title: meta.label, description: "Done." });
      onDone?.(result);
      onClose();
    } catch (err) {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const refundInvalid = action === "refund" && (!(parseFloat(amount) > 0) || !payment);
  const noteInvalid = action === "note" && !note.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-dd-action">
        <DialogHeader>
          <DialogTitle>{meta.label}</DialogTitle>
          <DialogDescription>{meta.desc}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {action === "refund" && payment && (
            <p className="text-sm text-muted-foreground" data-testid="text-refund-payment">
              Payment {payment.gocardless_payment_id} — collected {money(payment.amount_minor, payment.currency)}
              {payment.amount_refunded_minor ? `, already refunded ${money(payment.amount_refunded_minor, payment.currency)}` : ""}
            </p>
          )}
          {meta.fields?.includes("amount") && (
            <div className="space-y-1">
              <Label htmlFor="dd-refund-amount">Refund amount</Label>
              <Input id="dd-refund-amount" type="number" min="0.01" step="0.01" value={amount}
                onChange={(e) => setAmount(e.target.value)} data-testid="input-refund-amount" />
            </div>
          )}
          {meta.fields?.includes("days") && (
            <div className="space-y-1">
              <Label htmlFor="dd-grace-days">Extra days (1–90)</Label>
              <Input id="dd-grace-days" type="number" min="1" max="90" value={days}
                onChange={(e) => setDays(e.target.value)} data-testid="input-grace-days" />
            </div>
          )}
          {meta.fields?.includes("reason") && (
            <div className="space-y-1">
              <Label htmlFor="dd-action-reason">Reason (optional)</Label>
              <Input id="dd-action-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-action-reason" />
            </div>
          )}
          {meta.fields?.includes("note") && (
            <div className="space-y-1">
              <Label htmlFor="dd-action-note">Note</Label>
              <Textarea id="dd-action-note" value={note} onChange={(e) => setNote(e.target.value)} data-testid="input-action-note" />
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy} data-testid="button-action-cancel">Cancel</Button>
          <Button variant={meta.destructive ? "destructive" : "default"} onClick={run}
            disabled={busy || refundInvalid || noteInvalid} data-testid="button-action-confirm">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {meta.destructive ? `Confirm — ${meta.label}` : meta.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Plan detail

function PlanDetail({ planId, onBack }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/gocardless-dd", "plan", planId],
    queryFn: () => api(`/api/admin/gocardless-dd?view=plan&planId=${planId}`),
  });
  const [dialog, setDialog] = useState(null); // { action, payment }
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/gocardless-dd"] });
  };

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const {
    plan, agreement, payments = [], statusHistory = [], adminActions = [],
    cancellationRequests = [], refunds = [], retryAttempts = [], membershipActivation,
  } = data || {};
  if (!plan) return <Alert variant="destructive"><AlertDescription>Plan not found.</AlertDescription></Alert>;
  const dd = agreement?.metadata?.dd;
  const inArrears = ["payment_grace_period", "payment_overdue"].includes(plan.status);

  const actionButtons = [
    membershipActivation?.status === "pending_activation" && "manual_activate",
    inArrears && "retry",
    inArrears && "remind",
    inArrears && "extend_grace",
    inArrears && "manual_resolve",
    "new_mandate_link",
    plan.gocardless_subscription_id && !["cancelled", "completed"].includes(plan.status) && "pause_subscription",
    plan.gocardless_subscription_id && !["cancelled", "completed"].includes(plan.status) && "resume_subscription",
    !["cancelled", "completed"].includes(plan.status) && "cancel_subscription",
    "cancel_mandate",
    "note",
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-to-plans"><ArrowLeft /></Button>
        <h2 className="text-lg font-semibold">Plan detail</h2>
        <StatusBadge status={plan.status} />
      </div>

      {membershipActivation?.status === "pending_activation" && (
        <Alert data-testid="alert-pending-membership-activation">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            This membership is awaiting manual activation. Review the plan, then use Activate membership to grant access.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="pt-6 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm">
          <span className="text-muted-foreground">Monthly amount</span>
          <span data-testid="text-plan-amount">{money(plan.amount_minor, plan.currency)}</span>
          <span className="text-muted-foreground">Next collection</span>
          <span data-testid="text-plan-next">{fmtDate(plan.next_charge_date)}</span>
          <span className="text-muted-foreground">Grace expires</span>
          <span data-testid="text-plan-grace">{fmtDate(plan.grace_expires_at, true)}</span>
          <span className="text-muted-foreground">Retry count</span>
          <span data-testid="text-plan-retries">{plan.retry_count || 0}</span>
          <span className="text-muted-foreground">Automatic retries</span>
          <span data-testid="text-plan-auto-retries">{plan.auto_retry_attempts || 0}</span>
          <span className="text-muted-foreground">Next automatic retry</span>
          <span data-testid="text-plan-auto-retry-next">{fmtDate(plan.auto_retry_next_at, true)}</span>
          <span className="text-muted-foreground">Automatic retry outcome</span>
          <span data-testid="text-plan-auto-retry-outcome">
            {plan.auto_retry_last_outcome || "—"}
            {plan.auto_retry_last_error ? ` — ${plan.auto_retry_last_error}` : ""}
          </span>
          <span className="text-muted-foreground">Arrears policy applied</span>
          <span data-testid="text-plan-policy">{plan.arrears_policy_applied || "—"}</span>
          <span className="text-muted-foreground">Subscription</span>
          <span className="truncate" data-testid="text-plan-sub">{plan.gocardless_subscription_id || "—"}</span>
          <span className="text-muted-foreground">Grace days (contract)</span>
          <span data-testid="text-plan-grace-days">{dd?.grace_days ?? "—"}</span>
          <span className="text-muted-foreground">Membership year</span>
          <span data-testid="text-plan-year">{dd?.membership_year || "—"}</span>
          <span className="text-muted-foreground">Activation rule</span>
          <span data-testid="text-plan-activation-rule">{String(dd?.activation_rule || "—").replace(/_/g, " ")}</span>
          <span className="text-muted-foreground">Membership status</span>
          <span data-testid="text-membership-activation-status">
            {String(membershipActivation?.status || "—").replace(/_/g, " ")}
          </span>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {actionButtons.map((a) => (
          <Button key={a} size="sm" variant={ACTIONS[a].destructive ? "destructive" : "outline"}
            onClick={() => setDialog({ action: a, payment: a === "retry" ? payments.find((p) => p.status === "failed") : null })}
            data-testid={`button-plan-${a}`}>
            {ACTIONS[a].label}
          </Button>
        ))}
      </div>

      <Tabs defaultValue="payments">
        <TabsList>
          <TabsTrigger value="payments" data-testid="tab-payments">Payments ({payments.length})</TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">Status history ({statusHistory.length})</TabsTrigger>
          <TabsTrigger value="actions" data-testid="tab-actions">Admin log ({adminActions.length})</TabsTrigger>
          <TabsTrigger value="retries" data-testid="tab-retry-attempts">Retry attempts ({retryAttempts.length})</TabsTrigger>
          <TabsTrigger value="cancellations" data-testid="tab-cancellations">Cancellation requests ({cancellationRequests.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="payments" className="space-y-2">
          {payments.length === 0 && <p className="text-sm text-muted-foreground py-4">No payments yet.</p>}
          {payments.map((p) => {
            const refundable = ["confirmed", "paid_out"].includes(p.status) && (p.amount_refunded_minor || 0) < p.amount_minor;
            return (
              <Card key={p.id} data-testid={`card-payment-${p.id}`}>
                <CardContent className="py-3 flex items-center justify-between gap-2 flex-wrap text-sm">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{money(p.amount_minor, p.currency)}</span>
                      <StatusBadge status={p.status} />
                      {p.refund_status && <Badge variant="secondary">refund: {p.refund_status}</Badge>}
                      {p.chargeback_reversed_after_payout && <Badge variant="destructive">chargeback after payout</Badge>}
                      {p.accounting_sync_status === "failed" && <Badge variant="destructive">accounting failed</Badge>}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {p.gocardless_payment_id} · charge {fmtDate(p.charge_date)}
                      {p.fee_minor != null && ` · fee ${money(p.fee_minor, p.currency)}`}
                      {p.net_minor != null && ` · net ${money(p.net_minor, p.currency)}`}
                      {p.paid_out_at && ` · paid out ${fmtDate(p.paid_out_at)}`}
                      {p.amount_refunded_minor ? ` · refunded ${money(p.amount_refunded_minor, p.currency)}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {p.status === "failed" && (
                      <Button size="sm" variant="outline" onClick={() => setDialog({ action: "retry", payment: p })} data-testid={`button-retry-${p.id}`}>Retry</Button>
                    )}
                    {refundable && (
                      <Button size="sm" variant="outline" onClick={() => setDialog({ action: "refund", payment: p })} data-testid={`button-refund-${p.id}`}>Refund</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ action: "reconcile", payment: p })} data-testid={`button-reconcile-${p.id}`}>Reconcile</Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {refunds.length > 0 && (
            <div className="pt-2">
              <h4 className="text-sm font-medium mb-1">Refunds</h4>
              {refunds.map((r) => (
                <p key={r.id} className="text-xs text-muted-foreground" data-testid={`text-refund-${r.id}`}>
                  {fmtDate(r.created_at, true)} — {money(r.amount_minor, r.currency)} on {r.gocardless_payment_id} ({r.status}){r.reason ? ` — ${r.reason}` : ""} {r.initiated_by ? `by ${r.initiated_by}` : ""}
                </p>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-1">
          {statusHistory.length === 0 && <p className="text-sm text-muted-foreground py-4">No status changes recorded.</p>}
          {statusHistory.map((h) => (
            <p key={h.id} className="text-sm" data-testid={`text-history-${h.id}`}>
              <span className="text-muted-foreground">{fmtDate(h.created_at, true)}</span>{" — "}
              {h.from_status || "?"} → <span className="font-medium">{h.to_status}</span>
              {h.source ? ` (${h.source})` : ""}{h.reason ? ` — ${h.reason}` : ""}
            </p>
          ))}
        </TabsContent>

        <TabsContent value="actions" className="space-y-1">
          {adminActions.length === 0 && <p className="text-sm text-muted-foreground py-4">No admin actions yet.</p>}
          {adminActions.map((a) => (
            <p key={a.id} className="text-sm" data-testid={`text-action-${a.id}`}>
              <span className="text-muted-foreground">{fmtDate(a.created_at, true)}</span>{" — "}
              <span className="font-medium">{String(a.action).replace(/_/g, " ")}</span> by {a.actor_email}
              {a.details?.note ? ` — ${a.details.note}` : ""}
              {a.details?.reason ? ` — ${a.details.reason}` : ""}
              {a.details?.amountMinor ? ` — ${money(a.details.amountMinor, plan.currency)}` : ""}
              {a.details?.days ? ` — +${a.details.days} days` : ""}
            </p>
          ))}
        </TabsContent>

        <TabsContent value="retries" className="space-y-2">
          {retryAttempts.length === 0 && <p className="text-sm text-muted-foreground py-4">No retry attempts recorded.</p>}
          {retryAttempts.map((attempt) => (
            <Card key={attempt.id} data-testid={`card-retry-attempt-${attempt.id}`}>
              <CardContent className="py-3 text-sm space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge status={attempt.status} />
                  <Badge variant="secondary">{attempt.mode}</Badge>
                  <span>attempt {attempt.attempt_number}</span>
                  <span className="text-muted-foreground text-xs">{fmtDate(attempt.created_at, true)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {attempt.gocardless_payment_id}
                  {attempt.provider_status ? ` · provider ${attempt.provider_status}` : ""}
                  {attempt.outcome ? ` · ${String(attempt.outcome).replace(/_/g, " ")}` : ""}
                  {attempt.error_message ? ` · ${attempt.error_message}` : ""}
                </p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="cancellations" className="space-y-2">
          {cancellationRequests.length === 0 && <p className="text-sm text-muted-foreground py-4">No cancellation requests for this plan.</p>}
          {cancellationRequests.map((r) => (
            <Card key={r.id}>
              <CardContent className="py-3 text-sm space-y-1" data-testid={`card-cancel-req-${r.id}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge status={r.status} />
                  <span className="text-muted-foreground text-xs">{fmtDate(r.created_at, true)}</span>
                </div>
                {r.reason && <p>{r.reason}</p>}
                {r.decided_by && <p className="text-xs text-muted-foreground">Decided by {r.decided_by} {fmtDate(r.decided_at, true)}{r.decision_notes ? ` — ${r.decision_notes}` : ""}</p>}
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      {dialog && (
        <ActionDialog action={dialog.action} plan={plan} payment={dialog.payment}
          open onClose={() => setDialog(null)} onDone={refresh} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancellation requests tab (tenant-wide)

function CancellationRequests() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("pending");
  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/dd-cancellation-requests", status],
    queryFn: () => api(`/api/admin/dd-cancellation-requests?status=${status}`),
  });
  const [decideReq, setDecideReq] = useState(null);
  const [decision, setDecision] = useState("approve");
  const [cancelScope, setCancelScope] = useState("subscription");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/admin/dd-cancellation-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: decideReq.id, decision, cancelScope: decision === "approve" ? cancelScope : "none", notes: notes || undefined }),
      });
      toast({ title: "Decision recorded" });
      setDecideReq(null); setNotes("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/dd-cancellation-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/gocardless-dd"] });
    } catch (err) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const requests = data?.requests || [];
  return (
    <div className="space-y-3">
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-48" data-testid="select-cancel-status"><SelectValue /></SelectTrigger>
        <SelectContent>
          {["pending", "approved", "rejected", "withdrawn"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        </SelectContent>
      </Select>
      {isLoading ? <Skeleton className="h-32 w-full" /> : requests.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4" data-testid="text-no-requests">No {status} cancellation requests.</p>
      ) : requests.map((r) => (
        <Card key={r.id} data-testid={`card-request-${r.id}`}>
          <CardContent className="py-3 flex items-center justify-between gap-2 flex-wrap text-sm">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{r.payer_name || r.requested_by || "Unknown payer"}</span>
                <StatusBadge status={r.status} />
                <span className="text-xs text-muted-foreground">{fmtDate(r.created_at, true)}</span>
              </div>
              {r.reason && <p className="text-muted-foreground">{r.reason}</p>}
              {r.effective_preference && <p className="text-xs text-muted-foreground">Preference: {String(r.effective_preference).replace(/_/g, " ")}</p>}
            </div>
            {r.status === "pending" && (
              <Button size="sm" onClick={() => { setDecideReq(r); setDecision("approve"); setCancelScope("subscription"); }} data-testid={`button-review-${r.id}`}>Review</Button>
            )}
          </CardContent>
        </Card>
      ))}

      <Dialog open={!!decideReq} onOpenChange={(o) => !o && setDecideReq(null)}>
        <DialogContent data-testid="dialog-cancel-decision">
          <DialogHeader>
            <DialogTitle>Review cancellation request</DialogTitle>
            <DialogDescription>Approve to stop the Direct Debit, or reject to keep it running. The requester is notified either way.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Decision</Label>
              <Select value={decision} onValueChange={setDecision}>
                <SelectTrigger data-testid="select-decision"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="approve">Approve</SelectItem>
                  <SelectItem value="reject">Reject</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {decision === "approve" && (
              <div className="space-y-1">
                <Label>What should be cancelled?</Label>
                <Select value={cancelScope} onValueChange={setCancelScope}>
                  <SelectTrigger data-testid="select-cancel-scope"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="subscription">Subscription only (mandate kept for future use)</SelectItem>
                    <SelectItem value="mandate">Subscription and mandate (full stop)</SelectItem>
                    <SelectItem value="none">Nothing — record approval only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="decision-notes">Notes (optional)</Label>
              <Textarea id="decision-notes" value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-decision-notes" />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDecideReq(null)} disabled={busy} data-testid="button-decision-cancel">Cancel</Button>
            <Button variant={decision === "approve" ? "destructive" : "default"} onClick={submit} disabled={busy} data-testid="button-decision-confirm">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {decision === "approve" ? "Confirm approval" : "Reject request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reconciliation tab

function Reconciliation() {
  const [bucket, setBucket] = useState("all");
  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/gocardless-dd", "reconciliation", bucket],
    queryFn: () => api(`/api/admin/gocardless-dd?view=reconciliation&bucket=${bucket}`),
  });
  const payments = data?.payments || [];
  const payouts = data?.payouts || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={bucket} onValueChange={setBucket}>
          <SelectTrigger className="w-64" data-testid="select-recon-bucket"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RECON_BUCKETS.map((b) => <SelectItem key={b.key} value={b.key}>{b.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" asChild data-testid="button-recon-export">
          <a href={`/api/admin/gocardless-dd?view=export&bucket=${bucket}`} download>Export CSV</a>
        </Button>
      </div>
      {isLoading ? <Skeleton className="h-32 w-full" /> : (
        <>
          <div className="space-y-1">
            {payments.length === 0 && <p className="text-sm text-muted-foreground py-4">No payments in this bucket.</p>}
            {payments.map((p) => (
              <p key={p.id} className="text-sm" data-testid={`text-recon-${p.id}`}>
                <span className="font-medium">{money(p.amount_minor, p.currency)}</span>{" "}
                <StatusBadge status={p.status} />{" "}
                <span className="text-muted-foreground text-xs">
                  {p.gocardless_payment_id} · charge {fmtDate(p.charge_date)}
                  {p.fee_minor != null && ` · fee ${money(p.fee_minor, p.currency)}`}
                  {p.net_minor != null && ` · net ${money(p.net_minor, p.currency)}`}
                  {p.gocardless_payout_id && ` · payout ${p.gocardless_payout_id}`}
                  {p.amount_refunded_minor ? ` · refunded ${money(p.amount_refunded_minor, p.currency)}` : ""}
                </span>
              </p>
            ))}
          </div>
          {payouts.length > 0 && (
            <div className="pt-2">
              <h4 className="text-sm font-medium mb-1">Recent payouts</h4>
              {payouts.map((po) => (
                <p key={po.id} className="text-xs text-muted-foreground" data-testid={`text-payout-${po.id}`}>
                  {po.gocardless_payout_id} — {money(po.amount_minor, po.currency)} arriving {fmtDate(po.arrival_date)} ({po.status})
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 5 — Migration funnel tab

const STAGE_VARIANTS = {
  invited: "secondary",
  accepted: "default",
  mandate_active: "default",
  subscription_active: "default",
  declined: "outline",
  expired: "outline",
  revoked: "outline",
  superseded: "outline",
  failed: "destructive",
};

function MigrationTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/gocardless-dd", "migration"],
    queryFn: () => api("/api/admin/gocardless-dd?view=migration"),
  });

  const post = async (body, okMsg) => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/gocardless-dd", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      toast({ title: okMsg });
      if (json.emailSent === false) {
        toast({ title: "Invitation saved but the email could not be sent", description: json.emailError || "", variant: "destructive" });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/gocardless-dd", "migration"] });
      return true;
    } catch (err) {
      toast({ title: err.message, variant: "destructive" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const counts = data?.counts || {};
  const invites = data?.invites || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["invited", "Invited"],
          ["accepted", "Accepted (set-up started)"],
          ["mandate_active", "Mandate active"],
          ["subscription_active", "Subscription active"],
        ].map(([key, label]) => (
          <Card key={key}><CardContent className="pt-4">
            <p className="text-2xl font-semibold" data-testid={`stat-migration-${key}`}>{counts[key] || 0}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </CardContent></Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="text-migration-dropoff">
        Declined {counts.declined || 0} · Expired {counts.expired || 0} · Revoked {counts.revoked || 0} · Failed {counts.failed || 0}
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">Invite a member to switch to Direct Debit</CardTitle></CardHeader>
        <CardContent className="flex gap-2 flex-wrap items-end">
          <div className="space-y-1">
            <Label htmlFor="migration-member-id">Member ID</Label>
            <Input id="migration-member-id" className="w-80" placeholder="Member UUID" value={memberId}
              onChange={(e) => setMemberId(e.target.value)} data-testid="input-migration-member-id" />
          </div>
          <Button
            disabled={busy || !memberId.trim()}
            onClick={async () => {
              const ok = await post({ action: "migration_invite", memberId: memberId.trim() }, "Invitation sent");
              if (ok) setMemberId("");
            }}
            data-testid="button-migration-invite"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send invitation"}
          </Button>
          <p className="text-xs text-muted-foreground w-full">
            The member's tier must have Direct Debit and migration enabled. The switch applies from the next membership year — their current payment is never affected.
          </p>
        </CardContent>
      </Card>

      {isLoading ? <Skeleton className="h-40 w-full" /> : invites.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6" data-testid="text-no-invites">No migration invitations yet.</p>
      ) : invites.map((inv) => (
        <Card key={inv.id} data-testid={`card-invite-${inv.id}`}>
          <CardContent className="py-3 flex items-center justify-between gap-2 flex-wrap text-sm">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium" data-testid={`text-invite-member-${inv.id}`}>{inv.memberName || inv.invited_email || "Unknown member"}</span>
                <Badge variant={STAGE_VARIANTS[inv.stage] || "outline"} data-testid={`badge-invite-stage-${inv.id}`}>
                  {String(inv.stage || "").replace(/_/g, " ")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Switch from {inv.switch_from_year} · invited {fmtDate(inv.created_at)}
                {inv.expires_at ? ` · expires ${fmtDate(inv.expires_at)}` : ""}
                {inv.memberEmail ? ` · ${inv.memberEmail}` : ""}
              </p>
            </div>
            {inv.status === "invited" && (
              <Button variant="outline" size="sm" disabled={busy}
                onClick={() => post({ action: "migration_revoke", inviteId: inv.id }, "Invitation revoked")}
                data-testid={`button-revoke-invite-${inv.id}`}>
                Revoke
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// Phase 5 — Renewals tab (membership_dd_renewals ledger)
const RENEWAL_STATUS_VARIANTS = {
  notice_sent: "secondary",
  awaiting_confirmation: "warning",
  confirmed: "default",
  auto_renewed: "default",
  completed: "default",
  skipped: "outline",
  failed: "destructive",
};

function RenewalsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/admin/gocardless-dd", "renewals"],
    queryFn: () => api("/api/admin/gocardless-dd?view=renewals"),
  });
  const renewals = data?.renewals || [];
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (renewals.length === 0) {
    return <p className="text-sm text-muted-foreground py-6" data-testid="text-no-renewals">No plan renewals recorded yet.</p>;
  }
  return (
    <div className="space-y-2">
      {renewals.map((r) => (
        <Card key={r.id} data-testid={`card-renewal-${r.id}`}>
          <CardContent className="py-3 flex items-center justify-between gap-2 flex-wrap text-sm">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium" data-testid={`text-renewal-member-${r.id}`}>{r.memberName || "Unknown member"}</span>
                <Badge variant={RENEWAL_STATUS_VARIANTS[r.status] || "outline"} data-testid={`badge-renewal-status-${r.id}`}>
                  {String(r.status || "").replace(/_/g, " ")}
                </Badge>
                <Badge variant="outline" data-testid={`badge-renewal-provider-${r.id}`}>
                  {r.provider === "stripe" ? "Card" : "Direct Debit"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {r.renewal_year} · {r.renewal_mode === "auto" ? "automatic" : "confirmation required"}
                {r.notice_sent_at ? ` · notice ${fmtDate(r.notice_sent_at)}` : ""}
                {r.confirmed_at ? ` · confirmed ${fmtDate(r.confirmed_at)}` : ""}
                {r.memberEmail ? ` · ${r.memberEmail}` : ""}
              </p>
              {r.failure_reason && <p className="text-xs text-destructive" data-testid={`text-renewal-failure-${r.id}`}>{r.failure_reason}</p>}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page

export default function DirectDebitAdmin() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedPlan, setSelectedPlan] = useState(null);
  const queryClient = useQueryClient();

  const blocked = isAccessReady && isFeatureExcluded(FEATURE_ID);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["/api/admin/gocardless-dd", "summary"],
    queryFn: () => api("/api/admin/gocardless-dd?view=summary"),
    enabled: !blocked,
  });

  const plansUrl = `/api/admin/gocardless-dd?view=plans${statusFilter !== "all" ? `&status=${statusFilter}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
  const { data: plansData, isLoading: plansLoading } = useQuery({
    queryKey: ["/api/admin/gocardless-dd", "plans", statusFilter, search],
    queryFn: () => api(plansUrl),
    enabled: !blocked,
  });

  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/gocardless-dd"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/dd-cancellation-requests"] });
  }, [queryClient]);

  if (isAccessReady && blocked) {
    return (
      <div className="p-6">
        <Alert variant="destructive" data-testid="alert-no-access">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>You don't have access to the Direct Debit console.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const plans = plansData?.plans || [];
  const byStatus = summary?.byStatus || {};

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
          <Landmark className="h-6 w-6" /> Direct Debit Console
        </h1>
        <Button variant="outline" size="sm" onClick={refreshAll} data-testid="button-refresh">
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {selectedPlan ? (
        <PlanDetail planId={selectedPlan} onBack={() => setSelectedPlan(null)} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {summaryLoading ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />) : (
              <>
                <Card><CardContent className="pt-4">
                  <p className="text-2xl font-semibold" data-testid="stat-active">{byStatus.active || 0}</p>
                  <p className="text-xs text-muted-foreground">Active plans</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4">
                  <p className="text-2xl font-semibold" data-testid="stat-arrears">{(byStatus.payment_grace_period || 0) + (byStatus.payment_overdue || 0)}</p>
                  <p className="text-xs text-muted-foreground">In arrears</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4">
                  <p className="text-2xl font-semibold" data-testid="stat-pending-activations">{summary?.pendingActivations || 0}</p>
                  <p className="text-xs text-muted-foreground">Awaiting activation</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4">
                  <p className="text-2xl font-semibold" data-testid="stat-cancellations">{summary?.pendingCancellations || 0}</p>
                  <p className="text-xs text-muted-foreground">Pending cancellations</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4">
                  <p className="text-2xl font-semibold" data-testid="stat-accounting">{summary?.failedAccounting || 0}</p>
                  <p className="text-xs text-muted-foreground">Accounting failures</p>
                </CardContent></Card>
                <Card><CardContent className="pt-4">
                  <p className="text-2xl font-semibold" data-testid="stat-chargebacks">{summary?.chargebacksAfterPayout || 0}</p>
                  <p className="text-xs text-muted-foreground">Chargebacks after payout</p>
                </CardContent></Card>
              </>
            )}
          </div>

          <Tabs defaultValue="plans">
            <TabsList>
              <TabsTrigger value="plans" data-testid="tab-plans">Plans</TabsTrigger>
              <TabsTrigger value="requests" data-testid="tab-requests">Cancellation requests{summary?.pendingCancellations ? ` (${summary.pendingCancellations})` : ""}</TabsTrigger>
              <TabsTrigger value="reconciliation" data-testid="tab-reconciliation">Payments & payouts</TabsTrigger>
              <TabsTrigger value="renewals" data-testid="tab-renewals">Renewals</TabsTrigger>
              <TabsTrigger value="migration" data-testid="tab-migration">Migration</TabsTrigger>
            </TabsList>

            <TabsContent value="plans" className="space-y-3">
              <div className="flex gap-2 flex-wrap">
                <div className="relative">
                  <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-8 w-64" placeholder="Search payer or subscription..." value={search}
                    onChange={(e) => setSearch(e.target.value)} data-testid="input-plan-search" />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-56" data-testid="select-plan-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PLAN_STATUS_FILTERS.map((s) => (
                      <SelectItem key={s} value={s}>{s === "all" ? "All statuses" : s.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {plansLoading ? <Skeleton className="h-40 w-full" /> : plans.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6" data-testid="text-no-plans">No Direct Debit plans match.</p>
              ) : plans.map((p) => (
                <Card key={p.id} className="hover-elevate cursor-pointer" onClick={() => setSelectedPlan(p.id)} data-testid={`card-plan-${p.id}`}>
                  <CardContent className="py-3 flex items-center justify-between gap-2 flex-wrap text-sm">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{p.payer_name || "Unknown payer"}</span>
                        <StatusBadge status={p.status} />
                        {p.activation_pending && <StatusBadge status="pending_activation" />}
                        {p.arrears_policy_applied && <Badge variant="warning">{String(p.arrears_policy_applied).replace(/_/g, " ")}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {money(p.amount_minor, p.currency)}/mo · next {fmtDate(p.next_charge_date)}
                        {p.grace_expires_at && ` · grace expires ${fmtDate(p.grace_expires_at, true)}`}
                        {p.retry_count ? ` · ${p.retry_count} retries` : ""}
                        {p.payer_email ? ` · ${p.payer_email}` : ""}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>

            <TabsContent value="requests"><CancellationRequests /></TabsContent>
            <TabsContent value="reconciliation"><Reconciliation /></TabsContent>
            <TabsContent value="renewals"><RenewalsTab /></TabsContent>
            <TabsContent value="migration"><MigrationTab /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
