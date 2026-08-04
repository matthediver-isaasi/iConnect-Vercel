/**
 * Task #3330: Survey form type & Score field — server-side scoring engine.
 *
 * Pure, dependency-free helpers used by the public form-submission endpoint
 * to validate score answers against the PUBLISHED survey version snapshot
 * (never client-supplied config) and to compute normalised/weighted scores.
 *
 * Value shape for a score field in submission_data[fieldId]:
 *   { score: <integer> }  — an answered question
 *   { na: true }          — respondent chose Not Applicable
 * Legacy scalars (number / numeric string / 'NA') are tolerated.
 * Any client-supplied weight/normalised values are ignored.
 */

export const SCORE_STYLES = ['stars', 'smileys', 'numbers', 'descriptive', 'slider', 'nps'];
export const BUTTON_STYLES = ['stars', 'smileys', 'numbers', 'descriptive', 'nps'];
export const MAX_BUTTON_VALUES = 11;

export function isScoreField(field) {
  return field && field.type === 'score';
}

export function getScoreRange(field) {
  if ((field?.score_style || 'stars') === 'nps') {
    return { min: 0, max: 10 };
  }
  const min = Number.isFinite(Number(field?.score_min)) ? Math.trunc(Number(field.score_min)) : 1;
  const max = Number.isFinite(Number(field?.score_max)) ? Math.trunc(Number(field.score_max)) : 5;
  return { min, max };
}

