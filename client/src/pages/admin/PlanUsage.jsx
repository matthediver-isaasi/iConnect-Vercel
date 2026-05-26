import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";

function fmt(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString();
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
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
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
    })();
  }, [navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const quotas = data?.plan?.quotas || {};
  const usage = data?.usage || {};

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Plan & usage</h1>
          <p className="text-sm text-muted-foreground">Read-only overview of your current plan and limits.</p>
        </div>

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
                  <CardDescription>You're on the {data.plan.code} plan.</CardDescription>
                </div>
                <Badge variant="secondary">{data.plan.code}</Badge>
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
              Need a bigger plan? <a href="mailto:hello@iconn.app" className="text-primary hover:underline">Get in touch</a>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
