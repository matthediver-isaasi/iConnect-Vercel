import { RECONCILIATION_GUIDANCE } from '../../../../shared/campaignDeliverySummary.js';

export default function CampaignDeliverySummary({ summary, onInspect }) {
  if (!summary) return null;
  return <div className="text-xs space-y-1 whitespace-normal max-w-md" data-testid="campaign-delivery-summary">
    <p>{summary.sent.toLocaleString()} sent · {summary.excluded.toLocaleString()} excluded (skipped) · {summary.failed.toLocaleString()} failed · {summary.processing.toLocaleString()} awaiting reconciliation · {summary.queued.toLocaleString()} queued</p>
    <p className="text-muted-foreground">Sent means accepted by the provider, not confirmed delivery. Exclusions were not sent; no email was recalled.</p>
    {summary.reconciliationAlert && <div role="alert" className="text-warning" data-testid="campaign-reconciliation-alert">
      <p>{summary.reconciliationAlert.message}</p>
      <p>{RECONCILIATION_GUIDANCE}</p>
      {onInspect && <button type="button" className="underline font-medium" onClick={onInspect}>Inspect delivery details</button>}
    </div>}
  </div>;
}
