import { createHash } from 'node:crypto';
import { lifecycleDay } from '../../shared/memberLifecyclePolicy.mjs';

export function lifecycleEvidenceFingerprint(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function reviewedMembershipAbsence(histories, review, fingerprint, today) {
  if (histories.length || !review || review.fingerprint !== fingerprint || !review.reference?.trim()
    || !review.reviewedAt || lifecycleDay(review.reviewedAt) > today) return null;
  if (review.historyKind === 'never') return { historyKind: 'never', provenance: 'administrator_review' };
  if (review.historyKind === 'former' && review.graceEndDate && lifecycleDay(review.graceEndDate) <= today) {
    return { historyKind: 'former', graceEndDate: lifecycleDay(review.graceEndDate), provenance: 'administrator_review' };
  }
  return null;
}

export function reviewedLoginCoverage(observed, review, today) {
  if (!review || !review.reference?.trim() || !review.reviewedAt
    || lifecycleDay(review.reviewedAt) > today
    || observed.reasons?.some(reason => reason !== 'login_history_coverage_unverified')) return observed;
  const known = review.lastOccurredAt ? lifecycleDay(review.lastOccurredAt) : null;
  if (known && known > lifecycleDay(review.reviewedAt)) return observed;
  return { ...observed, complete: true, reasons: [],
    lastOccurredAt: [known, observed.lastOccurredAt].filter(Boolean).sort().at(-1) || null,
    historicalCoverage: { reviewedAt: review.reviewedAt, reference: review.reference },
  };
}
