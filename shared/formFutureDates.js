import {
  isRepeatableRowField,
  repeatableRowChildren,
} from './formRepeatableRows.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isEmptyAnswer(value) {
  return value === undefined || value === null || value === '';
}

function isSameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => isSameValue(item, right[index]));
  }
  if (left && typeof left === 'object' && right && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
        && isSameValue(left[key], right[key]));
  }
  return false;
}

export function sameFormAnswerValues(left, right) {
  return isSameValue(left, right);
}

function valueForField(values, field) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || !field) {
    return undefined;
  }
  if (field.id != null && Object.prototype.hasOwnProperty.call(values, field.id)) {
    return values[field.id];
  }
  if (field.name != null && Object.prototype.hasOwnProperty.call(values, field.name)) {
    return values[field.name];
  }
  return undefined;
}

function validCalendarDate(value) {
  const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function utcDateParts(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

/**
 * Return tomorrow in UTC using the native date-input representation.
 */
export function tomorrowUtcDate(now = new Date()) {
  const parts = utcDateParts(now);
  const tomorrow = new Date(Date.UTC(parts.year, parts.month, parts.day + 1));
  return [
    String(tomorrow.getUTCFullYear()).padStart(4, '0'),
    String(tomorrow.getUTCMonth() + 1).padStart(2, '0'),
    String(tomorrow.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Validate one saved form date field. Empty values deliberately return null:
 * required/optional handling belongs to the form's existing validator.
 */
export function futureDateError(field, value, { now = new Date() } = {}) {
  if (field?.type !== 'date' || field?.future_only !== true || isEmptyAnswer(value)) {
    return null;
  }
  if (!validCalendarDate(value)) {
    return 'Enter a valid date in YYYY-MM-DD format.';
  }
  if (value < tomorrowUtcDate(now)) {
    return 'Date must be in the future.';
  }
  return null;
}

function legacyRepeatableRowContent(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const content = { ...row };
  delete content._row_id;
  return content;
}

function sameLegacyRepeatableRowContent(left, right) {
  return sameFormAnswerValues(
    legacyRepeatableRowContent(left),
    legacyRepeatableRowContent(right),
  );
}

function canonicalFutureDateRowValue(value) {
  if (Array.isArray(value)) return value.map(canonicalFutureDateRowValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalFutureDateRowValue(value[key])]),
    );
  }
  if (typeof value === 'number' && Number.isNaN(value)) return '__NaN__';
  if (value === undefined) return '__undefined__';
  return value;
}

function futureDateRowContentKey(row) {
  return JSON.stringify(canonicalFutureDateRowValue(legacyRepeatableRowContent(row)));
}

function futureDateRowHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function hasFutureOnlyRepeatableDate(field) {
  return isRepeatableRowField(field)
    && repeatableRowChildren(field).some((child) => (
      child?.type === 'date' && child.future_only === true
    ));
}

/**
 * Assign deterministic IDs to legacy repeatable rows only when the container
 * has future-only dates. The content hash plus occurrence is stable across
 * renderer reloads and reorder operations, while rows already carrying an ID
 * (including newly-created random IDs) remain untouched.
 */
export function ensureFutureDateRowIds(rows, field) {
  if (!hasFutureOnlyRepeatableDate(field) || !Array.isArray(rows)) return rows;
  const occurrences = new Map();
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || (typeof row._row_id === 'string' && row._row_id.trim())) {
      return row;
    }
    const contentKey = futureDateRowContentKey(row);
    const occurrence = occurrences.get(contentKey) || 0;
    occurrences.set(contentKey, occurrence + 1);
    return {
      ...row,
      _row_id: `legacy_${futureDateRowHash(contentKey)}_${occurrence}`,
    };
  });
}

function previousRepeatableRow(rows, currentRow, matchedIndexes = new Set()) {
  if (!Array.isArray(rows) || !currentRow || typeof currentRow !== 'object') return null;
  if (typeof currentRow._row_id === 'string' && currentRow._row_id) {
    const indexed = rows.findIndex((row, index) => !matchedIndexes.has(index)
      && row && typeof row === 'object'
      && row._row_id === currentRow._row_id);
    if (indexed >= 0) {
      matchedIndexes.add(indexed);
      return rows[indexed];
    }
  }

  // Legacy repeatable rows predate stable _row_id values. A current renderer
  // row may have a generated ID even when its persisted counterpart does not,
  // so match exact row content while ignoring IDs as a one-to-one multiset.
  // This deliberately has no positional fallback: deletion/reordering must
  // not exempt a newly added or changed row from date validation.
  const identicalIndex = rows.findIndex((row, index) => !matchedIndexes.has(index)
    && sameLegacyRepeatableRowContent(row, currentRow));
  if (identicalIndex >= 0) {
    matchedIndexes.add(identicalIndex);
    return rows[identicalIndex];
  }
  return null;
}

function errorForValue(field, value, context) {
  const message = futureDateError(field, value, context);
  return message ? { message } : null;
}

/**
 * Validate all visible future-only native date answers in a form.
 *
 * Repeatable child errors retain the container field ID and add child_id and
 * the submitted row index. When previousValues is supplied, unchanged answers
 * are skipped. Repeatable rows are matched by stable _row_id values where
 * available, including deterministic IDs synthesized for legacy future-date
 * rows, or by one-to-one exact content for legacy rows, never by their current
 * array position.
 */
export function validateFutureDateFields(
  fields,
  values,
  {
    now = new Date(),
    hiddenFieldIds = new Set(),
    previousValues,
  } = {},
) {
  const errors = [];
  const hidden = hiddenFieldIds instanceof Set
    ? hiddenFieldIds
    : new Set(hiddenFieldIds || []);
  const formFields = Array.isArray(fields) ? fields : [];
  const hasPrevious = previousValues !== undefined;

  for (const field of formFields) {
    if (!field?.id || hidden.has(field.id)) continue;
    if (isRepeatableRowField(field)) {
      const children = repeatableRowChildren(field);
      const rawRows = valueForField(values, field);
      const rows = ensureFutureDateRowIds(rawRows, field);
      const previousRows = hasPrevious
        ? ensureFutureDateRowIds(valueForField(previousValues, field), field)
        : undefined;
      const matchedPreviousRows = new Set();
      if (!Array.isArray(rows)) continue;

      rows.forEach((row, rowIndex) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return;
        const oldRow = hasPrevious
          ? previousRepeatableRow(previousRows, row, matchedPreviousRows)
          : null;
        for (const child of children) {
          if (!child?.id || child.type !== 'date' || child.future_only !== true
              || hidden.has(child.id)) continue;
          const value = row[child.id];
          if (hasPrevious && oldRow && isSameValue(value, oldRow[child.id])) continue;
          const result = errorForValue(child, value, { now });
          if (result) {
            errors.push({
              field_id: field.id,
              child_id: child.id,
              row: rowIndex,
              message: result.message,
            });
          }
        }
      });
      continue;
    }

    if (field.type !== 'date' || field.future_only !== true) continue;
    const value = valueForField(values, field);
    if (hasPrevious && isSameValue(value, valueForField(previousValues, field))) continue;
    const result = errorForValue(field, value, { now });
    if (result) {
      errors.push({ field_id: field.id, message: result.message });
    }
  }

  return errors;
}
