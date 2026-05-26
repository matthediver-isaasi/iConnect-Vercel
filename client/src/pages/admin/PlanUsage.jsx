import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Check } from "lucide-react";

function fmt(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString();
}

function fmtQuota(v) {
  if (v === null || v === undefined) return "Unlimited";
  return Number(v).toLocaleString();
}

function Row({ label, used, limit }) {
  const pct = limit && Number.isFinite(used) ? Math.min(100, Math.round((used / limit) * 100)) : null;
  return (
    <div className="space-y-1" data-testid={`row-usage-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {fmt(used)} {limit !== null && limit !== undefined ? `of ${fmt(limit)}` : "(unlimited)"}
        </span>
      </div>
      {pct !== null && <Progress value={pct} />}
    </div>
  );
}

export default function PlanUsage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [data, setData] = useState(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  const [checkoutError, setCheckoutError] = useState("");

  async function loadData() {
    try {
      const resp = await fetch("/api/admin/plan-usage", { credentials: "include" });
      if (resp.status === 401 || resp.status === 403) { navigate("/admin/login"); return; }
      const json = await resp.json();
      if (!resp.ok) setError(json.error || "Failed to load usage.");
      else setData(json);
    } catch {
      setError("Network error loading usage.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("upgraded") === "1") {
      setInfo("Thanks! Your upgrade is being processed — the new limits will appear here in a moment.");
      window.history.replaceState({}, "", "/admin/plan-usage");
    } else if (params.get("upgrade_cancelled") === "1") {
      setInfo("Upgrade cancelled — you can pick a plan whenever you're ready.");
      window.history.replaceState({}, "", "/admin/plan-usage");
    }
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  async function startCheckout(planCode) {
    setCheckoutError("");
    setCheckoutLoading(planCode);
    try {
      const resp = await fetch("/api/admin/plan-checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_code: planCode }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        setCheckoutError(json.error || "Could not start checkout. Please try again.");
        setCheckoutLoading(null);
        return;
      }
      if (json.switched) {
        // In-place plan change on existing subscription — no Checkout needed.
        window.location.href = json.return_url || "/admin/plan-usage?upgraded=1";
        return;
      }
      if (json.url) {
        window.location.href = json.url;
        return;
      }
      setCheckoutError("Could not start checkout. Please try again.");
      setCheckoutLoading(null);
    } catch {
      setCheckoutError("Network error starting checkout.");
      setCheckoutLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const quotas = data?.plan?.quotas || {};
  const usage = data?.usage || {};
  const availablePlans = data?.available_plans || [];
  const upgradablePlans = availablePlans.filter((p) => p.can_checkout);
  const subscription = data?.subscription;

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Plan & usage</h1>
          <p className="text-sm text-muted-foreground">See your current plan, usage, and upgrade when you need more.</p>
        </div>

        {info && (
          <Alert>
            <AlertDescription>{info}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {data && (
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
                <div>
                  <CardTitle data-testid="text-plan-name">{data.plan.name} plan</CardTitle>
                  <CardDescription>
                    You're on the {data.plan.code} plan
                    {subscription?.cancel_at_period_end ? " — cancels at end of period." : "."}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{data.plan.code}</Badge>
                  {upgradablePlans.length > 0 && (
                    <Button
                      onClick={() => setSelectorOpen(true)}
                      data-testid="button-upgrade-plan"
                    >
                      Upgrade
                    </Button>
                  )}
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Usage this period</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <Row label="Members"          used={usage.members}          limit={quotas.members} />
                <Row label="Events this month" used={usage.events_per_month} limit={quotas.events_per_month} />
                <Row label="Storage (MB)"      used={usage.storage_mb}        limit={quotas.storage_mb} />
                <Row label="Emails this month" used={usage.emails_per_month}  limit={quotas.emails_per_month} />
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground text-center">
              Need something custom? <a href="mailto:hello@iconn.app" className="text-primary hover:underline">Get in touch</a>.
            </p>
          </>
        )}

        <Dialog open={selectorOpen} onOpenChange={setSelectorOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Choose a plan</DialogTitle>
              <DialogDescription>
                Upgrade to unlock more members, events, storage, and email sends. Billed monthly via Stripe — cancel anytime.
              </DialogDescription>
            </DialogHeader>

            {checkoutError && (
              <Alert variant="destructive">
                <AlertDescription>{checkoutError}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {availablePlans
                .filter((p) => p.code !== "free")
                .map((p) => {
                  const features = [
                    p.quotas?.members != null ? `${fmtQuota(p.quotas.members)} members` : "Unlimited members",
                    p.quotas?.events_per_month != null ? `${fmtQuota(p.quotas.events_per_month)} events/mo` : "Unlimited events",
                    p.quotas?.storage_mb != null ? `${fmtQuota(p.quotas.storage_mb)} MB storage` : "Unlimited storage",
                    p.quotas?.emails_per_month != null ? `${fmtQuota(p.quotas.emails_per_month)} emails/mo` : "Unlimited emails",
                  ];
                  return (
                    <Card
                      key={p.code}
                      className="flex flex-col"
                      data-testid={`card-plan-${p.code}`}
                    >
                      <CardHeader>
                        <div className="flex items-center justify-between gap-2">
                          <CardTitle>{p.name}</CardTitle>
                          {p.is_current && <Badge variant="secondary">Current</Badge>}
                        </div>
                        <CardDescription>{p.description}</CardDescription>
                        <p className="text-2xl font-semibold pt-2" data-testid={`text-price-${p.code}`}>{p.display_price}</p>
                      </CardHeader>
                      <CardContent className="flex-1 flex flex-col gap-4">
                        <ul className="space-y-2 text-sm">
                          {features.map((f) => (
                            <li key={f} className="flex items-start gap-2">
                              <Check className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="mt-auto">
                          {p.is_current ? (
                            <Button variant="outline" className="w-full" disabled data-testid={`button-current-${p.code}`}>
                              Your current plan
                            </Button>
                          ) : p.can_checkout ? (
                            <Button
                              className="w-full"
                              onClick={() => startCheckout(p.code)}
                              disabled={checkoutLoading === p.code}
                              data-testid={`button-checkout-${p.code}`}
                            >
                              {checkoutLoading === p.code ? (
                                <>
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                  Starting checkout…
                                </>
                              ) : (
                                `Upgrade to ${p.name}`
                              )}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              className="w-full"
                              asChild
                              data-testid={`button-contact-${p.code}`}
                            >
                              <a href="mailto:hello@iconn.app">Contact us</a>
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectorOpen(false)} data-testid="button-close-selector">
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
