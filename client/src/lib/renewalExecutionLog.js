export function renewalExecutionLog(log) {
  if (log?.task_name !== 'membership_renewals') return null;
  let value = log.details;
  try {
    // Historical rows contain either an object or JSON encoded inside JSONB.
    for (let i = 0; i < 3 && typeof value === 'string'; i++) value = JSON.parse(value);
  } catch { return { unavailable: true }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { unavailable: true };
  const reviews = Array.isArray(value.reviews) ? value.reviews : [];
  const historyIds = Array.isArray(value.reviewHistoryIds) ? value.reviewHistoryIds : [];
  const details = Array.isArray(value.details) ? value.details : [];
  return {
    outcome: value.outcome,
    workerAvailable: typeof value.workerAvailable === 'boolean' ? value.workerAvailable : null,
    durationMs: value.duration_ms,
    reviewCount: value.reviewCount ?? reviews.length + historyIds.length,
    reviews,
    historyIds,
    errors: details.filter(d => d.status === 'error' || d.status === 'review_required' || d.error),
    summary: value.reviewCount > 0
      ? `${value.reviewCount} unresolved review${value.reviewCount === 1 ? '' : 's'}`
      : value.outcome === 'deferred' ? 'More work queued for the next run'
        : value.outcome === 'completed' ? 'Run completed'
          : value.outcome === 'failed' ? 'Processing errors — see details' : value.outcome || 'See details',
  };
}
