// Cooperative deadlines: never abandon an in-flight financial write.
export class RenewalBudgetExceeded extends Error {
  constructor() {
    super('Membership renewal work checkpointed for the next invocation');
    this.code = 'RENEWAL_BUDGET_EXHAUSTED';
  }
}

export function assertRenewalBudget(control) {
  if (control && !control.shouldContinue()) throw new RenewalBudgetExceeded();
}

function invalidCursor() {
  return new Error('Invalid renewal pagination cursor');
}

const cursorValue = value => (typeof value === 'string' && value.length > 0)
  || (typeof value === 'number' && Number.isFinite(value));

// Quote values in PostgREST boolean expressions; identifiers come from code,
// never from the persisted cursor.
const filterValue = value => JSON.stringify(value);

export async function* renewalRows(queryFactory, {
  key = 'id', tieBreaker = null, control, results, pageSize = 100, missingSchema = false,
} = {}) {
  let cursor = control?.cursor ?? null;
  if (cursor !== null) {
    if (tieBreaker && typeof cursor === 'object') {
      if (cursor.version !== 1 || cursor.key !== key || cursor.tieBreaker !== tieBreaker
        || !cursorValue(cursor.value) || !cursorValue(cursor.tieValue)) throw invalidCursor();
    } else if (!cursorValue(cursor)) throw invalidCursor();
  }
  for (;;) {
    assertRenewalBudget(control);
    let query = queryFactory().order(key, { ascending: true }).limit(pageSize);
    if (tieBreaker) {
      query = query.order(tieBreaker, { ascending: true });
      if (cursor !== null) {
        if (typeof cursor === 'object') {
          query = query.or(`${key}.gt.${filterValue(cursor.value)},and(${key}.eq.${filterValue(cursor.value)},${tieBreaker}.gt.${filterValue(cursor.tieValue)})`);
        } else {
          // Legacy cursors identify an owner, NOT a settings row. Its other
          // years may be unfinished. Replay this boundary owner rather than
          // skipping its siblings or restarting the entire financial stream.
          query = query.gte(key, cursor);
        }
      }
    } else if (cursor !== null) query = query.gt(key, cursor);
    const { data, error } = await query;
    if (error) {
      if (missingSchema && ['42P01', '42703'].includes(error.code)) return;
      throw new Error(`Could not page renewal candidates: ${error.message}`);
    }
    if (!data?.length) return;
    for (const row of data) {
      assertRenewalBudget(control);
      // Validate before handing the row to a caller that may perform writes.
      const value = row[key], tieValue = tieBreaker ? row[tieBreaker] : null;
      if (!cursorValue(value) || (tieBreaker && !cursorValue(tieValue))) throw invalidCursor();
      if (cursor !== null) {
        const previous = tieBreaker && typeof cursor === 'object' ? cursor.value : cursor;
        if (value < previous || (!tieBreaker && value === previous)
          || (tieBreaker && typeof cursor === 'object'
            && value === previous && tieValue <= cursor.tieValue)) throw invalidCursor();
      }
      const nextCursor = tieBreaker
        ? { version: 1, key, value, tieBreaker, tieValue }
        : value;
      if (control?.isQuarantined?.(nextCursor, row)) {
        cursor = nextCursor;
        await control.checkpoint(cursor);
        continue;
      }
      const errorsBefore = results?.errors || 0;
      const detailsBefore = results?.details?.length || 0;
      yield row;
      if ((results?.errors || 0) > errorsBefore) {
        if (control?.quarantine) {
          await control.quarantine(nextCursor, row, results.details?.slice(detailsBefore) || [],
            results.errors - errorsBefore);
        } else {
          const failure = new Error('Renewal row failed; its continuation was not advanced');
          failure.code = 'RENEWAL_ROW_FAILED';
          throw failure;
        }
      }
      cursor = nextCursor;
      await control?.checkpoint(cursor);
    }
  }
}