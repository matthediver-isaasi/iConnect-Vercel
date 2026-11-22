import { lifecycleReviewDetail } from './memberLifecycleReview.js';

export async function lifecycleSourceStamp(db) {
  const { data, error } = await db.rpc('member_lifecycle_source_stamp');
  if (error) throw error;
  if (typeof data !== 'string' || !/^[0-9a-f]{32}$/.test(data)) throw new Error('Lifecycle source fence unavailable');
  return data;
}

// A bounded retry is safe for reads only. A write conflict must return to the
// caller; never silently retry a previously approved destructive decision.
export async function lifecycleStableDetail(db, tenantId, memberId, policy, deps = {}) {
  const detail = deps.detail || lifecycleReviewDetail;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sourceStamp = await lifecycleSourceStamp(db);
    const result = await detail(db, tenantId, memberId, policy, { ...deps, expiryCoordinated: true });
    if (sourceStamp === await lifecycleSourceStamp(db)) return { ...result, sourceStamp };
  }
  throw Object.assign(new Error('Member evidence is changing; refresh before making a decision'), { status: 409 });
}
