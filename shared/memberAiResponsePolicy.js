// Tenant-owned answer preferences. These never determine retrieval, access, or evidence rules.
export const DEFAULT_RESPONSE_POLICY = Object.freeze({
  role: '',
  tone: '',
  answerLength: 'balanced',
  clarification: 'when_needed',
  multipleApproaches: false,
  nextSteps: false,
  terminology: Object.freeze([]),
  additionalInstructions: '',
  specialistTopics: '',
  escalationInstructions: '',
  escalationName: '',
  escalationUrl: '',
  escalationEmail: '',
});

const limits = {
  role: 1000, tone: 500, additionalInstructions: 3000,
  specialistTopics: 1000, escalationInstructions: 1000,
  escalationName: 120, escalationUrl: 2048, escalationEmail: 254,
};
const multilineControl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const singleLineControl = /[\x00-\x1f\x7f-\x9f]/;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validUrl(value) {
  if (!value) return true;
  if (/[\x00-\x20\x7f\\<>]/.test(value) || !/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function text(value, max, label, singleLine = false) {
  if (typeof value !== 'string' || value.length > max ||
      (singleLine ? singleLineControl : multilineControl).test(value)) {
    throw new Error(`Invalid responsePolicy.${label}`);
  }
  return value.trim();
}

// Accept partial updates, reject malformed or unknown fields. The caller merges
// the validated fields with the existing persisted policy.
export function validateResponsePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('responsePolicy must be an object');
  }
  const result = {};
  for (const [field, input] of Object.entries(value)) {
    if (!hasOwn(DEFAULT_RESPONSE_POLICY, field)) {
      throw new Error(`Unknown responsePolicy field: ${field}`);
    }
    if (hasOwn(limits, field)) {
      result[field] = text(input, limits[field], field, ['escalationName', 'escalationUrl', 'escalationEmail'].includes(field));
      if (field === 'escalationUrl' && !validUrl(result[field])) {
        throw new Error('responsePolicy.escalationUrl must be an HTTPS URL');
      }
      if (field === 'escalationEmail' && result[field] &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result[field])) {
        throw new Error('Invalid responsePolicy.escalationEmail');
      }
    } else if (field === 'terminology') {
      if (!Array.isArray(input) || input.length > 30) throw new Error('Invalid responsePolicy.terminology');
      result[field] = input.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            Object.keys(entry).some((key) => !['term', 'preferred'].includes(key)) ||
            !hasOwn(entry, 'term') || !hasOwn(entry, 'preferred')) {
          throw new Error('Invalid responsePolicy.terminology');
        }
        const term = text(entry.term, 100, 'terminology.term');
        const preferred = text(entry.preferred, 100, 'terminology.preferred');
        if (!term || !preferred) throw new Error('Invalid responsePolicy.terminology');
        return { term, preferred };
      });
    } else if (field === 'answerLength') {
      if (!['concise', 'balanced', 'detailed'].includes(input)) throw new Error('Invalid responsePolicy.answerLength');
      result[field] = input;
    } else if (field === 'clarification') {
      if (!['when_needed', 'ask_first', 'answer_directly'].includes(input)) throw new Error('Invalid responsePolicy.clarification');
      result[field] = input;
    } else {
      if (typeof input !== 'boolean') throw new Error(`responsePolicy.${field} must be a boolean`);
      result[field] = input;
    }
  }
  return result;
}

// Existing/malformed tenant JSON must never leak malformed instructions to the model.
export function normalizeResponsePolicy(value) {
  const result = { ...DEFAULT_RESPONSE_POLICY, terminology: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const field of Object.keys(result)) {
    if (!hasOwn(value, field)) continue;
    try {
      result[field] = validateResponsePolicy({ [field]: value[field] })[field];
    } catch {
      // Legacy values fall back independently, without discarding valid fields.
    }
  }
  return result;
}