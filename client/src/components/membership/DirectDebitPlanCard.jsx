import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!memberId) { setLoading(false); return; }
    let cancelled = false;
    fetch(`/api/membership/payment-plan?memberId=${encodeURIComponent(memberId)}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!cancelled) setData(json); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [memberId]);

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

  return (
    <Card data-testid="card-dd-plan">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Landmark className="h-4 w-4" />
          Monthly Direct Debit
          {planStatusBadge(plan.status)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md border border-destructive/20" data-testid="alert-dd-payment-failed">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">
              Your most recent Direct Debit payment failed. It will be retried automatically; please make sure funds are available, or contact your administrator.
            </p>
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
              Plan total: {fmt(plan.terms.plan_total, plan.currency)} over {total} months. Payments are collected by Direct Debit via GoCardless.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
