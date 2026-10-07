import { renewalExecutionLog } from "@/lib/renewalExecutionLog";

export default function RenewalExecutionDetails({ log }) {
  const data = renewalExecutionLog(log);
  if (!data) return log.summary || '-';
  if (data.unavailable) return 'Renewal details could not be read';
  return (
    <details className="min-w-64 max-w-xl whitespace-normal">
      <summary className="cursor-pointer text-slate-200">{data.summary}</summary>
      <div className="mt-2 space-y-2 text-sm">
        <p>Processing: {data.outcome || 'Not recorded'}. Worker: {
          data.workerAvailable === null ? 'Not recorded in this older log'
            : data.workerAvailable ? 'Running' : 'Failed or stalled'
        }.</p>
        {data.reviewCount > 0 && (
          <p className="text-amber-300">
            Needs review: {data.reviewCount}. Independent renewals can continue.
            Failed billing records are held, not automatically retried. Reconcile membership
            and provider evidence before arranging recovery; do not repeat an uncertain payment.
          </p>
        )}
        <ul className="space-y-3">
          {data.reviews.map((review, index) => (
            <li key={index} className="border-l-2 border-amber-500 pl-2 break-words">
              <p>{review.stage} — record {review.recordId || JSON.stringify(review.cursor)}</p>
              {review.memberId && <p>Member: {review.memberId}</p>}
              {review.organizationId && <p>Organisation: {review.organizationId}</p>}
              <p>First failed: {review.firstFailedAt}; age: {review.ageHours} hours</p>
              {(review.reasons || []).map((reason, i) => <p key={i}>{reason}</p>)}
            </li>
          ))}
          {data.historyIds.map(id => <li key={id}>Expiry policy needs review — history {id}</li>)}
          {data.errors.map((detail, index) => (
            <li key={`error-${index}`} className="break-words">
              {detail.stage || detail.step || 'Renewal'}: {detail.reason || detail.error || 'Needs review'}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
