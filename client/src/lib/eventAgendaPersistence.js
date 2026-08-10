// Event agenda persistence with compensating rollback (Tasks #3419, #3512).
//
// Agenda rows are saved alongside the parent event update on Edit Event.
// There is NO server-side transaction covering both, so this helper cannot
// guarantee atomicity — it provides best-effort compensation instead:
// agenda mutations run FIRST, and if any of them fails, the helper attempts
// to reverse every mutation that may have reached the server (created rows
// deleted, updated rows restored from the load-time snapshot, deleted rows
// recreated) before the error propagates. Mutations are recorded BEFORE they
// are awaited, so an operation whose request reached the server but whose
// response was lost is still compensated. Compensation failures are NOT
// swallowed silently: they are collected and attached to the thrown error as
// `error.rollbackFailures` (and returned from `undo()`), so callers can tell
// the user a partial save may remain and a reload is required.
//
// Framework-free on purpose so it can be unit-tested under node --test.

/**
 * Persist agenda lines for an event.
 *
 * @param {object} opts
 * @param {{create:Function, update:Function, delete:Function}} opts.api
 *   Entity API for EventAgendaItem (each fn returns a promise).
 * @param {Array<object>} opts.orderedLines
 *   Lines in their final (chronological) order. Lines with an `id` are
 *   updated; lines without are created.
 * @param {Array<object>} opts.initialRows
 *   Snapshot of the rows as loaded from the server (line shape, each with an
 *   `id`). Used to compute deletions and to restore state on rollback.
 * @param {(line: object, sortOrder: number) => object} opts.buildPayload
 *   Maps a line to the create/update payload (including sort_order).
 * @returns {Promise<{savedIds: string[], persistedLines: Array<object>, undo: () => Promise<Array<object>>}>}
 *   `persistedLines` is `orderedLines` with server ids attached per-line
 *   (rebuild local state from it so re-saves update instead of re-create);
 *   `undo()` reverses the saved mutations and resolves with an array of
 *   rollback failures (empty when fully reversed).
 * @throws The original error, with `rollbackFailures` attached (array of
 *   `{op, id?, reason}` — empty when compensation fully succeeded).
 */
export async function persistAgendaLinesWithRollback({ api, orderedLines, initialRows, buildPayload }) {
  const lines = orderedLines || [];
  const snapshot = (initialRows || []).filter((r) => r && r.id);
  const keptIds = new Set(lines.map((l) => l.id).filter(Boolean));
  const removedRows = snapshot.filter((r) => !keptIds.has(r.id));

  // Every mutation is recorded here BEFORE its request is awaited, so
  // request-sent-but-response-lost operations are still compensated.
  const attempted = [];

  const undo = () => rollbackAgendaMutations({ api, attempted, initialRows: snapshot, buildPayload });

  try {
    for (const row of removedRows) {
      attempted.push({ op: 'delete', row });
      await api.delete(row.id);
    }
    const savedIds = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const payload = buildPayload(line, i);
      if (line.id) {
        attempted.push({ op: 'update', id: line.id });
        await api.update(line.id, payload);
        savedIds.push(line.id);
      } else {
        const rec = { op: 'create', id: null };
        attempted.push(rec);
        const created = await api.create(payload);
        rec.id = created?.id || null;
        savedIds.push(created?.id);
      }
    }
    // `persistedLines` carries each line WITH its server id attached (created
    // lines get their new id), aligned per-line — callers must rebuild local
    // state from this, never by indexing into the filtered `savedIds`.
    const persistedLines = lines.map((line, i) => (line.id ? line : { ...line, id: savedIds[i] || null }));
    return { savedIds: savedIds.filter(Boolean), persistedLines, undo };
  } catch (err) {
    const failures = await undo();
    try { err.rollbackFailures = failures; } catch { /* frozen error */ }
    throw err;
  }
}

/**
 * Best-effort compensation, in reverse order of the attempted mutations:
 * - attempted creates: delete the created row (if its id never came back the
 *   row may or may not exist server-side — reported as a failure so the
 *   caller asks the user to reload);
 * - attempted updates: restore the row to its snapshot values (safe even if
 *   the update never persisted);
 * - attempted deletes: recreate the row from the snapshot (recreated rows get
 *   new ids — unavoidable without a server transaction).
 *
 * @returns {Promise<Array<{op:string, id?:string, reason:string}>>} failures
 *   (empty array when every compensation step succeeded).
 */
export async function rollbackAgendaMutations({ api, attempted, initialRows, buildPayload }) {
  const failures = [];
  const rows = initialRows || [];
  const snapshotIndex = (row) => {
    const i = rows.indexOf(row);
    return i >= 0 ? i : (row?.sort_order ?? 0);
  };
  for (const rec of [...(attempted || [])].reverse()) {
    try {
      if (rec.op === 'create') {
        if (rec.id) {
          await api.delete(rec.id);
        } else {
          // The create's response was never received — the row may exist.
          failures.push({ op: 'create', reason: 'created row id unknown — it may still exist on the server' });
        }
      } else if (rec.op === 'update') {
        const orig = rows.find((r) => r.id === rec.id);
        if (orig) await api.update(rec.id, buildPayload(orig, snapshotIndex(orig)));
      } else if (rec.op === 'delete') {
        await api.create(buildPayload(rec.row, snapshotIndex(rec.row)));
      }
    } catch (e) {
      failures.push({ op: rec.op, id: rec.id || rec.row?.id, reason: e?.message || 'unknown error' });
    }
  }
  if (failures.length > 0) {
    console.error('[agenda rollback] compensation incomplete:', failures);
  }
  return failures;
}
