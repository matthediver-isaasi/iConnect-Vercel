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

export async function* renewalRows(queryFactory, {
  key = 'id', control, results, pageSize = 100, missingSchema = false,
} = {}) {
  let cursor = control?.cursor || null;
  for (;;) {
    assertRenewalBudget(control);
    let query = queryFactory().order(key, { ascending: true }).limit(pageSize);
    if (cursor) query = query.gt(key, cursor);
    const { data, error } = await query;
    if (error) {
      if (missingSchema && ['42P01', '42703'].includes(error.code)) return;
      throw new Error(`Could not page renewal candidates: ${error.message}`);
    }
    if (!data?.length) return;
    for (const row of data) {
      assertRenewalBudget(control);
      const errorsBefore = results?.errors || 0;
      yield row;
      if ((results?.errors || 0) > errorsBefore) {
        const failure = new Error('Renewal row failed; its continuation was not advanced');
        failure.code = 'RENEWAL_ROW_FAILED';
        throw failure;
      }
      if (!row[key] || row[key] === cursor) throw new Error('Invalid renewal pagination cursor');
      cursor = row[key];
      await control?.checkpoint(cursor);
    }
  }
}