// Fee History presentation of a year-replacement accounting operation.
// The server marks an operation `resumable` when no live worker lease holds
// it (failed, pending, or interrupted with an expired lease).
export function replacementSyncStatus(op) {
  if (!op || op.sync_state === 'complete') return null;
  const failed = op.sync_state === 'failed';
  const stalled = !failed && op.stalled === true;
  const label = failed ? 'failed' : stalled ? 'interrupted' : op.sync_state === 'pending' ? 'waiting' : 'in progress';
  return {
    label,
    destructive: failed || stalled,
    canRetry: op.resumable === true,
    message: op.last_error || (stalled ? 'The accounting sync stopped before finishing. Retry to resume it.' : null),
  };
}
