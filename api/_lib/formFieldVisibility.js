/**
 * Server-side form field visibility evaluation (Task #3483).
 *
 * Mirrors the client's hiddenFieldIds computation (FormView/EmbedForm):
 *  - fields with starts_hidden begin hidden (legacy fallback: any field
 *    targeted by a "show" action starts hidden),
 *  - matched show rules reveal, matched hide rules hide (hide wins last),
 *  - fields on a hidden page are hidden.
 *
 * Condition evaluation reuses the shared submit-control rule evaluator so
 * operators can never drift between the two server-side enforcement paths.
 *
 * Used to decide server-side whether a Payment field is visible for the
 * submitted answers: a hidden payment field falls back to a normal
 * no-payment submission, and a visible one makes payment mandatory.
 */

import { evaluateSubmitControlRule } from './formSubmitControl.js';
import { filterOrganizationsEligibleForFields } from './organizationEligibility.js';
import {
  normalizeConditionalValue,
  resolveConditionalFilter,
} from './formConditionalFilters.js';
import {
  hasEnabledFormNotListedChoice,
  isFormNotListedValue,
} from '../../shared/formNotListedChoice.js';
import {
  isRepeatableRowField,
  isRepeatableValueEmpty,
  normalizeRepeatableRowField,
  repeatableEmptyAvailabilitySupport,
  repeatableRowChildren,
  resolveRepeatableExcludedValues,
} from '../../shared/formRepeatableRows.js';

/**
 * @param {object} form - needs fields, pages, visibility_rules
 * @param {object} formValues - submitted answers keyed by field id
 * @param {object} [options] - { lmicCodes } forwarded to condition evaluation
 * @returns {Set<string>} ids of hidden fields
 */
export function computeHiddenFieldIds(form, formValues, options = {}) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const pages = Array.isArray(form?.pages) ? form.pages : [];
  const rules = Array.isArray(form?.visibility_rules) ? form.visibility_rules : [];
  const pageIdSet = new Set(pages.map((p) => p?.id).filter(Boolean));

  // Initial hidden fields from starts_hidden
  const hiddenFields = new Set();
  for (const field of fields) {
    if (field?.starts_hidden === true || field?.starts_hidden === 'true') {
      hiddenFields.add(field.id);
    }
  }
  // Legacy fallback: fields targeted by "show" actions start hidden
  if (hiddenFields.size === 0 && rules.length > 0) {
    for (const rule of rules) {
      if (rule?.actions && Array.isArray(rule.actions)) {
        for (const action of rule.actions) {
          if (action?.action_type === 'visibility' && action.field_states) {
            for (const [fieldId, state] of Object.entries(action.field_states)) {
              if (state?.visible === true && !pageIdSet.has(fieldId)) hiddenFields.add(fieldId);
            }
          } else if (action?.action_type === 'show' && action.target_field_ids?.length) {
            action.target_field_ids.forEach((id) => hiddenFields.add(id));
          }
        }
      } else if (rule?.action === 'show' && rule.target_field_ids?.length) {
        rule.target_field_ids.forEach((id) => hiddenFields.add(id));
      }
    }
  }

  // Initial hidden pages
  const hiddenPages = new Set();
  for (const page of pages) {
    if (page?.starts_hidden === true || page?.starts_hidden === 'true') hiddenPages.add(page.id);
  }
  for (const rule of rules) {
    if (rule?.actions && Array.isArray(rule.actions)) {
      for (const action of rule.actions) {
        if (action?.action_type === 'visibility' && action.field_states) {
          for (const [id, state] of Object.entries(action.field_states)) {
            if (state?.visible === true && pageIdSet.has(id)) hiddenPages.add(id);
          }
        }
      }
    }
  }

  // Evaluate rules
  const fieldVisibility = {};
  const pageVisibility = {};
  for (const rule of rules) {
    if (!rule) continue;
    if (!rule.conditions?.length && !rule.trigger_field_id) continue;
    const conditionMet = evaluateSubmitControlRule(rule, formValues, options);

    if (rule.actions && Array.isArray(rule.actions)) {
      for (const action of rule.actions) {
        if (action?.action_type === 'visibility' && action.field_states) {
          for (const [targetId, state] of Object.entries(action.field_states)) {
            const visMap = pageIdSet.has(targetId) ? pageVisibility : fieldVisibility;
            if (!visMap[targetId]) visMap[targetId] = { showRules: [], hideRules: [] };
            if (state?.visible === true) visMap[targetId].showRules.push(conditionMet);
            else if (state?.visible === false) visMap[targetId].hideRules.push(conditionMet);
          }
        } else if (action?.action_type === 'show' || action?.action_type === 'hide') {
          for (const fieldId of action.target_field_ids || []) {
            if (!fieldVisibility[fieldId]) fieldVisibility[fieldId] = { showRules: [], hideRules: [] };
            if (action.action_type === 'show') fieldVisibility[fieldId].showRules.push(conditionMet);
            else fieldVisibility[fieldId].hideRules.push(conditionMet);
          }
        }
      }
    } else if (rule.target_field_ids?.length) {
      for (const fieldId of rule.target_field_ids) {
        if (!fieldVisibility[fieldId]) fieldVisibility[fieldId] = { showRules: [], hideRules: [] };
        if (rule.action === 'show') fieldVisibility[fieldId].showRules.push(conditionMet);
        else if (rule.action === 'hide') fieldVisibility[fieldId].hideRules.push(conditionMet);
      }
    }
  }

  for (const [fieldId, { showRules, hideRules }] of Object.entries(fieldVisibility)) {
    if (showRules.some((r) => r === true)) hiddenFields.delete(fieldId);
    if (hideRules.some((r) => r === true)) hiddenFields.add(fieldId);
  }
  for (const [pageId, { showRules, hideRules }] of Object.entries(pageVisibility)) {
    if (showRules.some((r) => r === true)) hiddenPages.delete(pageId);
    if (hideRules.some((r) => r === true)) hiddenPages.add(pageId);
  }
  if (hiddenPages.size > 0) {
    for (const field of fields) {
      if (field?.page_id && hiddenPages.has(field.page_id)) hiddenFields.add(field.id);
    }
  }
  return hiddenFields;
}

