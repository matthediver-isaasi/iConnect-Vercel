function datePart(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

export function buildAssignmentEditForm(assignment) {
  return {
    group_role: assignment?.group_role || '',
    expires_at: datePart(assignment?.expires_at),
    is_group_admin: assignment?.is_group_admin === true,
    term_start_date: datePart(assignment?.term_start_date),
    term_end_date: datePart(assignment?.term_end_date),
    term_number: assignment?.term_number == null ? '' : String(assignment.term_number),
  };
}

export function buildAssignmentEditPayload(form) {
  if (!form?.group_role) {
    return { error: 'Please select a role.' };
  }

  const startDate = form.term_start_date || '';
  const endDate = form.term_end_date || '';
  if (startDate && endDate && endDate < startDate) {
    return { error: "The term end date can't be before the start date." };
  }

  let termNumber = null;
  if (form.term_number !== '' && form.term_number != null) {
    const number = Number(form.term_number);
    if (!Number.isInteger(number) || number < 1) {
      return { error: 'Term number must be a whole number of 1 or more.' };
    }
    termNumber = number;
  }

  return {
    payload: {
      group_role: form.group_role,
      expires_at: form.expires_at || null,
      is_group_admin: form.is_group_admin === true,
      term_start_date: startDate || null,
      term_end_date: endDate || null,
      term_number: termNumber,
    },
  };
}

export function getAssignmentEditError(error) {
  const message = error?.message || '';
  const apiPrefix = /^API Error \(\d+\):\s*/;
  return message.replace(apiPrefix, '')
    || 'The assignment could not be updated. Please try again.';
}