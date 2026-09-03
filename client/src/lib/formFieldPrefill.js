import { FORM_NOT_LISTED_VALUE } from '../../../shared/formNotListedChoice.js';
import { isAddressLookupAnswerFilled } from '../../../shared/formAddressLookup.js';

// Shared helpers for form field validation/prefill logic.
// Used by both the standalone FormView page and IEdit-embedded forms so that
// fixes to either helper apply everywhere at once.

export const isFieldValueFilled = (field, value) => {
  if (field.type === 'address_lookup') {
    return isAddressLookupAnswerFilled(field, value);
  }

  if (field.type === 'grouped_question') {
    const subQuestions = Array.isArray(field.sub_questions) ? field.sub_questions : [];
    const rawMin = Number(field.min_completed);
    const minRequired = Number.isFinite(rawMin)
      ? Math.max(0, Math.min(rawMin, subQuestions.length))
      : subQuestions.length;
    const rawMax = Number(field.max_completed);
    const maxAllowed = Number.isFinite(rawMax)
      ? Math.max(minRequired, Math.min(rawMax, subQuestions.length))
      : subQuestions.length;
    const answers = (value && typeof value === 'object') ? value : {};
    const answeredCount = subQuestions.reduce((count, sq) => {
      const answer = answers[sq.id];
      return count + (typeof answer === 'string' && answer.trim() ? 1 : 0);
    }, 0);
    if (answeredCount > maxAllowed) return false;
    if (minRequired === 0) return true;
    return answeredCount >= minRequired;
  }

  if (field.type === 'score') {
    // Only a real integer score or an explicit N/A counts as answered —
    // partial shapes like { score: '' } must NOT pass client validation
    // (the server would reject them after submit).
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.na === true) return field.allow_na === true;
    const n = Number(value.score);
    if (!Number.isInteger(n)) return false;
    // Mirror the server's range rules (surveyScoring.getScoreRange).
    const isNps = (field.score_style || 'stars') === 'nps';
    const min = isNps ? 0 : (Number.isFinite(Number(field.score_min)) ? Math.trunc(Number(field.score_min)) : 1);
    const max = isNps ? 10 : (Number.isFinite(Number(field.score_max)) ? Math.trunc(Number(field.score_max)) : 5);
    return n >= min && n <= max;
  }

  if (!value) return false;

  if (field.type === 'countries') {
    return Array.isArray(value) && value.length > 0;
  }

  if (field.type === 'contact') {
    if (typeof value !== 'object') return false;
    if (!field.required) return Object.values(value).some(v => typeof v === 'string' && v.trim());
    const subDefaults = { firstName: { visible: true, required: true }, lastName: { visible: true, required: true }, jobTitle: { visible: true, required: false }, organisation: { visible: true, required: false }, email: { visible: true, required: true } };
    const subFields = field.contact_sub_fields || subDefaults;
    const requiredKeys = Object.keys(subDefaults).filter(k => {
      const cfg = subFields[k] || subDefaults[k];
      return cfg.visible !== false && cfg.required === true;
    });
    return requiredKeys.every(k => !!value[k]?.trim());
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === 'string') {
    return value.length > 0;
  }

  if (typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }

  return true;
};

// Task #3336: shared precedence rule for the prefill target across all three
// form surfaces (FormView, EmbedForm iframe, IEditFormElement):
//   explicit URL param > authenticated member/org > nothing.
// The authenticated fallback only applies when the LOADED form actually uses
// member/organisation prefill, so non-prefill forms and anonymous viewers
// behave exactly as before.
export const resolveEffectivePrefillIds = ({
  urlMemberId,
  urlOrgId,
  prefillSource,
  viewerMemberId,
  viewerOrgId,
}) => {
  const eligible = !!viewerMemberId &&
    (prefillSource === 'member' || prefillSource === 'organization');
  return {
    prefillMemberId: urlMemberId || (eligible ? (viewerMemberId || null) : null),
    prefillOrgId: urlOrgId || (eligible ? (viewerOrgId || null) : null),
  };
};