export function getScoreWeight(field) {
  const w = Number(field?.weight);
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * Builder-side validation of one score field config.
 * Returns { errors: string[], warnings: string[] }.
 */
export function validateScoreFieldConfig(field) {
  const errors = [];
  const warnings = [];
  const style = field.score_style || 'stars';
  if (!SCORE_STYLES.includes(style)) errors.push(`Unknown rendering style "${style}"`);

  if (style !== 'nps') {
    const rawMin = field.score_min ?? 1;
    const rawMax = field.score_max ?? 5;
    if (!Number.isInteger(Number(rawMin)) || !Number.isInteger(Number(rawMax))) {
      errors.push('Minimum and maximum must be whole numbers');
    }
    const { min, max } = getScoreRange(field);
    if (max <= min) errors.push('Maximum must be greater than minimum');
    const count = max - min + 1;
    if (max > min && BUTTON_STYLES.includes(style) && count > MAX_BUTTON_VALUES) {
      errors.push(`Button-style questions support at most ${MAX_BUTTON_VALUES} values (this range has ${count})`);
    }
    if (max > min) {
      if (style === 'stars' && (min !== 1 || count > 10)) {
        warnings.push('Star rating works best with a range starting at 1 (e.g. 1–5)');
      }
      if (style === 'smileys' && (count < 3 || count > 7)) {
        warnings.push('Smiley faces work best with 3–7 values');
      }
    }
  }
  const w = Number(field.weight ?? 1);
  if (!Number.isFinite(w) || w <= 0) errors.push('Weighting must be a positive number');
  return { errors, warnings };
}

/**
 * Pre-publish validation + summary for a whole survey.
 * Returns { errors: [{field_id, message}], warnings: [{field_id, message}], summary }.
 */
export function validateSurveyForPublish(fields, surveySettings = {}) {
  const errors = [];
  const warnings = [];
  const scoreFields = (fields || []).filter(isScoreField);
  const nonScored = (fields || []).filter((f) => !isScoreField(f) && !['instructions', 'image'].includes(f.type));

  let totalWeight = 0;
  const excludedFromOverall = [];
  const missingCategory = [];

  for (const field of scoreFields) {
    const { errors: fieldErrors, warnings: fieldWarnings } = validateScoreFieldConfig(field);
    fieldErrors.forEach((message) => errors.push({ field_id: field.id, message }));
    fieldWarnings.forEach((message) => warnings.push({ field_id: field.id, message }));
    if (!field.label || !String(field.label).trim()) {
      errors.push({ field_id: field.id, message: 'Score question needs a label' });
    }
    if (field.include_in_overall !== false) {
      totalWeight += getScoreWeight(field);
    } else {
      excludedFromOverall.push(field.id);
    }
    if (!field.reporting_category || !String(field.reporting_category).trim()) {
      missingCategory.push(field.id);
    }
  }
  if (scoreFields.length === 0) {
    errors.push({ field_id: null, message: 'A survey needs at least one Score question before publishing' });
  }
  const threshold = Number(surveySettings.anonymity_threshold ?? 3);
  if (!Number.isFinite(threshold) || threshold < 0) {
    errors.push({ field_id: null, message: 'Anonymity threshold must be zero or a positive number' });
  }
  return {
    errors,
    warnings,
    summary: {
      scoredCount: scoreFields.length,
      nonScoredCount: nonScored.length,
      totalWeight,
      excludedFromOverall,
      missingCategory
    }
  };
}

/**
 * Field types whose values inherently carry respondent identity. Used to
 * redact anonymous survey submissions before persistence.
 */
export const IDENTITY_FIELD_TYPES = [
  'email', 'tel', 'contact', 'signature', 'file',
  'user_name', 'user_email', 'user_organization', 'user_job_title'
];

const IDENTITY_NAME_RE = /(e-?mail|phone|mobile|telephone|first.?name|last.?name|full.?name|surname|your.?name|contact)/i;

/**
 * Anonymous surveys must store NO respondent identity. Removes values for
 * identity-typed fields and fields whose id/label looks identity-bearing.
 * Returns { data, redactedFieldIds }.
 */
export function redactIdentityAnswers(fields = [], submissionData = {}) {
  const byId = new Map((fields || []).map((f) => [f.id, f]));
  const data = {};
  const redactedFieldIds = [];
  for (const [fieldId, value] of Object.entries(submissionData || {})) {
    const field = byId.get(fieldId);
    const label = field ? `${field.label || ''} ${fieldId}` : fieldId;
    const isIdentity = (field && IDENTITY_FIELD_TYPES.includes(field.type)) || IDENTITY_NAME_RE.test(label);
    if (isIdentity) {
      redactedFieldIds.push(fieldId);
    } else {
      data[fieldId] = value;
    }
  }
  return { data, redactedFieldIds };
}

/**
 * Final anonymity pass over a form_submission record before insert.
 * Nulls EVERY identity-bearing column — member identity, network metadata
 * (IP address, user agent) and any linkage ids that could identify the
 * respondent. Belt-and-braces: applied on top of answer redaction so no
 * construction path can reintroduce identity columns.
 */
export const ANONYMOUS_STRIPPED_COLUMNS = [
  'submitted_by_email', 'submitted_by_name', 'member_id', 'created_member_id',
  'ip_address', 'user_agent', 'metadata',
  // Linkage foreign keys / contextual identifiers: any of these can tie an
  // "anonymous" response back to a specific organisation, contract, vacancy,
  // event, brief or role — including client-supplied prefill linkage.
  'organization_id', 'created_organization_id', 'contract_instance_id',
  'vacancy_id', 'event_id', 'brief_id', 'role_id'
];

export function anonymizeSubmissionRecord(record = {}) {
  const out = { ...record };
  for (const col of ANONYMOUS_STRIPPED_COLUMNS) {
    if (col in out) out[col] = null;
  }
  // Never let these sneak in even when absent from the source record —
  // explicit nulls beat column defaults / triggers elsewhere.
  out.submitted_by_email = null;
  out.submitted_by_name = null;
  out.ip_address = null;
  out.user_agent = null;
  return out;
}

/** Parse a submitted score answer. Ignores any client-supplied weights. */
export function parseScoreAnswer(value) {
  if (value === undefined || value === null || value === '') return { answered: false };
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (value.na === true) return { answered: true, na: true };
    if (value.score === undefined || value.score === null || value.score === '') return { answered: false };
    const n = Number(value.score);
    return Number.isInteger(n) ? { answered: true, na: false, score: n } : { answered: true, invalid: true };
  }
  if (typeof value === 'string' && value.trim().toUpperCase() === 'NA') return { answered: true, na: true };
  const n = Number(value);
  return Number.isInteger(n) ? { answered: true, na: false, score: n } : { answered: true, invalid: true };
}

