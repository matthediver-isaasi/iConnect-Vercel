// Date-field terms are deliberately separate from fixed-month rolling commitments.
// Callers must resolve the field/value under tenant and member authorization.
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('A valid date-only membership date is required.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
      || value < '0001-01-01' || value > '9998-12-31') {
    throw new Error('A valid date-only membership date is required.');
  }
  return value;
}

export function buildMemberDateTerm({ tenantId, memberId, field, value, startDate, graceDays = 0 }) {
  if (!tenantId || !memberId || !field?.id || field.tenant_id !== tenantId
      || field.entity_scope !== 'member' || field.field_type !== 'date'
      || field.is_active !== true || field.custom_object_id) {
    throw new Error('Choose an active member date field belonging to this tenant.');
  }
  const start = dateOnly(startDate);
  const end = dateOnly(value);
  if (end < start) throw new Error('The membership end date must not precede its start date.');
  if (!Number.isSafeInteger(graceDays) || graceDays < 0) {
    throw new Error('Grace days must be a non-negative whole number.');
  }
  const followingDate = new Date(`${end}T00:00:00.000Z`);
  followingDate.setUTCDate(followingDate.getUTCDate() + 1);
  return {
    term_start_date: start,
    term_end_date: end,
    membership_renewal_date: followingDate.toISOString().slice(0, 10),
    // Never pretend an arbitrary course length is an annual/monthly commitment.
    term_duration_months: null,
    term_source_snapshot: {
      version: 1, type: 'member_date_field', tenant_id: tenantId, member_id: memberId,
      field_id: field.id, field_label: field.label || field.name || null,
      end_date: end, grace_days: graceDays,
    },
  };
}

export function previewMemberDateExtension({ current, newEndDate, reason }) {
  const start = dateOnly(current?.term_start_date);
  const previousEnd = dateOnly(current?.term_end_date);
  if (previousEnd < start || current?.term_source_snapshot?.type !== 'member_date_field') {
    throw new Error('This membership does not have a verified member-date term.');
  }
  const end = dateOnly(newEndDate);
  if (end <= previousEnd) throw new Error('An extension must end after the existing term.');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('An extension reason is required.');
  return { term_start_date: start, previous_end_date: previousEnd, new_end_date: end, reason: reason.trim() };
}
