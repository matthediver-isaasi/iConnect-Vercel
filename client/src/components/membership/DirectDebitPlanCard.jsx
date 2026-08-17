import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Landmark, AlertCircle } from "lucide-react";

const CURRENCY_SYMBOLS = { GBP: "\u00a3", USD: "$", EUR: "\u20ac", AUD: "A$", NZD: "NZ$" };

function fmt(amount, currency) {
  if (amount == null) return "-";
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency || ""} `;
  return `${symbol}${parseFloat(amount).toFixed(2)}`;
}

function fmtDate(d) {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return d;
  }
}

const PLAN_STATUS_VARIANTS = {
  active: "default",
  pending: "secondary",
  completed: "secondary",
  paused: "warning",
  payment_failed: "destructive",
  cancelled: "outline",
};

export function planStatusBadge(status) {
  const s = status || "pending";
  return (
    <Badge variant={PLAN_STATUS_VARIANTS[s] || "outline"} data-testid={`badge-dd-plan-${s}`}>
      {s.replace(/_/g, " ")}
    </Badge>
  );
}

// Member-facing view of a monthly Direct Debit payment plan.
// Fed by GET /api/membership/payment-plan?memberId=... — never shows bank details.
export default function DirectDebitPlanCard({ memberId }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [selfState, setSelfState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  const loadSelfState = useCallback(() => {
    if (!memberId) return;
    fetch(`/api/membership/dd-self-service?memberId=${encodeURIComponent(memberId)}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setSelfState(json))
      .catch(() => {});
  }, [memberId]);

  useEffect(() => {
    if (!memberId) { setLoading(false); return; }
    let cancelled = false;
    fetch(`/api/membership/payment-plan?memberId=${encodeURIComponent(memberId)}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!cancelled) setData(json); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    loadSelfState();
    return () => { cancelled = true; };
  }, [memberId, loadSelfState]);

  const selfServiceAction = async (body, onOk) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/membership/dd-self-service?memberId=${encodeURIComponent(memberId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Something went wrong");
      onOk?.(json);
      loadSelfState();
    } catch (err) {
      toast({ title: "Request failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleResolvePayment = () =>
    selfServiceAction({ action: "resolve-payment" }, (json) => {
      if (json.mode === "new_mandate" && json.authorisationUrl) {
        window.location.href = json.authorisationUrl;
        return;
      }
      toast({ title: "Payment retry scheduled", description: "Your bank will be asked to collect the payment again. Please make sure funds are available." });
    });

  const handleRequestCancellation = () =>
    selfServiceAction({ action: "request-cancellation", reason: cancelReason || undefined }, () => {
      setCancelOpen(false);
      setCancelReason("");
      toast({ title: "Cancellation requested", description: "Your request has been sent for review. Payments continue until it's approved." });
    });

  const handleWithdraw = () =>
    selfServiceAction({ action: "withdraw-cancellation" }, () => {
      toast({ title: "Request withdrawn" });
    });

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2" data-testid="loading-dd-plan">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading payment plan...
      </div>
    );
  }

  const plan = data?.currentPlan;
  if (!plan) return null;

  const paymentsMade = data?.paymentsMade ?? 0;
  const total = plan.instalmentsTotal || plan.terms?.instalment_count || 12;
  const remaining = Math.max(total - paymentsMade, 0);
  const failed = plan.status === "payment_failed" || plan.lastPaymentStatus === "failed";
  const isCardPlan = plan.provider === "stripe";

  return (
    <Card data-testid="card-dd-plan">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Landmark className="h-4 w-4" />
          {isCardPlan ? "Monthly Card Plan" : "Monthly Direct Debit"}
          {planStatusBadge(plan.status)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {(failed || selfState?.plan?.in_arrears) && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20" data-testid="alert-dd-payment-failed">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-2 flex-1">
              <p className="text-sm text-destructive">
                {isCardPlan ? "Your most recent card payment failed." : "Your most recent Direct Debit payment failed."}
                {selfState?.plan?.grace_expires_at
                  ? ` Please fix this by ${fmtDate(selfState.plan.grace_expires_at)} to keep your membership in good standing.`
                  : " Please make sure funds are available, or contact your administrator."}
              </p>
              {selfState?.plan?.in_arrears && (
                <Button size="sm" variant="destructive" onClick={handleResolvePayment} disabled={busy} data-testid="button-dd-resolve-payment">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Fix payment
                </Button>
              )}
            </div>
          </div>
        )}
        {selfState?.pendingCancellationRequest && (
          <div className="flex items-start gap-2 p-3 bg-muted rounded-md" data-testid="alert-dd-pending-cancellation">
            <div className="space-y-2 flex-1">
              <p className="text-sm">
                Your cancellation request from {fmtDate(selfState.pendingCancellationRequest.created_at)} is awaiting review. Payments continue until it's approved.
              </p>
              <Button size="sm" variant="outline" onClick={handleWithdraw} disabled={busy} data-testid="button-dd-withdraw-cancellation">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Withdraw request
              </Button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <span className="text-muted-foreground">Monthly amount</span>
          <span className="font-medium text-right" data-testid="text-dd-monthly-amount">{fmt(plan.monthlyAmount, plan.currency)}</span>

          <span className="text-muted-foreground">Payments made</span>
          <span className="font-medium text-right" data-testid="text-dd-payments-made">{paymentsMade} of {total}</span>

          <span className="text-muted-foreground">Remaining</span>
          <span className="font-medium text-right" data-testid="text-dd-payments-remaining">{remaining}</span>

          <span className="text-muted-foreground">Next collection</span>
          <span className="font-medium text-right" data-testid="text-dd-next-collection">{fmtDate(plan.nextChargeDate)}</span>

          {plan.membershipYear && (
            <>
              <span className="text-muted-foreground">Membership year</span>
              <span className="font-medium text-right" data-testid="text-dd-membership-year">{plan.membershipYear}</span>
            </>
          )}

          {plan.agreementStatus && (
            <>
              <span className="text-muted-foreground">Agreement status</span>
              <span className="font-medium text-right capitalize" data-testid="text-dd-agreement-status">{String(plan.agreementStatus).replace(/_/g, " ")}</span>
            </>
          )}

          {plan.lastPaymentAt && (
            <>
              <span className="text-muted-foreground">Last payment</span>
              <span className="font-medium text-right" data-testid="text-dd-last-payment">
                {fmtDate(plan.lastPaymentAt)}{plan.lastPaymentStatus ? ` (${String(plan.lastPaymentStatus).replace(/_/g, " ")})` : ""}
              </span>
            </>
          )}
        </div>
        {plan.terms?.plan_total != null && (
          <>
            <Separator />
            <p className="text-xs text-muted-foreground" data-testid="text-dd-plan-total">
              Plan total: {fmt(plan.terms.plan_total, plan.currency)} over {total} months. {isCardPlan ? "Payments are collected automatically from your card via Stripe." : "Payments are collected by Direct Debit via GoCardless."}
            </p>
          </>
        )}
        {selfState?.plan && !selfState.pendingCancellationRequest &&
          !["cancelled", "completed"].includes(selfState.plan.status) && (
          <>
            <Separator />
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setCancelOpen(true)} data-testid="button-dd-request-cancellation">
              Request cancellation
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent data-testid="dialog-dd-cancel-request">
          <DialogHeader>
            <DialogTitle>Request Direct Debit cancellation</DialogTitle>
            <DialogDescription>
              Your request will be reviewed by an administrator. Payments continue as normal until it's approved.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="dd-cancel-reason">Reason (optional)</Label>
            <Textarea id="dd-cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} data-testid="input-dd-cancel-reason" />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={busy} data-testid="button-dd-cancel-dialog-close">Keep my plan</Button>
            <Button variant="destructive" onClick={handleRequestCancellation} disabled={busy} data-testid="button-dd-cancel-dialog-confirm">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