function valueForField(values, field) {
  if (!values || typeof values !== 'object' || !field) return undefined;
  if (field.id != null && values[field.id] !== undefined) return values[field.id];
  return field.name != null ? values[field.name] : undefined;
}

function flattenedSelection(value) {
  if (Array.isArray(value)) return value.flatMap(flattenedSelection);
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return flattenedSelection(value.value);
  }
  return isRepeatableValueEmpty(value) ? [] : [value];
}

function hasAnsweredValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return hasAnsweredValue(value.value);
  }
  return !isRepeatableValueEmpty(value);
}

/**
 * Repeatable availability includes the synthetic Not listed option only when
 * the client-side conditional option intersection would keep that option.
 *
 * Dynamic organisation fields do not persist a base option list, so the
 * server-side conditional resolver intentionally returns `allowedValues:
 * null` for exclusion rules.  That is useful for validating newly-created
 * organisations, but it cannot decide whether the synthetic sentinel should
 * survive the client's intersection.  Use the matched rule's raw values here,
 * matching intersectConditionalOptions: an empty target list is unrestricted,
 * include keeps only explicitly included values, and exclude removes only
 * explicitly excluded values.
 */
function conditionalNotListedOptionAvailable(resolution) {
  if (!resolution?.configured) return true;
  if (!resolution.rule) return false;
  const targetValues = normalizeConditionalValue(resolution.rule.allowed_values);
  const values = (Array.isArray(targetValues) ? targetValues : [targetValues])
    .filter(value => value !== undefined && value !== null);
  const includesNotListed = values.some(isFormNotListedValue);
  if (values.length === 0) return true;
  return resolution.targetMode === 'exclude'
    ? !includesNotListed
    : includesNotListed;
}

function unresolved(reason) {
  return { status: 'unresolved', reason };
}

function validOrganizationFilter(filter) {
  if (filter === undefined || filter === null) return true;
  return filter && typeof filter === 'object' && !Array.isArray(filter)
    && (filter.type === 'core' || filter.type === 'custom')
    && typeof filter.field === 'string' && filter.field.length > 0
    && Array.isArray(filter.values)
    && (filter.mode === undefined || filter.mode === 'include' || filter.mode === 'exclude')
    && (filter.value_source === undefined
      || filter.value_source === 'fixed' || filter.value_source === 'source');
}