// Task #3357: effective organisation ID for member-source forms. The org
// entity fetch, org custom values and the organisation dropdown must all key
// off the SAME id: the member entity's own organization_id when present,
// else the authenticated fallback org id (resolveEffectivePrefillIds'
// prefillOrgId — explicit URL param or the session's resolved organisation).
// Returns null for non-member prefill sources so organization-source
// behaviour is unchanged.
export const resolveMemberSourceOrgId = ({ prefillSource, memberEntity, fallbackOrgId }) => {
  if (prefillSource !== 'member') return null;
  return memberEntity?.organization_id || fallbackOrgId || null;
};

// Task #3357: readiness gate for the org-entity fetch. The one-time prefill
// effect must not apply (and latch prefillApplied) while an org-entity fetch
// that will feed `org:`-mapped fields is still in flight — otherwise, when
// the member resolves before its organisation, org fields are permanently
// skipped. Mirrors the custom-values gate: `effectiveOrgId` must mirror the
// org query's `enabled` predicate (pass null when the query can never run,
// e.g. unauthenticated on surfaces whose org query requires a session), and
// `orgEntityLoading` should be the react-query v5 isLoading (false for
// disabled queries), so the effect can never be blocked forever.
export const shouldWaitForPrefillOrgEntity = ({
  prefillSource,
  form,
  effectiveOrgId,
  orgEntityLoading,
}) => {
  if (prefillSource !== 'member' && prefillSource !== 'organization') return false;
  if (!effectiveOrgId || !orgEntityLoading) return false;
  return (form?.fields || []).some(f =>
    typeof f.prefill_field === 'string' && f.prefill_field.startsWith('org:')
  );
};

// Task #3336: shared readiness gate for the one-time prefill effect. The
// effect must NOT apply (and latch prefillApplied) while any custom-value
// query that will feed `member_custom:` / `org_custom:` / legacy `custom:`
// fields is still in flight, otherwise those fields are permanently skipped
// when the entity resolves before the custom values do.
// Each *_CustomValuesLoading flag should be the react-query isLoading of the
// respective query; the id args mirror the queries' `enabled` predicates so a
// permanently-disabled query can never block prefill.
export const shouldWaitForPrefillCustomValues = ({
  prefillSource,
  authenticated,
  memberId,
  orgIdForCustomFields,
  memberCustomValuesLoading,
  orgCustomValuesLoading,
}) => {
  if (!prefillSource || prefillSource === 'none') return false;
  if (!authenticated) return false;
  if (prefillSource === 'member' && memberId && memberCustomValuesLoading) return true;
  if (orgIdForCustomFields && orgCustomValuesLoading) return true;
  return false;
};

