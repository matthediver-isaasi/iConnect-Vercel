import { getSubmissionFieldValue, resolveSubmissionField, formatRelationshipAnswerDisplayValue } from './relationshipDisplayLabels.js';
import { containsFormNotListedValue, resolveFormNotListedDisplayValue } from '../../../shared/formNotListedChoice.js';
import { getRepeatableRowChildren, formatRepeatableCellValue } from '../../../shared/repeatableFormRowsFormat.js';
import { isRepeatableRowField } from '../../../shared/formRepeatableRows.js';
import { isDistinctRowSource } from '../../../shared/formCustomObjectRowSources.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const metadataKey = key => /^(?:_|row_id$|id$|.*_id$|.*_ids$)/i.test(key);
const readableParts = new Set(['label', 'name', 'text', 'first_name', 'last_name', 'line1', 'line2', 'address_line_1', 'address_line_2', 'city', 'town', 'state', 'county', 'postcode', 'postal_code', 'country']);

// Unknown objects are not recursively serialized: they may contain payment,
// prefill or reference metadata. Keep legacy scalar answers, not their keys.
function readable(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).filter(([key]) => readableParts.has(key))
      .map(([, part]) => readable(part)).filter(Boolean).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return uuid.test(String(value)) ? '' : String(value);
}

function answerText(field, value, data, context, rowOptions = {}) {
  if (field?.type === 'relationship_dropdown' && !isDistinctRowSource(field)) {
    return formatRelationshipAnswerDisplayValue(field, value, context.relationshipLabelsByRecordId, data, rowOptions);
  }
  if (Array.isArray(value)) return value.map(entry => answerText(field, entry, data, context, rowOptions)).filter(Boolean).join(', ');
  if (containsFormNotListedValue(value)) return readable(resolveFormNotListedDisplayValue(field, value, data, rowOptions));
  const referenceMaps = {
    organisation_dropdown: context.organisationNamesById,
    organisation_group_dropdown: context.organisationGroupNamesById,
    member_dropdown: context.memberNamesById,
    role_dropdown: context.roleNamesById,
  };
  if (Object.hasOwn(referenceMaps, field?.type)) return readable(referenceMaps[field.type]?.[value]);
  if (field?.type === 'communication_preferences') {
    return Object.entries(value || {}).filter(([, subscribed]) => subscribed === true)
      .map(([id]) => readable(context.communicationCategoryNamesById?.[id])).filter(Boolean).join(', ');
  }
  if (field?.type === 'file') {
    // Search a displayed filename, never a storage URL, signed token or path.
    return value && typeof value === 'object' ? readable(value.name || value.filename) : '';
  }
  if (['signature', 'payment', 'hidden', 'heading', 'paragraph', 'html', 'section'].includes(field?.type)) return '';
  if (['category_dropdown', 'category_multiselect'].includes(field?.type)) {
    return readable(context.resourceCategoryNamesById?.[value] || value);
  }
  if (field?.type === 'custom_field' && value != null && typeof value !== 'object') {
    const definition = context.customFieldDefById?.[field.custom_field_id];
    return readable(formatRepeatableCellValue(value, definition || field));
  }
  if (value != null && typeof value !== 'object') {
    return readable(formatRepeatableCellValue(value, field?.type === 'image_buttons'
      ? { ...field, options: field.image_options } : field));
  }
  return readable(value);
}

export function submissionSearchAnswers(submission, form, context = {}) {
  const data = submission?.submission_data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const answers = [];
  const add = (field, value, label, options) => {
    const text = answerText(field, value, data, context, options).replace(/\s+/g, ' ').trim();
    if (text) answers.push({ field: label, value: text });
  };
  for (const field of fields) {
    const value = getSubmissionFieldValue(data, field);
    const label = field.label || field.name || 'Answer';
    if (isRepeatableRowField(field)) {
      (Array.isArray(value) ? value : []).forEach((row, index) => {
        for (const child of getRepeatableRowChildren(field)) {
          add(child, row?.[child.id], `${label} · Row ${index + 1} · ${child.label || child.name || 'Answer'}`, { parentField: field, row });
        }
      });
    } else add(field, value, label);
  }
  for (const [key, value] of Object.entries(data)) {
    if (metadataKey(key) || resolveSubmissionField(fields, key)) continue;
    // No schema means only legacy scalars/scalar arrays can be trusted.
    if (value && typeof value === 'object' && (!Array.isArray(value) || value.some(v => v && typeof v === 'object'))) continue;
    add(undefined, value, key);
  }
  return answers;
}

export function matchSubmissionSearch(submission, form, query, context = {}) {
  const needle = String(query || '').toLowerCase();
  if (!needle) return { matches: true, excerpt: null };
  if ([submission?.form_name || form?.name || 'Unknown Form', submission?.submitted_by_name, submission?.submitted_by_email]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(needle))) {
    return { matches: true, excerpt: null };
  }
  const answer = submissionSearchAnswers(submission, form, context)
    .find(({ value }) => value.toLowerCase().includes(needle));
  if (!answer) return { matches: false, excerpt: null };
  const index = answer.value.toLowerCase().indexOf(needle);
  const start = Math.max(0, index - 45);
  const end = Math.min(answer.value.length, Math.max(start + 160, index + needle.length));
  return {
    matches: true,
    excerpt: { field: answer.field, value: `${start ? '…' : ''}${answer.value.slice(start, end)}${end < answer.value.length ? '…' : ''}` },
  };
}