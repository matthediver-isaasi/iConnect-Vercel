import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Sparkles } from "lucide-react";

const QUOTA_LABELS = {
  members: "members",
  events_per_month: "events this month",
  storage_mb: "storage (MB)",
  emails_per_month: "emails this month",
};

function formatNumber(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString();
}

export default function PlanQuotaDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [quota, setQuota] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    function handler(e) {
      const detail = e?.detail || {};
      setQuota(detail.quota || null);
      setMessage(detail.message || "");
      setOpen(true);
    }
    window.addEventListener("plan-quota-exceeded", handler);
    return () => window.removeEventListener("plan-quota-exceeded", handler);
  }, []);

  const planName = quota?.plan_name || quota?.plan || "your current plan";
  const label = quota?.key ? (QUOTA_LABELS[quota.key] || quota.key) : null;
  const upgradeUrl = quota?.upgrade_url || "/admin/plan-usage";

  function goToUpgrade() {
    setOpen(false);
    if (upgradeUrl.startsWith("/")) {
      navigate(upgradeUrl);
    } else {
      window.location.href = upgradeUrl;
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="dialog-plan-quota-exceeded">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
            <span>Plan limit reached</span>
          </DialogTitle>
          <DialogDescription>
            {label
              ? `You've hit the ${label} limit on the ${planName} plan.`
              : `You've hit a limit on the ${planName} plan.`}
          </DialogDescription>
        </DialogHeader>

        {quota && (quota.limit !== undefined || quota.current !== undefined) && (
          <div
            className="rounded-md border bg-muted/40 p-3 text-sm"
            data-testid="text-plan-quota-usage"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Current usage</span>
              <span className="font-medium">
                {formatNumber(quota.current)}
                {quota.limit !== null && quota.limit !== undefined
                  ? ` of ${formatNumber(quota.limit)}`
                  : ""}
              </span>
            </div>
          </div>
        )}

        {message && (
          <Alert variant="warning" data-testid="alert-plan-quota-message">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            data-testid="button-plan-quota-dismiss"
          >
            Not now
          </Button>
          <Button onClick={goToUpgrade} data-testid="button-plan-quota-upgrade">
            View plan & upgrade
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
