import React from 'react';
import { Badge } from '@/components/ui/badge';

export default function MembershipAccountingStatus({ progress, recordId }) {
  if (!progress) return null;
  const labels = {
    waiting: 'Accounting waiting to retry',
    pending: 'Accounting retry pending',
    attention: 'Accounting needs manual attention',
    unavailable: 'Accounting progress unavailable',
    complete: 'Accounting completed',
  };
  const retryTime = Date.parse(progress.retryAt);
  return (
    <div className="max-w-64 text-center" data-testid={`accounting-progress-${recordId}`} role="status">
      <Badge variant={progress.state === 'attention' ? 'destructive' : 'outline'}>
        {labels[progress.state] || labels.unavailable}
      </Badge>
      {['waiting', 'pending'].includes(progress.state) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {Number.isFinite(retryTime)
            ? <>Next retry eligible: <time dateTime={progress.retryAt}>{new Date(retryTime).toLocaleString()}</time>. Automatic processing may run later.</>
            : 'Waiting for automatic accounting processing.'}
        </p>
      )}
      {progress.state === 'attention' && <p className="mt-1 text-xs">Review the original form submission and accounting evidence before recovery.</p>}
      {progress.state === 'unavailable' && <p className="mt-1 text-xs">Refresh to check progress before attempting recovery.</p>}
      {progress.state !== 'complete' && <p className="mt-1 text-xs">Membership remains paid. Do not charge again.</p>}
    </div>
  );
}
