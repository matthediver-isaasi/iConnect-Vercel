function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateMemberGroupAssignmentPatch(patch = {}) {
  for (const field of ['expires_at', 'term_start_date', 'term_end_date']) {
    const value = patch[field];
    if (value != null && value !== '' && !isValidDateOnly(value)) {
      return { ok: false, error: `${field.replaceAll('_', ' ')} must be a valid date` };
    }
  }

  if (patch.term_start_date && patch.term_end_date
    && patch.term_end_date < patch.term_start_date) {
    return { ok: false, error: "The term end date can't be before the start date." };
  }

  if ('term_number' in patch && patch.term_number != null
    && (!Number.isInteger(Number(patch.term_number)) || Number(patch.term_number) < 1)) {
    return { ok: false, error: 'Term number must be a whole number of 1 or more.' };
  }

  if ('group_role' in patch && !String(patch.group_role || '').trim()) {
    return { ok: false, error: 'A group role is required.' };
  }

  return { ok: true };
}