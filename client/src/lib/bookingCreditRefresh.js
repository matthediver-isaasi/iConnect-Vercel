const SUPPORTED_SOURCES = new Set(['booking', 'complex_event_booking']);
export const CREDIT_REFRESH_BATCH_SIZE = 25;

function copyCursor(cursor) {
  if (cursor == null) return null;
  return JSON.parse(JSON.stringify(cursor));
}

export function buildCreditRefreshSnapshot(groups, {
  tenantId,
  scopeKey,
  filters = [],
} = {}) {
  const idsBySource = {
    booking: new Set(),
    complex_event_booking: new Set(),
  };
  let excludedPublicInvoicePo = 0;
  let excludedUnsupported = 0;

  for (const group of groups || []) {
    const source = group?.bookingSource;
    const ids = new Set((group?.attendees || []).map(attendee => attendee?.id).filter(Boolean));
    const isPublicInvoicePo = group?.isPublicInvoicePo
      || group?.groupPayment?.paymentMethod === 'public_invoice_po';
    if (isPublicInvoicePo) {
      excludedPublicInvoicePo += ids.size;
      continue;
    }
    if (!SUPPORTED_SOURCES.has(source)) {
      excludedUnsupported += ids.size;
      continue;
    }
    for (const id of ids) idsBySource[source].add(String(id));
  }

  const tasks = [];
  for (const source of ['booking', 'complex_event_booking']) {
    const ids = [...idsBySource[source]];
    for (let index = 0; index < ids.length; index += CREDIT_REFRESH_BATCH_SIZE) {
      tasks.push({ source, bookingIds: ids.slice(index, index + CREDIT_REFRESH_BATCH_SIZE) });
    }
  }

  return {
    tenantId,
    scopeKey,
    filters: [...filters],
    tasks,
    counts: {
      booking: idsBySource.booking.size,
      complex_event_booking: idsBySource.complex_event_booking.size,
      total: idsBySource.booking.size + idsBySource.complex_event_booking.size,
      excludedPublicInvoicePo,
      excludedUnsupported,
    },
  };
}

export function createCreditRefreshSession(snapshot) {
  return {
    snapshot,
    taskIndex: 0,
    cursor: null,
    completed: 0,
    requests: 0,
    status: 'ready',
    stopReason: null,
    error: null,
    seenCursorsByTask: new Map(),
  };
}

function completedBeforeTask(session) {
  return session.snapshot.tasks
    .slice(0, session.taskIndex)
    .reduce((total, task) => total + task.bookingIds.length, 0);
}

function cursorCompletedCount(cursor, taskSize) {
  if (cursor == null) return taskSize;
  const index = Number(cursor.index);
  return Number.isInteger(index) ? Math.max(0, Math.min(index, taskSize)) : 0;
}

function validateResponse(result, session, task) {
  if (!result || typeof result !== 'object') {
    throw new Error('Credit refresh returned an invalid response');
  }
  if (result.tenantId !== session.snapshot.tenantId) {
    throw new Error('Credit refresh stopped because the tenant context changed');
  }
  if (!Object.prototype.hasOwnProperty.call(result, 'nextCursor')) {
    throw new Error('Credit refresh response did not include a continuation cursor');
  }
  const next = result.nextCursor;
  if (next === null) return;
  if (!next || typeof next !== 'object' || Array.isArray(next)
    || !Number.isInteger(next.index)
    || next.index < 0 || next.index >= task.bookingIds.length
    || (next.after !== undefined && (typeof next.after !== 'string' || !next.after))
    || (next.noteIndex !== undefined && (!Number.isInteger(next.noteIndex) || next.noteIndex < 0))
    || (next.after !== undefined && next.noteIndex !== undefined)) {
    throw new Error('Credit refresh returned an invalid continuation cursor');
  }
  const currentIndex = Number(session.cursor?.index || 0);
  if (next.index < currentIndex) {
    throw new Error('Credit refresh returned a non-monotonic continuation cursor');
  }
}

/**
 * Runs (or resumes) one immutable report snapshot. A failed request leaves the
 * cursor untouched, making Retry safe. Stop is observed only between requests.
 */
export async function runCreditRefreshSession(session, {
  request,
  shouldStop = () => false,
  onProgress = () => {},
  maxRequests = 1000,
} = {}) {
  if (session.status === 'running') throw new Error('Credit refresh is already running');
  if (!session.snapshot?.tenantId) throw new Error('The report tenant is unavailable');
  session.status = 'running';
  session.stopReason = null;
  session.error = null;
  let requestsThisRun = 0;

  try {
    while (session.taskIndex < session.snapshot.tasks.length) {
      if (shouldStop()) {
        session.status = 'stopped';
        session.stopReason = 'user';
        return session;
      }
      if (requestsThisRun >= maxRequests) {
        session.status = 'stopped';
        session.stopReason = 'request_budget';
        return session;
      }

      const task = session.snapshot.tasks[session.taskIndex];
      const cursorKey = JSON.stringify(session.cursor);
      const seen = session.seenCursorsByTask.get(session.taskIndex) || new Set();
      session.seenCursorsByTask.set(session.taskIndex, seen);
      if (seen.has(cursorKey)) {
        throw new Error('Credit refresh stopped because the server returned a cyclic cursor');
      }

      const result = await request({
        expectedTenantId: session.snapshot.tenantId,
        source: task.source,
        bookingIds: task.bookingIds,
        // The endpoint requires a cursor object; {} denotes the first booking.
        cursor: copyCursor(session.cursor) || {},
      });
      session.requests += 1;
      requestsThisRun += 1;

      validateResponse(result, session, task);
      const nextCursor = result.nextCursor;
      // Only successful requests consume a cursor. A transport/provider error
      // therefore remains safely retryable, while cycles stay detectable
      // across safety-budget pauses and explicit resumes.
      seen.add(cursorKey);
      if (nextCursor !== null) {
        const nextCursorKey = JSON.stringify(nextCursor);
        if (seen.has(nextCursorKey)) {
          throw new Error('Credit refresh stopped because the server returned a cyclic cursor');
        }
      }
      const before = completedBeforeTask(session);
      session.completed = before + cursorCompletedCount(nextCursor, task.bookingIds.length);
      session.cursor = copyCursor(nextCursor);

      if (nextCursor == null) {
        session.taskIndex += 1;
        session.cursor = null;
      }
      onProgress(session);
    }
    session.completed = session.snapshot.counts.total;
    session.status = 'complete';
    return session;
  } catch (error) {
    session.status = 'error';
    session.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}