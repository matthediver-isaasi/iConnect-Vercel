import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { useStorageUsageWarning } from "@/hooks/useStorageUsageWarning";

export default function StorageUsageBanner({ className = "", compact = false }) {
  const { shouldWarn, isOver, pct, used, limit } = useStorageUsageWarning();

  if (!shouldWarn) return null;

  const variant = isOver ? "destructive" : "warning";
  const title = isOver
    ? "You've reached your plan's storage limit"
    : `You're using ${pct}% of your plan storage`;
  const description = isOver
    ? `You've used ${used} MB of your ${limit} MB allowance. New uploads will be blocked until you upgrade or free up space.`
    : `You've used ${used} MB of your ${limit} MB allowance. Upgrade now to avoid uploads being blocked.`;

  return (
    <Alert
      variant={variant}
      className={className}
      data-testid="banner-storage-usage"
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle data-testid="text-storage-banner-title">{title}</AlertTitle>
      <AlertDescription>
        <div className={compact ? "space-y-2" : "space-y-3"}>
          <p>{description}</p>
          {pct != null && (
            <Progress value={pct} data-testid="progress-storage-banner" />
          )}
          <div>
            <Button
              asChild
              size="sm"
              variant={isOver ? "default" : "outline"}
              data-testid="button-storage-banner-upgrade"
            >
              <Link to="/admin/plan-usage">View plan &amp; upgrade</Link>
            </Button>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}
