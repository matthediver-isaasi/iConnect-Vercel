/**
 * Task #3498: client-side decision logic for the public-form payment step
 * when a conditional "membership structure" action is in play.
 *
 * The membership fee can only be derived server-side (bands, pro-rata,
 * discounts, VAT), so when a membership rule matches the current answers the
 * client must fetch a display quote instead of reading the price-source
 * field — and must NEVER fall back to the plain (unpaid) submit while the
 * quote is loading or failed.
 *
 * React-free so it can be unit-tested under node and shared by the hook and
 * the payment components.
 */
import { resolveMembershipAction } from '../../../api/_lib/formMembershipAction.js';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  supportsFormNotListedChoice,
} from '../../../shared/formNotListedChoice.js';
import {
  isRepeatableRowField,
} from '../../../shared/formRepeatableRows.js';

/** The matched membership action for the current answers, or null. */
export function resolveMembershipMatch(form, formValues) {
  if (!form) return null;
  return resolveMembershipAction(form.visibility_rules, formValues, {
    lmicCodes: form.lmic_country_codes,
  });
}

/**
 * Stable cache key for a membership quote: the fee depends only on the
 * matched config and the values of the mapped answer fields (plus the
 * prefill organisation, keyed separately by the caller). Changes to
 * unrelated fields must not refetch.
 */
function savedValue(values, field) {
  if (field?.id != null && values?.[field.id] !== undefined) return values[field.id];
  return field?.name != null ? values?.[field.name] : undefined;
}

function validationFieldIds(form) {
  const ids = new Set();
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  for (const field of fields) {
    if (!field?.id) continue;
    if (['organisation_dropdown', 'organisation_group_dropdown', 'relationship_dropdown'].includes(field.type)
        || field.type === 'address_lookup'
        || supportsFormNotListedChoice(field)
        || field.conditional_filters) {
      ids.add(field.id);
    }
    if (field.parent_field_id) ids.add(field.parent_field_id);
    if (field.organisation_group_parent_field_id) ids.add(field.organisation_group_parent_field_id);
    for (const rule of (field.conditional_filters?.rules || [])) {
      if (rule?.source_field_id) ids.add(rule.source_field_id);
    }
  }
  const relevantPageIds = new Set(fields
    .filter(field => field?.page_id && ids.has(field.id))
    .map(field => field.page_id));
  for (const rule of (form?.visibility_rules || [])) {
    const targets = new Set(rule?.target_field_ids || []);
    for (const action of (rule?.actions || [])) {
      for (const id of (action?.target_field_ids || [])) targets.add(id);
      for (const id of Object.keys(action?.field_states || {})) targets.add(id);
    }
    if (![...targets].some(id => ids.has(id) || relevantPageIds.has(id))) continue;
    if (rule?.trigger_field_id) ids.add(rule.trigger_field_id);
    for (const condition of (rule?.conditions || [])) {
      if (condition?.field_id) ids.add(condition.field_id);
      if (condition?.trigger_field_id) ids.add(condition.trigger_field_id);
    }
  }
  return ids;
}

function validationValues(form, formValues) {
  const values = formValues || {};
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const ids = validationFieldIds(form);
  const projected = {};
  for (const field of fields) {
    if (!field?.id) continue;
    if (isRepeatableRowField(field)) {
      // Payment validation checks requiredness, uniqueness, dependencies,
      // relationships and not-listed text for every row child. Preserve the
      // full row payload (including row ids) so every validation-changing edit
      // supersedes an earlier failed quote.
      projected[field.id] = savedValue(values, field) ?? null;
    } else if (ids.has(field.id)) {
      projected[field.id] = savedValue(values, field) ?? null;
    }
  }
  const text = {};
  for (const id of ids) {
    if (values?.[FORM_NOT_LISTED_TEXT_KEY]?.[id] !== undefined) {
      text[id] = values[FORM_NOT_LISTED_TEXT_KEY][id];
    }
  }
  if (Object.keys(text).length) projected[FORM_NOT_LISTED_TEXT_KEY] = text;
  return projected;
}

export function membershipQuoteKey(match, formValues, form = null) {
  if (!match) return null;
  const mappedFieldIds = [...new Set(Object.values(match.fieldMappings || {}))].sort();
  const vals = {};
  for (const fid of mappedFieldIds) {
    vals[fid] = (formValues || {})[fid] ?? null;
  }
  return JSON.stringify({
    configId: match.autoResolve ? 'auto' : match.configId,
    ruleId: match.ruleId,
    vals,
    validation: validationValues(form, formValues),
  });
}

/**
 * Decide the payable amount and whether the payment step may fall back to
 * the plain submit button.
 *
 * Returns { amount, currency, membership, pending, blocked, error }:
 *  - pending: quote still loading — show a spinner, do NOT fall back.
 *  - blocked: payment cannot proceed AND plain submit must not be offered
 *    (loading or quote failure while a membership rule matches).
 *  - amount: the display/payable amount (null while pending/errored).
 */
export function resolveEffectivePayment({
  membershipMatched,
  quote = null,
  quoteLoading = false,
  quoteError = null,
  derivedAmount = 0,
  derivedCurrency = 'GBP',
}) {
  if (!membershipMatched) {
    return { amount: derivedAmount, currency: derivedCurrency, membership: null, pending: false, blocked: false, error: null };
  }
  if (quoteError) {
    return { amount: null, currency: derivedCurrency, membership: null, pending: false, blocked: true, error: quoteError };
  }
  if (quoteLoading || !quote) {
    return { amount: null, currency: derivedCurrency, membership: null, pending: true, blocked: true, error: null };
  }
  if (quote.required === false) {
    // Server says nothing is due for these answers — plain submit is fine.
    return { amount: 0, currency: derivedCurrency, membership: null, pending: false, blocked: false, error: null };
  }
  return {
    amount: Number(quote.amount) || 0,
    currency: (quote.currency || derivedCurrency).toUpperCase(),
    membership: quote.membership || null,
    pending: false,
    blocked: false,
    error: null,
  };
}
