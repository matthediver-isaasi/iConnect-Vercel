// Provider-neutral manual-sync response handling. Keep this separate from the
// report page so mixed Zoom/Teams outcomes are easy to exercise without JSX.
export function attendanceSyncMessage({ participants = 0, matched = 0, pending = 0, errors = [] } = {}) {
  const failures = (errors || []).filter(Boolean);
  if (failures.length > 0 && participants === 0 && pending === 0) {
    return { level: 'error', message: `Sync failed: ${failures[0]}` };
  }
  if (pending > 0 && failures.length > 0) {
    return {
      level: 'info',
      message: `Attendance reports are pending for ${pending} Teams target${pending === 1 ? '' : 's'}; some other targets had errors: ${failures[0]}`,
    };
  }
  if (failures.length > 0) {
    return { level: 'info', message: `Synced ${participants} participants (${matched} matched). Some events had errors.` };
  }
  if (pending > 0) {
    return {
      level: 'info',
      message: `Attendance reports are still pending for ${pending} Teams target${pending === 1 ? '' : 's'} and will be retried automatically.`,
    };
  }
  return { level: 'success', message: `Synced ${participants} participants (${matched} matched to bookings)` };
}

export function responseHasPendingSync(data, status) {
  return status === 202 || data?.pending === true || Number(data?.pendingCount) > 0;
}

export function responseErrors(data, fallback) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const failures = Array.isArray(data?.failures) ? data.failures : [];
  const resultFailures = Array.isArray(data?.results)
    ? data.results.filter((entry) => entry?.success === false && !entry?.pending)
    : [];
  return [...errors, ...failures, ...resultFailures]
    .map((entry) => typeof entry === 'string' ? entry : (entry?.error || entry?.message))
    .filter(Boolean)
    .concat(data?.error ? [data.error] : (fallback ? [fallback] : []));
}