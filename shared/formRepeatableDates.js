const DATE_PRECISIONS = new Set(['day', 'month', 'year']);
const DATE_RESTRICTIONS = new Set(['any', 'future', 'past']);

const DATE_ERROR_MESSAGES = {
  day: 'Enter a valid date in YYYY-MM-DD format.',
  month: 'Enter a valid month in YYYY-MM format.',
  year: 'Enter a valid year in YYYY format.',
};

const RESTRICTION_HELP = {
  any: {
    day: 'Enter a date.',
    month: 'Enter a month.',
    year: 'Enter a year.',
  },
  future: {
    day: 'Choose a date in the future.',
    month: 'Choose a month in the future.',
    year: 'Choose a year in the future.',
  },
  past: {
    day: 'Choose today or an earlier date.',
    month: 'Choose the current month or an earlier month.',
    year: 'Choose the current year or an earlier year.',
  },
};

function hasOwn(field, key) {
  return field != null && Object.prototype.hasOwnProperty.call(field, key);
}

function configurationError(message) {
  return message;
}

/**
 * Resolve the versioned settings for a repeatable date child.
 *
 * Legacy future_only/past_only flags are deliberately only consulted when
 * date_restriction is absent. Explicit values are never silently corrected.
 */
export function repeatableDateSettings(field = {}) {
  const precisionValue = hasOwn(field, 'date_precision') ? field.date_precision : 'day';
  const hasRestriction = hasOwn(field, 'date_restriction');
  const restrictionValue = hasOwn(field, 'date_restriction')
    ? field.date_restriction
    : undefined;
  const futureOnly = field.future_only === true;
  const pastOnly = field.past_only === true;

  let precision = DATE_PRECISIONS.has(precisionValue) ? precisionValue : 'day';
  let restriction;
  let error = null;

  if (!DATE_PRECISIONS.has(precisionValue)) {
    error = configurationError(
      'date_precision must be one of: day, month, year.',
    );
  }

  if (hasRestriction) {
    if (!DATE_RESTRICTIONS.has(restrictionValue)) {
      error ||= configurationError(
        'date_restriction must be one of: any, future, past.',
      );
      restriction = 'any';
    } else {
      restriction = restrictionValue;
    }
  } else if (futureOnly && pastOnly) {
    restriction = 'any';
    error ||= configurationError(
      'future_only and past_only cannot both be enabled.',
    );
  } else if (futureOnly) {
    restriction = 'future';
  } else if (pastOnly) {
    restriction = 'past';
  } else {
    restriction = 'any';
  }

  if (restrictionValue !== undefined && DATE_RESTRICTIONS.has(restrictionValue)) {
    if (futureOnly && restrictionValue !== 'future') {
      error ||= configurationError(
        'date_restriction contradicts future_only.',
      );
    }
    if (pastOnly && restrictionValue !== 'past') {
      error ||= configurationError(
        'date_restriction contradicts past_only.',
      );
    }
    if (futureOnly && pastOnly) {
      error ||= configurationError(
        'future_only and past_only cannot both be enabled.',
      );
    }
  }

  return { precision, restriction, error };
}

function utcDateParts(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid Date');
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31][month - 1] || 0;
}

function dateParts(value, precision) {
  if (typeof value !== 'string') return null;
  const pattern = precision === 'day'
    ? /^(\d{4})-(\d{2})-(\d{2})$/
    : precision === 'month'
      ? /^(\d{4})-(\d{2})$/
      : /^(\d{4})$/;
  const match = pattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = precision === 'year' ? null : Number(match[2]);
  const day = precision === 'day' ? Number(match[3]) : null;
  if (year < 1 || year > 9999) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && (day < 1 || day > daysInMonth(year, month))) return null;
  return { year, month, day };
}

function formatParts(parts, precision) {
  if (parts.year < 1 || parts.year > 9999) return null;
  const year = String(parts.year).padStart(4, '0');
  if (precision === 'year') return year;
  const month = String(parts.month).padStart(2, '0');
  if (precision === 'month') return `${year}-${month}`;
  return `${year}-${month}-${String(parts.day).padStart(2, '0')}`;
}

function shiftUtcDay(parts, amount) {
  // Date.UTC treats years 0–99 as 1900–1999. Setting the full year
  // separately avoids that legacy behaviour while retaining Gregorian maths.
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCDate(date.getUTCDate() + amount);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function shiftUtcMonth(parts, amount) {
  const index = parts.year * 12 + (parts.month - 1) + amount;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month, day: 1 };
}

function periodParts(now, precision, amount) {
  const current = utcDateParts(now);
  if (precision === 'year') return { year: current.year + amount };
  if (precision === 'month') return shiftUtcMonth(current, amount);
  return shiftUtcDay(current, amount);
}

function comparisonValue(parts, precision) {
  if (precision === 'year') return parts.year;
  if (precision === 'month') return parts.year * 12 + parts.month;
  return parts.year * 372 + parts.month * 31 + parts.day;
}

/**
 * Return native date-input limits for a repeatable date child. Null means
 * there is no bound. Past includes the current UTC period; future excludes it.
 */
export function repeatableDateLimits(field, { now = new Date() } = {}) {
  const settings = repeatableDateSettings(field);
  if (settings.error) return { min: null, max: null };
  if (settings.restriction === 'any') return { min: null, max: null };
  if (settings.restriction === 'future') {
    return {
      min: formatParts(periodParts(now, settings.precision, 1), settings.precision),
      max: null,
    };
  }
  return { min: null, max: formatParts(utcDateParts(now), settings.precision) };
}

export function repeatableDateError(field, value, { now = new Date() } = {}) {
  if (field?.type !== 'date' || value === undefined || value === null || value === '') {
    return null;
  }
  const settings = repeatableDateSettings(field);
  if (settings.error) return settings.error;
  const valueParts = dateParts(value, settings.precision);
  if (!valueParts) return DATE_ERROR_MESSAGES[settings.precision];
  if (settings.restriction === 'any') return null;

  const current = utcDateParts(now);
  const valueComparison = comparisonValue(valueParts, settings.precision);
  const currentComparison = comparisonValue(current, settings.precision);
  if (settings.restriction === 'future' && valueComparison <= currentComparison) {
    return 'Date must be in the future.';
  }
  if (settings.restriction === 'past' && valueComparison > currentComparison) {
    return {
      day: 'Date must be today or earlier (UTC).',
      month: 'Month must be the current month or earlier (UTC).',
      year: 'Year must be the current year or earlier (UTC).',
    }[settings.precision];
  }
  return null;
}

export function repeatableDateHelp(field) {
  const settings = repeatableDateSettings(field);
  if (settings.error) return settings.error;
  const help = RESTRICTION_HELP[settings.restriction][settings.precision];
  if (settings.restriction === 'any') return help;
  const period = { day: 'Today', month: 'The current month', year: 'The current year' }[settings.precision];
  return `${help} ${period} is ${settings.restriction === 'past' ? 'included' : 'excluded'}. Dates are compared in UTC.`;
}
