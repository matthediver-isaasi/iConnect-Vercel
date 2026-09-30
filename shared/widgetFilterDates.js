const DATE_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date.toISOString().slice(0, 10);
}

export function isWidgetDateOperator(operator) {
  return DATE_OPERATORS.has(operator);
}

export function normalizeWidgetDate(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  if (match) return calendarDate(Number(match[3]), Number(match[2]), Number(match[1]));

  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (match) return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));

  // Preserve the dashboard's existing Date.parse-compatible ISO timestamp
  // inputs, including timezone-less values and database-style space
  // separators. The leading calendar date is still checked strictly so JS
  // rollover parsing cannot turn 31 February into a March timestamp.
  match = /^(\d{4})-(\d{2})-(\d{2})(?:T| )\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.exec(input);
  if (!match || !calendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function widgetDateError(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'Enter a date in DD/MM/YYYY or ISO format.';
  }
  return normalizeWidgetDate(value)
    ? null
    : 'Enter a valid calendar date in DD/MM/YYYY or ISO format.';
}