export const buildMemberResourceCategoryPrefillValues = ({
  form,
  memberResourceCategorySelections = [],
}) => {
  if (form?.prefill_source !== 'member') return {};

  const values = {};
  for (const field of (form.fields || [])) {
    if (field.type === 'category_multiselect' || field.type === 'resource_categories') {
      const allowedCategoryIds = Array.isArray(field.allowed_category_ids) && field.allowed_category_ids.length > 0
        ? new Set(field.allowed_category_ids)
        : null;
      const selected = memberResourceCategorySelections
        .filter(selection => !allowedCategoryIds || allowedCategoryIds.has(selection.resource_category_id))
        .map(selection => selection.subcategory_name)
        .filter(value => typeof value === 'string' && value.trim() !== '');
      if (selected.length > 0) values[field.id] = [...new Set(selected)];
    } else if (field.type === 'category_dropdown') {
      const selection = memberResourceCategorySelections.find(item =>
        item.resource_category_id === field.category_id
        && typeof item.subcategory_name === 'string'
        && item.subcategory_name.trim() !== ''
      );
      if (selection) values[field.id] = selection.subcategory_name;
    }
  }
  return values;
};
export const buildPrefillValues = ({
  form,
  memberEntity,
  orgEntity,
  primaryEntity,
  memberCustomValues = [],
  orgCustomValues = [],
  memberResourceCategorySelections = [],
  prefillOrgId = null,
  prefillOrganizationGroupId = null,
}) => {
  const newValues = buildMemberResourceCategoryPrefillValues({
    form,
    memberResourceCategorySelections,
  });
  for (const field of (form?.fields || [])) {
    if (field.type === 'organisation_dropdown') {
      if (form.prefill_source === 'organization' && prefillOrgId) {
        newValues[field.id] = prefillOrgId;
      } else if (form.prefill_source === 'member' && (memberEntity?.organization_id || prefillOrgId)) {
        // Task #3357: fall back to the resolved prefill org id (authenticated
        // session's organisation) when the member row has no organization_id.
        newValues[field.id] = memberEntity?.organization_id || prefillOrgId;
      }
      continue;
    }

    if (field.type === 'organisation_group_dropdown') {
      const groupId = memberEntity?.organization_group_id
        || orgEntity?.organization_group_id
        || prefillOrganizationGroupId;
      if (groupId) newValues[field.id] = groupId;
      continue;
    }

    if (form.prefill_source === 'member'
      && ['category_multiselect', 'resource_categories', 'category_dropdown'].includes(field.type)) continue;

    if (!field.prefill_field) continue;

    const prefillField = field.prefill_field;
    let value = null;

    if (prefillField.startsWith('member:')) {
      value = memberEntity?.[prefillField.replace('member:', '')];
    } else if (prefillField.startsWith('org:')) {
      value = orgEntity?.[prefillField.replace('org:', '')];
    } else if (prefillField.startsWith('member_custom:')) {
      const customFieldId = prefillField.replace('member_custom:', '');
      const cfv = memberCustomValues.find(v => v.field_id === customFieldId);
      value = parseCustomFieldValue(cfv, field.type);
    } else if (prefillField.startsWith('org_custom:')) {
      const customFieldId = prefillField.replace('org_custom:', '');
      const cfv = orgCustomValues.find(v => v.field_id === customFieldId);
      value = parseCustomFieldValue(cfv, field.type);
    } else if (prefillField.startsWith('custom:')) {
      const customFieldId = prefillField.replace('custom:', '');
      const customValues = form.prefill_source === 'member' ? memberCustomValues : orgCustomValues;
      const cfv = customValues.find(v => v.field_id === customFieldId);
      value = parseCustomFieldValue(cfv, field.type);
    } else {
      value = primaryEntity?.[prefillField];
    }

    if (value !== null && value !== undefined) {
      newValues[field.id] = value;
    }
  }
  return newValues;
};

// Task #3399: gate for the authenticated viewer-booking prefill fallback on
// FormView. Fires only when the LOADED form uses booking prefill, no explicit
// booking_id URL param is present (explicit param always wins), and the
// viewer's auth state has resolved to a logged-in member. Anonymous viewers
// and non-booking forms never trigger the fetch, so they behave exactly as
// before.
export const shouldFetchViewerBookingPrefill = ({
  prefillSource,
  urlBookingId,
  authResolved,
  viewerMemberId,
  formSlug,
}) => {
  if (prefillSource !== 'booking') return false;
  if (urlBookingId) return false;
  if (!authResolved || !viewerMemberId) return false;
  return !!formSlug;
};

// Task #3400: gate for BLOCKING an event-linked booking-prefill form when the
// authenticated viewer has no booking for the event. Fires only when the
// viewer-booking fetch was applicable (same gate as
// shouldFetchViewerBookingPrefill), the resolution has settled without error,
// and the server explicitly said "no booking" (noBooking flag). Transient
// errors and plain-empty payloads (non-event-linked forms) never block.
export const shouldBlockForMissingViewerBooking = ({
  prefillSource,
  urlBookingId,
  authResolved,
  viewerMemberId,
  formSlug,
  viewerBookingData,
  viewerBookingError,
}) => {
  if (!shouldFetchViewerBookingPrefill({ prefillSource, urlBookingId, authResolved, viewerMemberId, formSlug })) {
    return false;
  }
  if (viewerBookingError) return false;
  return viewerBookingData?.noBooking === true;
};

// Task #3400: while the viewer-booking resolution is applicable but not yet
// settled, the form must render neither its fields nor the blocking message
// (no flash of either state). True while auth is still resolving for a
// booking-prefill form with no explicit booking_id, or while the fetch is
// in flight.
export const isViewerBookingResolutionPending = ({
  prefillSource,
  urlBookingId,
  authResolved,
  viewerMemberId,
  formSlug,
  viewerBookingLoading,
}) => {
  if (prefillSource !== 'booking') return false;
  if (urlBookingId) return false;
  if (!authResolved) return true;
  if (!shouldFetchViewerBookingPrefill({ prefillSource, urlBookingId, authResolved, viewerMemberId, formSlug })) {
    return false;
  }
  return !!viewerBookingLoading;
};