/** Single-condition evaluation incl. numeric operators for score fields. */
export function evaluateSurveyCondition(triggerValue, operator, value) {
  const numeric = toComparableNumber(triggerValue);
  switch (operator) {
    case 'equals':
      if (Array.isArray(triggerValue)) return triggerValue.includes(value);
      if (numeric !== null && toComparableNumber(value) !== null) return numeric === toComparableNumber(value);
      return triggerValue === value;
    case 'not_equals':
      if (Array.isArray(triggerValue)) return !triggerValue.includes(value);
      if (numeric !== null && toComparableNumber(value) !== null) return numeric !== toComparableNumber(value);
      return triggerValue !== value;
    case 'contains':
      if (Array.isArray(triggerValue)) return triggerValue.includes(value);
      return typeof triggerValue === 'string' && triggerValue.includes(value);
    case 'not_empty':
      return triggerValue !== undefined && triggerValue !== null && triggerValue !== '' &&
        (!Array.isArray(triggerValue) || triggerValue.length > 0);
    case 'is_empty':
      return triggerValue === undefined || triggerValue === null || triggerValue === '' ||
        (Array.isArray(triggerValue) && triggerValue.length === 0);
    case 'greater_than':
      return numeric !== null && numeric > Number(value);
    case 'greater_than_or_equal':
      return numeric !== null && numeric >= Number(value);
    case 'less_than':
      return numeric !== null && numeric < Number(value);
    case 'less_than_or_equal':
      return numeric !== null && numeric <= Number(value);
    case 'between': {
      if (numeric === null) return false;
      let lo; let hi;
      if (Array.isArray(value)) { [lo, hi] = value; }
      else if (typeof value === 'string') { [lo, hi] = value.split(/[,–-]/).map((s) => s.trim()); }
      else if (value && typeof value === 'object') { lo = value.from; hi = value.to; }
      lo = Number(lo); hi = Number(hi);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      return numeric >= Math.min(lo, hi) && numeric <= Math.max(lo, hi);
    }
    default:
      return false;
  }
}

