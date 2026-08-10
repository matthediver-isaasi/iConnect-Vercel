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