export const parseCustomFieldValue = (cfv, fieldType) => {
  if (!cfv || cfv.value === undefined || cfv.value === null) return null;
  let parsedValue = cfv.value;
  if (fieldType === 'list' || fieldType === 'countries') {
    if (Array.isArray(cfv.value)) {
      parsedValue = cfv.value;
    } else if (typeof cfv.value === 'string') {
      try {
        const parsed = JSON.parse(cfv.value);
        parsedValue = Array.isArray(parsed) ? parsed : (cfv.value ? [cfv.value] : []);
      } catch {
        parsedValue = cfv.value ? [cfv.value] : [];
      }
    } else {
      parsedValue = [];
    }
  } else if (fieldType === 'custom_field') {
    // For wrapped custom_field form fields we don't know the underlying type here.
    // Only attempt JSON-parse when the raw value LOOKS like a JSON array string,
    // so list/countries custom fields get an array but text/boolean/etc are untouched.
    if (typeof cfv.value === 'string') {
      const trimmed = cfv.value.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) parsedValue = parsed;
        } catch {
          // leave as raw string
        }
      }
    }
  }
  return parsedValue;
};

// Task #3933: form-field-driven prefill configuration. These helpers are kept
// pure so the builder, runtime hook and focused node tests share exactly the
// same eligibility and ordering rules.
export const FORM_FIELD_PREFILL_SOURCE_TYPES = new Set([
  'organisation_dropdown',
  'organization_dropdown',
  'organisation_group_dropdown',
]);

export const getEligibleFormFieldPrefillSources = (fields = []) => (
  fields.filter(field => field?.id
    && FORM_FIELD_PREFILL_SOURCE_TYPES.has(field.type)
    && !field.repeatable_field_id
    && !field.parent_repeatable_field_id)
);

export const getFormFieldPrefillSource = (form) => {
  if (form?.prefill_source !== 'form_field') return null;
  const sourceId = form.prefill_source_field_id || form.prefill_field_id;
  return getEligibleFormFieldPrefillSources(form?.fields || [])
    .find(field => field.id === sourceId) || null;
};

export const formFieldPrefillKind = (source) => (
  source?.type === 'organisation_group_dropdown' ? 'organization_group' : 'organization'
);

export const isEligibleFormFieldPrefillTarget = (form, field) => {
  const source = getFormFieldPrefillSource(form);
  if (!source || !field?.id || field.id === source.id) return false;
  const fields = form?.fields || [];
  return fields.findIndex(candidate => candidate.id === field.id)
    > fields.findIndex(candidate => candidate.id === source.id);
};

export const validateFormFieldPrefillConfig = (form) => {
  if (form?.prefill_source !== 'form_field') return { valid: true, errors: [] };
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const sourceId = form?.prefill_source_field_id || form?.prefill_field_id;
  const sourceIndex = fields.findIndex(field => field?.id === sourceId);
  const source = sourceIndex >= 0 ? fields[sourceIndex] : null;
  const errors = [];
  if (!sourceId) {
    errors.push('Choose an Organisation or Organisation Group dropdown as the pre-fill source.');
    return { valid: false, errors };
  }
  if (!source || !getEligibleFormFieldPrefillSources(fields).some(field => field.id === sourceId)) {
    errors.push('The pre-fill source is missing, nested, or no longer an Organisation or Organisation Group dropdown.');
    return { valid: false, errors };
  }
  const prefixes = source.type === 'organisation_group_dropdown'
    ? ['org_group:', 'organization_group:', 'organisation_group:', 'group:',
      'org_group_custom:', 'organization_group_custom:', 'organisation_group_custom:', 'group_custom:']
    : ['org:', 'organization:', 'organisation:',
      'org_custom:', 'organization_custom:', 'organisation_custom:'];
  fields.forEach((field, index) => {
    if (!field?.prefill_field) return;
    if (index <= sourceIndex) {
      errors.push(`“${field.label || 'Untitled field'}” must appear after the pre-fill source.`);
    } else if (!prefixes.some(prefix => field.prefill_field.startsWith(prefix))) {
      errors.push(`“${field.label || 'Untitled field'}” has a pre-fill mapping for the wrong record type.`);
    }
  });
  return { valid: errors.length === 0, errors };
};