const ORGANIZATION_AVAILABILITY_PAGE_SIZE = 500;

async function loadAllTenantOrganizations(db, tenantId) {
  const organizations = [];
  for (let offset = 0; ; offset += ORGANIZATION_AVAILABILITY_PAGE_SIZE) {
    let query = db
      .from('organization')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true });
    // Supabase applies a default row limit when no range is supplied. An
    // availability result is authoritative only after every page has been
    // examined, otherwise a page containing only excluded/other-group records
    // could incorrectly hide the container.
    const paged = typeof query.range === 'function';
    const result = paged
      ? await query.range(offset, offset + ORGANIZATION_AVAILABILITY_PAGE_SIZE - 1)
      : await query;
    if (result?.error) throw result.error;
    const page = Array.isArray(result?.data) ? result.data : [];
    organizations.push(...page);
    if (!paged || page.length < ORGANIZATION_AVAILABILITY_PAGE_SIZE) break;
  }
  return organizations;
}

/**
 * Resolve the persisted first-column domain for availability-based
 * repeatable-container hiding.  This intentionally returns an unresolved
 * result for missing prerequisites and throws for database failures; the
 * caller converts failures to unresolved so a broken lookup can never bypass
 * ordinary validation.
 */
export async function resolveRepeatableFirstColumnAvailability({
  db,
  tenantId,
  form,
  field,
  formValues = {},
} = {}) {
  const support = repeatableEmptyAvailabilitySupport(field);
  if (!support.supported) return { status: 'unsupported', reason: support.reason };
  if (!db || !tenantId) return unresolved('missing_tenant_context');

  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const containerIndex = fields.findIndex(candidate => (
    String(candidate?.id) === String(field?.id)
  ));
  const first = normalizeRepeatableRowField(field).children[0];
  if (!first || containerIndex < 0) return unresolved('missing_persisted_container');
  if (!validOrganizationFilter(first.org_filter)) {
    return unresolved('invalid_organization_filter');
  }

  let selectedGroupId = null;
  if (first.organisation_group_parent_field_id) {
    const parentIndex = fields.findIndex(candidate => (
      String(candidate?.id) === String(first.organisation_group_parent_field_id)
    ));
    const parent = fields[parentIndex];
    if (parentIndex < 0 || parentIndex >= containerIndex
        || parent?.type !== 'organisation_group_dropdown') {
      return unresolved('invalid_group_dependency');
    }
    const groupId = valueForField(formValues, parent);
    if (isRepeatableValueEmpty(groupId) || isFormNotListedValue(groupId)) {
      return unresolved('missing_group_dependency');
    }
    if (typeof groupId !== 'string' && typeof groupId !== 'number') {
      return unresolved('invalid_group_dependency_value');
    }
    const { data: group, error: groupError } = await db
      .from('organization_group')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('id', String(groupId))
      .maybeSingle();
    if (groupError) throw groupError;
    if (!group) return unresolved('invalid_group_dependency_value');
    selectedGroupId = String(group.id);
  }

  const resolution = resolveConditionalFilter(first, formValues, fields);
  if (resolution.configured && !resolution.valid) {
    return unresolved('invalid_conditional_filter');
  }
  if (resolution.configured && !resolution.rule) {
    const sourceRules = (first.conditional_filters?.rules || [])
      .filter(rule => rule && rule.is_fallback !== true);
    // A configured rule without a match is only confirmed empty once its
    // prerequisite has actually been answered.  Blank dependency answers are
    // unresolved so a temporary empty state cannot hide the whole element.
    const allSourcesAnswered = sourceRules.length > 0 && sourceRules.every(rule => {
      const sourceValue = valueForField(
        formValues,
        fields.find(candidate => String(candidate?.id) === String(rule.source_field_id))
          || { id: rule.source_field_id },
      );
      return hasAnsweredValue(sourceValue);
    });
    if (!allSourcesAnswered) {
      return unresolved('missing_conditional_dependency');
    }
    // The client intersects every option (including Not listed) with the
    // configured conditional result.  A valid, answered source with no
    // matching rule is therefore an authoritative empty domain.
    return { status: 'empty', reason: 'no_matching_conditional_rule' };
  }

  const organizations = await loadAllTenantOrganizations(db, tenantId);

  const allowedIds = resolution.configured && Array.isArray(resolution.allowedValues)
    ? new Set(resolution.allowedValues.map(value => String(value)))
    : null;
  const excludedIds = new Set((resolution.excludedValues || []).map(value => String(value)));
  let candidates = (organizations || []).filter(organization => {
    const id = String(organization?.id ?? '');
    if (!id || excludedIds.has(id)) return false;
    if (selectedGroupId && String(organization?.organization_group_id || '') !== selectedGroupId) {
      return false;
    }
    return allowedIds ? allowedIds.has(id) : true;
  });
  const eligibleFields = resolution.orgFilter
    ? [first, { org_filter: resolution.orgFilter }]
    : [first];
  candidates = await filterOrganizationsEligibleForFields({
    db,
    tenantId,
    organizations: candidates,
    fields: eligibleFields,
  });

  const earlierExcludedValues = resolveRepeatableExcludedValues(
    first,
    fields,
    formValues,
    field,
  );
  const earlierExcludedSelections = earlierExcludedValues.flatMap(flattenedSelection);
  const earlierExcludedIds = new Set(
    earlierExcludedSelections.map(value => String(value)),
  );
  candidates = candidates.filter(organization => (
    !earlierExcludedIds.has(String(organization?.id))
  ));

  // Not-listed is a real selectable fallback, not an option request failure.
  if (hasEnabledFormNotListedChoice(first)
      && conditionalNotListedOptionAvailable(resolution)
      && !earlierExcludedSelections.some(value => isFormNotListedValue(value))) {
    return { status: 'available', reason: 'not_listed_fallback' };
  }
  return candidates.length === 0
    ? { status: 'empty', reason: 'no_eligible_options' }
    : { status: 'available', reason: 'eligible_options', count: candidates.length };
}