/** Score answers ({score}/{na}) and numeric strings compare numerically. */
export function toComparableNumber(triggerValue) {
  let v = triggerValue;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.na === true) return null;
    v = v.score;
  }
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function evaluateRule(rule, values) {
  const conditions = Array.isArray(rule.conditions) && rule.conditions.length > 0
    ? rule.conditions
    : (rule.trigger_field_id ? [{ field_id: rule.trigger_field_id, operator: rule.operator, value: rule.value }] : []);
  if (conditions.length === 0) return false;
  const results = conditions.map((c) => evaluateSurveyCondition(values[c.field_id], c.operator, c.value));
  return (rule.logic || 'AND').toUpperCase() === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Server-side mirror of the client hidden-field computation (starts_hidden +
 * visibility rules with show/hide semantics + hidden pages cascading).
 */
export function computeHiddenFieldIds(fields = [], pages = [], visibilityRules = [], values = {}) {
  const pageIds = new Set(pages.map((p) => p.id));
  const hiddenFields = new Set();
  const hiddenPages = new Set();
  for (const f of fields) if (f.starts_hidden === true || f.starts_hidden === 'true') hiddenFields.add(f.id);
  for (const p of pages) if (p.starts_hidden === true || p.starts_hidden === 'true') hiddenPages.add(p.id);

  const fieldVisibility = {};
  const pageVisibility = {};
  const bucket = (map, id) => (map[id] = map[id] || { show: [], hide: [] });
  for (const rule of visibilityRules || []) {
    if (!rule || (!rule.conditions?.length && !rule.trigger_field_id)) continue;
    if (rule.rule_type && rule.rule_type !== 'visibility') continue;
    const met = evaluateRule(rule, values);
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    for (const action of actions) {
      if (action.action_type === 'visibility' && action.field_states) {
        for (const [targetId, state] of Object.entries(action.field_states)) {
          const map = pageIds.has(targetId) ? pageVisibility : fieldVisibility;
          const b = bucket(map, targetId);
          if (state.visible === true) b.show.push(met);
          else if (state.visible === false) b.hide.push(met);
        }
      } else if ((action.action_type === 'show' || action.action_type === 'hide') && action.target_field_ids?.length) {
        for (const id of action.target_field_ids) {
          const b = bucket(fieldVisibility, id);
          (action.action_type === 'show' ? b.show : b.hide).push(met);
        }
      }
    }
    if (actions.length === 0 && rule.target_field_ids?.length && (rule.action === 'show' || rule.action === 'hide')) {
      for (const id of rule.target_field_ids) {
        const b = bucket(fieldVisibility, id);
        (rule.action === 'show' ? b.show : b.hide).push(met);
      }
    }
  }
  for (const [id, { show, hide }] of Object.entries(fieldVisibility)) {
    if (show.some(Boolean)) hiddenFields.delete(id);
    if (hide.some(Boolean)) hiddenFields.add(id);
  }
  for (const [id, { show, hide }] of Object.entries(pageVisibility)) {
    if (show.some(Boolean)) hiddenPages.delete(id);
    if (hide.some(Boolean)) hiddenPages.add(id);
  }
  if (hiddenPages.size > 0) {
    for (const f of fields) if (f.page_id && hiddenPages.has(f.page_id)) hiddenFields.add(f.id);
  }
  return hiddenFields;
}

/**
 * Validate + score a survey submission against a published version snapshot.
 *
 * Returns { errors: string[], answers: [...], overallWeighted, overallUnweighted }.
 * Denominator exclusions: N/A answers, hidden questions, optional unanswered
 * questions, and questions with include_in_overall === false.
 */
export function scoreSubmission(version, submissionData = {}) {
  const fields = Array.isArray(version.fields) ? version.fields : [];
  const pages = Array.isArray(version.pages) ? version.pages : [];
  const rules = Array.isArray(version.visibility_rules) ? version.visibility_rules : [];
  const errors = [];
  const answers = [];

  const knownFieldIds = new Set(fields.map((f) => f.id));
  const scoreFieldIds = new Set(fields.filter(isScoreField).map((f) => f.id));
  for (const key of Object.keys(submissionData)) {
    if (key === 'signer_email') continue;
    if (!knownFieldIds.has(key)) {
      errors.push(`Answer supplied for a question that is not part of this survey (${key})`);
    } else if (!scoreFieldIds.has(key)) {
      const v = submissionData[key];
      if (v && typeof v === 'object' && !Array.isArray(v) && ('score' in v || 'na' in v)) {
        errors.push(`Score answer supplied for a non-score question (${key})`);
      }
    }
  }

  const hidden = computeHiddenFieldIds(fields, pages, rules, submissionData);
  let weightedNumerator = 0;
  let weightedDenominator = 0;
  let unweightedSum = 0;
  let unweightedCount = 0;

  for (const field of fields) {
    if (!isScoreField(field)) continue;
    const label = field.reporting_name || field.label || field.id;
    if (hidden.has(field.id)) continue; // hidden: excluded entirely
    const parsed = parseScoreAnswer(submissionData[field.id]);
    if (!parsed.answered) {
      if (field.required) errors.push(`"${label}" is required`);
      continue; // optional unanswered: excluded from denominator
    }
    if (parsed.invalid) {
      errors.push(`"${label}" must be a whole number`);
      continue;
    }
    const weight = getScoreWeight(field);
    const included = field.include_in_overall !== false;
    if (parsed.na) {
      if (field.allow_na !== true) {
        errors.push(`"${label}" does not allow a Not Applicable answer`);
        continue;
      }
      answers.push({
        field_id: field.id,
        reporting_name: field.reporting_name || null,
        reporting_category: field.reporting_category || null,
        raw_score: null,
        is_na: true,
        normalised_score: null,
        weight,
        weighted_contribution: null,
        included_in_overall: false
      });
      continue;
    }
    const { min, max } = getScoreRange(field);
    if (parsed.score < min || parsed.score > max) {
      errors.push(`"${label}" must be between ${min} and ${max}`);
      continue;
    }
    let normalised = max > min ? (parsed.score - min) / (max - min) : 0;
    if (field.reverse_scoring === true) normalised = 1 - normalised;
    const contribution = included ? normalised * weight : null;
    answers.push({
      field_id: field.id,
      reporting_name: field.reporting_name || null,
      reporting_category: field.reporting_category || null,
      raw_score: parsed.score,
      is_na: false,
      normalised_score: round6(normalised),
      weight,
      weighted_contribution: contribution === null ? null : round6(contribution),
      included_in_overall: included
    });
    if (included) {
      weightedNumerator += normalised * weight;
      weightedDenominator += weight;
      unweightedSum += normalised;
      unweightedCount += 1;
    }
  }

  return {
    errors,
    answers,
    overallWeighted: weightedDenominator > 0 ? round6(weightedNumerator / weightedDenominator) : null,
    overallUnweighted: unweightedCount > 0 ? round6(unweightedSum / unweightedCount) : null
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// The ACTIVE published snapshot is ALWAYS the one form.survey_settings
// points at via current_version — never "the highest version_number",
// which may be a superseded snapshot after an older config is re-published.
export function activeVersionNumber(surveySettings) {
  const n = Number(surveySettings?.current_version);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
