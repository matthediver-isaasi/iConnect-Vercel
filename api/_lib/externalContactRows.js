const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const EXTERNAL_CONTACT_SOURCES = new Set([
  'individual',
  'csv_upload',
  'pasted_rows',
]);

export function normalizeExternalContactEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateExternalContactRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { valid: false, errors: ['Row must be an object'] };
  }

  const firstName = typeof row.first_name === 'string' ? row.first_name.trim() : '';
  const lastName = typeof row.last_name === 'string' ? row.last_name.trim() : '';
  const email = typeof row.email === 'string' ? row.email.trim() : '';
  const normalizedEmail = normalizeExternalContactEmail(email);
  const errors = [];

  if (!firstName) errors.push('First name is required');
  if (!lastName) errors.push('Last name is required');
  if (!email) {
    errors.push('Email is required');
  } else if (!EMAIL_PATTERN.test(normalizedEmail)) {
    errors.push('Email is invalid');
  }

  return {
    valid: errors.length === 0,
    errors,
    value: {
      first_name: firstName,
      last_name: lastName,
      email,
      normalized_email: normalizedEmail,
    },
  };
}

export function analyzeExternalContactRows(rows, existingEmails = []) {
  const existing = new Set(
    existingEmails.map(normalizeExternalContactEmail).filter(Boolean),
  );
  const seen = new Set();

  return rows.map((row, index) => {
    const validation = validateExternalContactRow(row);
    const result = {
      index,
      row,
      normalized_email: validation.value?.normalized_email || '',
      status: 'invalid',
      errors: validation.errors,
    };

    if (!validation.valid) return result;

    result.value = validation.value;
    result.errors = [];
    if (seen.has(validation.value.normalized_email)) {
      result.status = 'duplicate_input';
    } else if (existing.has(validation.value.normalized_email)) {
      result.status = 'duplicate_existing';
    } else {
      result.status = 'valid';
    }
    seen.add(validation.value.normalized_email);
    return result;
  });
}