/**
 * Add only confirmed-empty, persisted availability results to the normal
 * visibility set.  Every lookup failure remains visible and therefore keeps
 * validation/side effects fail-closed.
 */
export async function computeAuthoritativeHiddenFieldIds({
  db,
  tenantId,
  form,
  formValues = {},
  visibilityOptions = {},
} = {}) {
  const hiddenFields = computeHiddenFieldIds(form, formValues, visibilityOptions);
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  for (const field of fields) {
    if (!isRepeatableRowField(field)) continue;
    const config = normalizeRepeatableRowField(field);
    if (!config.hide_when_first_column_empty
        || hiddenFields.has(field.id)
        || hiddenFields.has(String(field.id))) continue;
    try {
      const availability = await resolveRepeatableFirstColumnAvailability({
        db,
        tenantId,
        form,
        field,
        formValues,
      });
      if (availability.status !== 'empty') continue;
      hiddenFields.add(field.id);
      hiddenFields.add(String(field.id));
      repeatableRowChildren(field).forEach(child => {
        if (child?.id != null) {
          hiddenFields.add(child.id);
          hiddenFields.add(String(child.id));
        }
      });
    } catch {
      // Availability is an optional presentation rule. A failed lookup must
      // never turn into permission to skip validation or processing.
    }
  }
  return hiddenFields;
}

/**
 * Find the form's generic Payment field (type 'payment').
 * Returns null when the form has none.
 */
export function findPaymentField(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  return fields.find((f) => f?.type === 'payment') || null;
}

/**
 * Server-side amount derivation from the price-source answer. The client
 * never supplies an amount. Returns a finite number rounded to 2dp, or 0
 * for missing/invalid values (0 == no payment required).
 */
export function derivePaymentAmount(paymentField, formValues) {
  const sourceId = paymentField?.price_field_id;
  if (!sourceId) return 0;
  let raw = (formValues || {})[sourceId];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    // currency-style composite answers ({ amount, currency } or { value })
    raw = raw.amount ?? raw.value ?? null;
  }
  if (typeof raw === 'string') raw = raw.replace(/[^0-9.\-]/g, '');
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}
