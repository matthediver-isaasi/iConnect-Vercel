import {
  isRepeatableRowField,
  normalizeRepeatableRowField,
} from './formRepeatableRows.js';
import {
  containsFormNotListedValue,
  isFormNotListedValue,
  resolveFormNotListedDisplayValue,
} from './formNotListedChoice.js';

// The builder persists its versioned configuration in `repeatable_row` with
// `child_fields`; early drafts used config.children. Normalize both so every
// downstream renderer sees the same child schema.
function normalizeFormatField(field) {
  if (field?.config && typeof field.config === 'object' && !field.repeatable_row) {
    return { ...field, repeatable_row: field.config };
  }
  return field;
}

export function getRepeatableRowChildren(field) {
  return normalizeRepeatableRowField(normalizeFormatField(field)).children
    .filter((child) => child && child.id);
}

export function isRepeatableRowsField(field) {
  return isRepeatableRowField(field);
}

function optionLabel(child, value) {
  const options = Array.isArray(child?.options) ? child.options : [];
  const match = options.find((option) => {
    if (option && typeof option === 'object') {
      return (option.value ?? option.id ?? option.label) === value;
    }
    return option === value;
  });
  return match && typeof match === 'object'
    ? String(match.label ?? match.name ?? match.value ?? value)
    : String(value);
}

export function formatRepeatableCellValue(value, child) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) {
    return value.map((entry) => formatRepeatableCellValue(entry, child)).filter(Boolean).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([key, entry]) => key !== '_row_id' && key !== 'row_id' && entry != null && entry !== '')
      .map(([key, entry]) => `${key.replace(/_/g, ' ')}: ${formatRepeatableCellValue(entry)}`)
      .join('; ');
  }
  return optionLabel(child, value);
}

export const UNAVAILABLE_REPEATABLE_ORGANISATION = 'Unavailable organisation';

export function resolveRepeatableOrganisationLabel(value, organisationNamesById, fallback = UNAVAILABLE_REPEATABLE_ORGANISATION) {
  if (value == null || value === '') return '';
  const key = String(value);
  const label = organisationNamesById instanceof Map
    ? organisationNamesById.get(key)
    : organisationNamesById?.[key];
  return typeof label === 'string' && label.trim() ? label.trim() : fallback;
}

/**
 * Produce a renderer-neutral row/column model. _row_id (the canonical
 * renderer identity) and legacy row_id are metadata, never answer columns.
 */
export function formatRepeatableRows(field, value, options = {}) {
  const columns = getRepeatableRowChildren(field).map((child) => ({
    id: String(child.id),
    label: child.label || child.name || String(child.id),
    child,
  }));
  const inputRows = Array.isArray(value)
    ? value.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    : [];
  const formatCell = options.formatCell || formatRepeatableCellValue;
  const rows = inputRows.map((row, rowIndex) => ({
    rowId: row._row_id ?? row.row_id ?? `row-${rowIndex + 1}`,
    cells: columns.map(({ id, child }) => {
      const rawValue = row[id];
      const displayValue = containsFormNotListedValue(rawValue)
        ? resolveFormNotListedDisplayValue(child, rawValue, options.submissionData, { parentField: field, row })
        : rawValue;
      const formatted = containsFormNotListedValue(rawValue)
        ? formatRepeatableCellValue(displayValue, child)
        : child.type === 'organisation_dropdown' && options.organisationNamesById
        ? (Array.isArray(rawValue)
          ? rawValue.map((entry) => resolveRepeatableOrganisationLabel(entry, options.organisationNamesById)).join(', ')
          : resolveRepeatableOrganisationLabel(rawValue, options.organisationNamesById))
        : formatCell(rawValue, child, row, rowIndex);
      return formatted == null ? '' : String(formatted);
    }),
  }));
  return { columns, rows };
}

export function formatRepeatableRowsText(field, value, options = {}) {
  const { columns, rows } = formatRepeatableRows(field, value, options);
  if (!rows.length) return '';
  return rows.map((row, rowIndex) => {
    const cells = columns.map((column, columnIndex) =>
      `${column.label}: ${row.cells[columnIndex] || options.emptyValue || '-'}`);
    return [`Row ${rowIndex + 1}`, ...cells].join('\n');
  }).join('\n\n');
}

export function collectRepeatableRelationshipRecordIds(fields, submissionData) {
  const ids = new Set();
  for (const field of fields || []) {
    if (!isRepeatableRowsField(field)) continue;
    const children = getRepeatableRowChildren(field);
    const relationshipChildren = children.filter((child) => child.type === 'relationship_dropdown');
    if (!relationshipChildren.length) continue;
    const value = field.id != null && submissionData?.[field.id] !== undefined
      ? submissionData[field.id]
      : submissionData?.[field.name];
    for (const row of Array.isArray(value) ? value : []) {
      if (!row || typeof row !== 'object') continue;
      for (const child of relationshipChildren) {
        const entries = Array.isArray(row[child.id]) ? row[child.id] : [row[child.id]];
        for (const entry of entries) {
          if (entry != null && entry !== '' && !isFormNotListedValue(entry)) ids.add(String(entry));
        }
      }
    }
  }
  return [...ids];
}

export function collectRepeatableOrganisationIds(fields, submissionData) {
  const ids = new Set();
  for (const field of fields || []) {
    if (!isRepeatableRowsField(field)) continue;
    const organisationChildren = getRepeatableRowChildren(field)
      .filter((child) => child.type === 'organisation_dropdown');
    const value = field.id != null && submissionData?.[field.id] !== undefined
      ? submissionData[field.id] : submissionData?.[field.name];
    for (const row of Array.isArray(value) ? value : []) {
      for (const child of organisationChildren) {
        for (const entry of (Array.isArray(row?.[child.id]) ? row[child.id] : [row?.[child.id]])) {
          if (entry != null && entry !== '' && !isFormNotListedValue(entry)) ids.add(String(entry));
        }
      }
    }
  }
  return [...ids];
}