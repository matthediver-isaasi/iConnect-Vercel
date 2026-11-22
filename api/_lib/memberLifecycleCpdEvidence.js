import { lifecycleDay } from '../../shared/memberLifecyclePolicy.mjs';

const roots = new Set(['event_award', 'imported_award', 'manual_award']);
const kinds = new Set([...roots, 'reversal', 'manual_adjustment']);

// Read the effective-ownership view, not the original ledger member_id. Merges
// transfer finite award roots and their corrections without rewriting evidence.
// This is preview evidence only; execution needs a transactional source fence.
export function assessLifecycleCpd(rows, { tenantId, memberId, timezone = 'UTC', now = new Date() }) {
  const issues = new Set();
  const byId = new Map();
  const dates = [];
  const today = lifecycleDay(now, timezone);
  if (!Array.isArray(rows)) throw new Error('CPD evidence is unavailable');
  for (const row of rows) {
    if (!row?.id || row.tenant_id !== tenantId || row.effective_member_id !== memberId
      || byId.has(row.id)) throw new Error('Invalid CPD evidence scope');
    byId.set(row.id, row);
    if (!kinds.has(row.entry_kind)) issues.add('unsupported_cpd_entry');
  }
  const reversed = new Set();
  const adjustments = new Map();
  for (const row of rows) {
    if (!['reversal', 'manual_adjustment'].includes(row.entry_kind)) continue;
    const rootId = row.entry_kind === 'reversal' ? row.reversal_of : row.correction_of;
    const root = byId.get(rootId);
    if (!root || !roots.has(root.entry_kind) || root.member_id !== row.member_id) {
      issues.add('unresolved_cpd_correction');
      continue;
    }
    if (row.entry_kind === 'reversal') {
      const rootValue = points(root.points_value), reversalValue = points(row.points_value);
      if (rootValue == null || reversalValue == null || reversalValue !== -rootValue) {
        issues.add('invalid_cpd_reversal');
        continue;
      }
      if (reversed.has(rootId)) issues.add('duplicate_cpd_reversal');
      reversed.add(rootId);
    } else {
      const value = points(row.points_value);
      if (value == null) issues.add('invalid_cpd_points');
      else adjustments.set(rootId, (adjustments.get(rootId) || 0n) + value);
    }
  }
  for (const row of rows) {
    if (!roots.has(row.entry_kind)) continue;
    const value = points(row.points_value);
    if (value == null || value < 0n || row.reversal_of || row.correction_of) {
      issues.add('invalid_cpd_award');
      continue;
    }
    // An administrative adjustment is not new activity. Its occurrence remains
    // the original award's date, even if it was entered years later.
    if (reversed.has(row.id)) continue;
    const earned = value + (adjustments.get(row.id) || 0n);
    if (earned < 0n) { issues.add('negative_cpd_award_balance'); continue; }
    if (earned === 0n) continue;
    let occurredAt = row.activity_date;
    if (!occurredAt && row.entry_kind === 'event_award' && row.award_trigger === 'attendance'
      && row.evidence_type === 'qr_checkin' && row.evidence_snapshot?.type === 'qr_checkin') {
      occurredAt = row.evidence_snapshot.checkedInAt;
      // Current attendance/reversal authority has not been loaded here. A
      // reversed snapshot cannot establish positive earned activity.
      if (row.evidence_snapshot.checkInReversedAt) {
        issues.add('cpd_attendance_requires_revalidation');
        continue;
      }
    }
    if (!occurredAt) { issues.add('cpd_occurrence_date_missing'); continue; }
    try {
      const day = lifecycleDay(occurredAt, timezone);
      if (day > today) { issues.add('future_cpd_occurrence'); continue; }
      dates.push(day);
    } catch { issues.add('invalid_cpd_occurrence'); }
  }
  return {
    complete: issues.size === 0,
    lastOccurredAt: dates.sort().at(-1) || null,
    source: 'member_cpd_effective_ledger',
    reasons: [...issues].sort(),
  };
}

// PostgreSQL numeric(20,6) must not be summed as floating point: an exact zero
// after corrections must not become a tiny positive qualifying award.
function points(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(-?)(\d{1,14})(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match) return null;
  const scaled = BigInt(match[2]) * 1000000n + BigInt((match[3] || '').padEnd(6, '0'));
  return match[1] ? -scaled : scaled;
}
