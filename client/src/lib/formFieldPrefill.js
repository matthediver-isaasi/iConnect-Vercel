// Shared helpers for form field validation/prefill logic.
// Used by both the standalone FormView page and IEdit-embedded forms so that
// fixes to either helper apply everywhere at once.

export const isFieldValueFilled = (field, value) => {
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

// Task #3336: pure mapping from a form's field prefill config to form values,
// for the member/organisation prefill sources. Returns an object of
// fieldId -> value; an EMPTY object is a legitimate outcome (entity resolved
// but nothing matched) and callers must STILL latch their one-time
// prefill-applied flag, or later query refetches can overwrite user input.
export const buildPrefillValues = ({
  form,
  memberEntity,
  orgEntity,
  primaryEntity,
  memberCustomValues = [],
  orgCustomValues = [],
  prefillOrgId = null,
}) => {
  const newValues = {};
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
