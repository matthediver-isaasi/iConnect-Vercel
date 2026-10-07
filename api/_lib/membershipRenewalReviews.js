// This journal lives inside the existing service-only, lease-owned cron state.
// Never advance past a failed financial operation until its review is durable.
export const MAX_RENEWAL_REVIEWS = 2000;
export const reviewKey = cursor => JSON.stringify(cursor);

export function renewalReviewControl({ state, tenantId, stage, save, clock, results }) {
  const reviews = () => state.reviews?.[tenantId]?.[stage] || {};
  return {
    isQuarantined: (cursor, row) => Boolean(reviews()[reviewKey(cursor)])
      || Object.values(state.reviews?.[tenantId] || {}).some(records =>
        Object.values(records).some(review =>
          (row.member_id && review.memberId === row.member_id)
          || (!row.member_id && !review.memberId && row.organization_id
            && review.organizationId === row.organization_id))),
    async quarantine(cursor, row, details, errorCount) {
      const existing = reviews();
      if (!existing[reviewKey(cursor)] && Object.keys(existing).length >= MAX_RENEWAL_REVIEWS) {
        throw new Error('Renewal review journal is full; continuation retained');
      }
      const record = {
        stage, cursor, firstFailedAt: new Date(clock()).toISOString(),
        recordId: row.id || null, memberId: row.member_id || null,
        organizationId: row.organization_id || null,
        reasons: [...new Set(details.map(d => d.reason || d.error || 'Renewal failed'))]
          .slice(0, 10).map(reason => String(reason).slice(0, 1000)),
        recovery: 'manual_review',
      };
      if (!record.reasons.length) record.reasons.push('Renewal failed without a detailed reason');
      state.reviews ||= {};
      state.reviews[tenantId] ||= {};
      state.reviews[tenantId][stage] ||= {};
      state.reviews[tenantId][stage][reviewKey(cursor)] = record;
      try {
        await save();
      } catch (error) {
        // Do not make an unpersisted review eligible for skipping in this worker.
        delete state.reviews[tenantId][stage][reviewKey(cursor)];
        throw error;
      }
      results.isolatedErrors = (results.isolatedErrors || 0) + errorCount;
      for (const detail of details) {
        if (detail.status === 'error' || detail.status === 'failed' || detail.error) {
          detail.isolated = true;
          detail.status = 'review_required';
        }
      }
    },
  };
}

export function tenantRenewalReviews(state, tenantId, now) {
  return Object.values(state.reviews?.[tenantId] || {}).flatMap(rows =>
    Object.values(rows).map(row => ({
      ...row,
      ageHours: Math.max(0, Math.floor((now - Date.parse(row.firstFailedAt)) / 3_600_000)),
    })));
}
