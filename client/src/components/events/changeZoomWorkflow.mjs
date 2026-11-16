const countKeys = ['cancelled', 'registered', 'existing', 'pending', 'denied', 'skipped', 'missingEmail', 'failed', 'emailed'];

export function createZoomOperation(body, current) {
  if (!current || !('zoom_webinar_id' in current) || !('zoom_meeting_id' in current)) {
    throw new Error('Could not verify the current Zoom link. Please retry.');
  }
  const hasCurrent = !!(current.zoom_webinar_id || current.zoom_meeting_id);
  const same = (body.zoom_webinar_id || null) === (current.zoom_webinar_id || null)
    && (body.zoom_meeting_id || null) === (current.zoom_meeting_id || null);
  const initialAttach = !hasCurrent && !!(body.zoom_webinar_id || body.zoom_meeting_id);
  return {
    body: { ...body, cancelOld: same || initialAttach ? false : body.cancelOld },
    initialAttach,
    phase: initialAttach ? 'attach' : 'batches',
    attendeeActions: !!(body.registerNew || body.resendConfirmations),
    attached: false,
    cursor: null,
    batches: 0,
    totals: { ...Object.fromEntries(countKeys.map(key => [key, 0])), errors: [] },
    lastResult: null,
    done: false,
  };
}

// The operation is a checkpoint owned by the dialog. Advance it only after an
// acknowledged response, so retry never repeats a completed email batch.
export async function runZoomOperation(operation, post, onProgress = () => {}) {
  const op = operation;
  if (op.done) return op.lastResult;
  if (op.phase === 'attach') {
    onProgress(op);
    const result = await post({
      ...op.body, cancelOld: false, registerNew: false,
      resendConfirmations: false, enableRegistration: false, afterBookingId: null,
    });
    op.attached = true;
    op.lastResult = result;
    op.totals.errors.push(...(result.errors || []));
    // Attach-only responses may include booking counters or a cursor. They are
    // not attendee work, and must not skip the first attendee batch.
    op.phase = 'batches';
    op.cursor = null;
    if (!op.attendeeActions) {
      op.done = true;
      onProgress(op);
      return result;
    }
  }
  while (!op.done) {
    onProgress(op);
    const result = await post({
      ...op.body,
      ...(op.initialAttach ? { cancelOld: false } : {}),
      afterBookingId: op.cursor,
    });
    for (const key of countKeys) op.totals[key] += result[key] || 0;
    op.totals.errors.push(...(result.errors || []));
    op.batches++;
    op.lastResult = result;
    op.cursor = result.nextCursor || null;
    op.done = !op.cursor;
    onProgress(op);
  }
  return { ...op.lastResult, ...op.totals };
}
