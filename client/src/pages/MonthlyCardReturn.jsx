import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, CreditCard, RefreshCw, LayoutDashboard, LogIn, AlertCircle } from "lucide-react";
import {
  classifyMembershipReturn,
  membershipLoginPath,
  safeMembershipReturnPath,
} from "@/lib/membershipPaymentReturn";
import { useLayoutContext } from "@/contexts/LayoutContext";

const COPY = {
  active: { title: "Monthly card payment plan active", body: "Your monthly card payment plan is active. This return page does not confirm an individual charge or any remaining instalments." },
  setup_pending: { title: "Your card plan is being confirmed", body: "We are waiting for Stripe to confirm the plan set-up. No payment is confirmed on this page." },
  verification_pending: { title: "Checking your card plan", body: "We have not yet received confirmation of checkout. It may still be processing; no payment is confirmed on this page." },
  payment_pending: { title: "Your first card payment is pending", body: "Your plan is set up, but the first payment is still processing. This return page does not confirm that the charge has completed." },
  payment_attention: { title: "Your card payment needs attention", body: "Your plan is not currently in good standing. Please sign in to review your membership and payment status." },
  cancelled: { title: "Card checkout not completed", body: "We did not find an active monthly card plan for this return. Nothing on this page confirms that a payment was taken." },
  unverified: { title: "We could not verify your card payment status", body: "The Stripe return alone does not confirm a subscription or payment. Please try checking again, or sign in to review your membership." },
};

export default function MonthlyCardReturn({ outcome }) {
  const location = useLocation();
  const { sessionValidated } = useLayoutContext();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const memberId = params.get("member_id");
  const [check, setCheck] = useState({ loading: !!memberId, agreement: null, error: !memberId, accessDenied: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!memberId) return undefined;
    let cancelled = false;
    setCheck({ loading: true, agreement: null, error: false, accessDenied: false });
    fetch(`/api/membership/monthly-card?memberId=${encodeURIComponent(memberId)}`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw Object.assign(new Error("Unable to read agreement"), { accessDenied: res.status === 401 || res.status === 403 });
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setCheck({ loading: false, agreement: json?.agreement || null, error: false, accessDenied: false });
      })
      .catch((error) => {
        if (!cancelled) setCheck({ loading: false, agreement: null, error: true, accessDenied: !!error.accessDenied });
      });
    return () => { cancelled = true; };
  }, [memberId, attempt]);

  const state = classifyMembershipReturn({
    provider: "monthly-card",
    outcome,
    agreement: check.agreement,
    verification: check.loading ? "loading" : (check.error ? "failed" : "verified"),
  });
  const copy = COPY[state] || COPY.unverified;
  const safeReturnPath = safeMembershipReturnPath(params.get("return_to"));
  const loginHref = membershipLoginPath(location.pathname, location.search);
  const canReviewMemberArea = sessionValidated && !!check.agreement && !check.error;
  const needsRecheck = ["setup_pending", "verification_pending", "payment_pending", "unverified"].includes(state);
  const Icon = state === "active" ? CheckCircle2 : state === "loading" ? Loader2 : state === "cancelled" ? XCircle : AlertCircle;
  const recheck = useCallback(() => setAttempt((current) => current + 1), []);

  return (
    <div className="max-w-lg mx-auto px-4 py-16">
      <Card data-testid="card-monthly-card-return">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <Icon className={`h-12 w-12 ${state === "loading" ? "animate-spin text-muted-foreground" : state === "active" ? "text-green-500" : "text-muted-foreground"}`} />
            <div>
              <p className="text-lg font-medium" data-testid="text-monthly-card-return-title">
                {state === "loading" ? "Checking your monthly card plan..." : copy.title}
              </p>
              {state !== "loading" && <p className="text-sm text-muted-foreground mt-2" data-testid="text-monthly-card-return-status">{copy.body}</p>}
              {check.accessDenied && <p className="text-sm text-muted-foreground mt-2">Sign in to verify this membership plan.</p>}
              {check.agreement?.terms && (
                <p className="text-sm text-muted-foreground mt-2" data-testid="text-monthly-card-return-terms">
                  Plan: {check.agreement.terms.instalment_count} monthly payments of{" "}
                  {check.agreement.terms.currency === "GBP" ? "\u00a3" : `${check.agreement.terms.currency} `}
                  {Number(check.agreement.terms.monthly_amount).toFixed(2)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-center">
              {needsRecheck && (
                <Button type="button" variant="outline" onClick={recheck} disabled={check.loading} data-testid="button-monthly-card-return-recheck">
                  <RefreshCw className="mr-2 h-4 w-4" /> Check status again
                </Button>
              )}
              {canReviewMemberArea ? (
                <Button asChild data-testid="button-monthly-card-return-member-area">
                  <Link to="/Dashboard"><LayoutDashboard className="mr-2 h-4 w-4" /> Member area</Link>
                </Button>
              ) : check.accessDenied ? (
                <Button asChild data-testid="button-monthly-card-return-login">
                  <Link to={loginHref}><LogIn className="mr-2 h-4 w-4" /> Sign in</Link>
                </Button>
              ) : null}
              <Button asChild variant="outline" data-testid="button-monthly-card-return-home">
                <Link to={outcome === "cancelled" && safeReturnPath ? safeReturnPath : "/"}>
                  <CreditCard className="mr-2 h-4 w-4" /> Return to site
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}