// Only answers before the source can affect whether the persisted dropdown
// currently offers a record (conditional filters and group-parent filters).
// Keeping the projection narrow avoids re-fetching when an auto-filled target
// changes and prevents a response -> render -> request loop.
export const getFormFieldPrefillSourceAnswers = (form, formValues = {}) => {
  const source = getFormFieldPrefillSource(form);
  if (!source) return {};
  const sourceIndex = (form?.fields || []).findIndex(field => field?.id === source.id);
  if (sourceIndex <= 0) return {};
  return Object.fromEntries((form.fields || [])
    .slice(0, sourceIndex)
    .filter(field => field?.id && Object.prototype.hasOwnProperty.call(formValues, field.id))
    .map(field => [field.id, formValues[field.id]]));
};

export const shouldClearFormFieldPrefillSelection = selectedRecordId => (
  !selectedRecordId || selectedRecordId === FORM_NOT_LISTED_VALUE
);

// Resolver 4xx responses are authoritative outcomes for this persisted form
// and selection. Network/5xx failures are transient and retain the last fill.
export const shouldClearFormFieldPrefillError = error => (
  Number.isInteger(error?.status)
  && error.status >= 400
  && error.status < 500
  && error.status !== 429
);

const samePrefillValue = (left, right) => {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};

const isBlankPrefillValue = value => value === undefined || value === null || value === '';

// Applies a resolver response without trampling respondent input. A tracked
// value is replaceable only while the answer still equals the last auto-fill.
// Clearing the source consequently removes stale auto-fills, but preserves
// unrelated values and answers edited after they were filled.
export const mergeReactiveFormFieldPrefill = ({
  currentValues = {},
  resolvedValues = {},
  trackedValues = {},
  clear = false,
}) => {
  const nextValues = { ...currentValues };
  const nextTracked = {};
  for (const [fieldId, oldAutoValue] of Object.entries(trackedValues)) {
    if (samePrefillValue(currentValues[fieldId], oldAutoValue)) {
      delete nextValues[fieldId];
    }
  }
  if (!clear) {
    for (const [fieldId, value] of Object.entries(resolvedValues || {})) {
      if (value === undefined || value === null) continue;
      const wasTracked = Object.prototype.hasOwnProperty.call(trackedValues, fieldId);
      const canApply = wasTracked
        ? samePrefillValue(currentValues[fieldId], trackedValues[fieldId])
        : isBlankPrefillValue(currentValues[fieldId]);
      if (canApply) {
        nextValues[fieldId] = value;
        nextTracked[fieldId] = value;
      }
    }
  }
  return { values: nextValues, trackedValues: nextTracked };
};

export const normalizeFormFieldPrefillResponse = response => {
  const candidate = response?.values
    || response?.prefillValues
    || response?.prefill_values
    || response?.data
    || {};
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : {};
};

export const normalizeFormFieldPrefillValues = (form, response) => {
  const values = normalizeFormFieldPrefillResponse(response);
  const responseFieldTypes = response?.fieldTypes || response?.field_types || {};
  const fieldsById = new Map((form?.fields || []).map(field => [String(field?.id), field]));
  return Object.fromEntries(Object.entries(values).map(([fieldId, rawValue]) => {
    const field = fieldsById.get(String(fieldId));
    if (!field) return [fieldId, rawValue];
    const effectiveType = field.type === 'custom_field'
      ? (responseFieldTypes[fieldId] || field.custom_field_type || field.field_type || field.type)
      : field.type;
    if (effectiveType === 'boolean') {
      if (typeof rawValue === 'boolean') return [fieldId, rawValue];
      const normalized = String(rawValue).trim().toLowerCase();
      if (['true', 'yes', 'y', 'on', '1'].includes(normalized)) return [fieldId, true];
      if (['false', 'no', 'n', 'off', '0'].includes(normalized)) return [fieldId, false];
    }
    if (['list', 'countries', 'checkbox', 'checkboxes', 'picklist', 'category_multiselect'].includes(effectiveType)) {
      return [fieldId, parseCustomFieldValue({ value: rawValue }, 'list')];
    }
    if (effectiveType === 'contact' && typeof rawValue === 'string') {
      try {
        const parsed = JSON.parse(rawValue);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return [fieldId, parsed];
      } catch {
        // Keep the stored scalar when it is not a serialized contact object.
      }
    }
    return [fieldId, rawValue];
  }));
};
