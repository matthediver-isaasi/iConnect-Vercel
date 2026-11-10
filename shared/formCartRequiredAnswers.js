import { isAddressLookupAnswerFilled } from './formAddressLookup.js';

const displayOnly = new Set(['instructions', 'image', 'section_header', 'heading', 'paragraph',
  'divider', 'spacer', 'html', 'payment']);
const empty = value => value == null || value === '' || (typeof value === 'string' && !value.trim())
  || (Array.isArray(value) && !value.length);

// Cart checkout enforces ordinary required answers before creating any payment.
// Repeatable-row, relationship and date validation remain in their shared
// authoritative validators; this covers the basic required-field boundary.
export function missingCartRequiredAnswers(form, values, hiddenFieldIds = new Set()) {
  return (form.fields || []).filter(field => {
    if (hiddenFieldIds.has(field.id) || displayOnly.has(field.type) || field.type === 'sales_cart') return false;
    const value = values[field.id];
    if (field.type === 'terms_conditions') return value !== true;
    if (!field.required) return false;
    if (field.type === 'address_lookup') return !isAddressLookupAnswerFilled(field, value);
    if (empty(value)) return true;
    if (field.type === 'contact') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
      const defaults = { firstName: true, lastName: true, email: true, jobTitle: false, organisation: false };
      return Object.entries(defaults).some(([key, required]) => {
        const setting = field.contact_sub_fields?.[key];
        return setting?.visible !== false && (setting?.required ?? required)
          && (typeof value[key] !== 'string' || !value[key].trim());
      });
    }
    if (field.type === 'grouped_question') {
      const questions = field.sub_questions || [];
      const minimum = Number.isFinite(Number(field.min_completed))
        ? Math.max(0, Math.min(Number(field.min_completed), questions.length)) : questions.length;
      return questions.filter(question => typeof value?.[question.id] === 'string' && value[question.id].trim()).length < minimum;
    }
    return typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length;
  }).map(field => field.id);
}
