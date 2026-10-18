// Date-only values must not pass through local-time conversion.
export function formatRecordDate(value) {
  const text = String(value ?? "");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

export function parseRecordDateInput(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  // Keep incomplete/invalid input visible; existing record validation rejects it.
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

export function formatCompactRecordField(field) {
  return field?.field_type === "date" && field.value
    ? formatRecordDate(field.value)
    : field?.value;
}
