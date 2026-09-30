/**
 * LMIC operators for form conditional logic (Task #3477).
 *
 * Two operators — `is_lmic` / `is_not_lmic` — usable on country-shaped form
 * fields (`country` / `countries`). Evaluation compares the answered
 * country/countries against the TENANT'S saved LMIC list (tenant_lmic_country,
 * lazily seeded from the World Bank list — same source as the dashboard LMIC
 * filters), never a hardcoded list.
 *
 * React-free and dependency-light so it is shared verbatim by the public form
 * clients (FormView / EmbedForm), the shared submit-control evaluator and the
 * server-side submission processors.
 */
import { resolveCountryToIso2 } from '../../shared/countries.js';

export const LMIC_CONDITION_OPERATORS = ['is_lmic', 'is_not_lmic'];

export const isLmicOperator = (operator) =>
  operator === 'is_lmic' || operator === 'is_not_lmic';

/**
 * Normalise a delivered LMIC code list (array or Set, any case) to an
 * uppercase Set for membership checks.
 */
export function toLmicCodeSet(lmicCodes) {
  if (lmicCodes instanceof Set) {
    return new Set([...lmicCodes].map((c) => String(c).trim().toUpperCase()));
  }
  if (Array.isArray(lmicCodes)) {
    return new Set(lmicCodes.map((c) => String(c).trim().toUpperCase()).filter(Boolean));
  }
  return new Set();
}

/**
 * Evaluate an LMIC condition against a field value.
 *
 * - Returns `undefined` when `operator` is not an LMIC operator (caller
 *   falls through to its standard operator handling).
 * - Scalar or array values accepted; each entry is resolved via the shared
 *   country resolver so names AND ISO codes both work.
 * - Empty / unresolvable values match NEITHER operator — rules simply don't
 *   fire until a recognisable country is chosen.
 * - Multi-country values: `is_lmic` matches when ANY resolved country is in
 *   the tenant list; `is_not_lmic` is its complement over answered values
 *   (at least one resolvable country and none of them LMIC… i.e. not anyLmic).
 */
export function evaluateLmicCondition(triggerValue, operator, lmicCodes) {
  if (!isLmicOperator(operator)) return undefined;
  const set = toLmicCodeSet(lmicCodes);
  const values = Array.isArray(triggerValue) ? triggerValue : [triggerValue];
  const resolved = values
    .map((v) => resolveCountryToIso2(v))
    .filter(Boolean);
  if (resolved.length === 0) return false;
  const anyLmic = resolved.some((code) => set.has(code));
  return operator === 'is_lmic' ? anyLmic : !anyLmic;
}

/**
 * True when any visibility rule (legacy single-trigger or conditions-array
 * shape) uses an LMIC operator — used to decide whether the tenant LMIC list
 * needs loading/delivering at all.
 */
export function rulesUseLmicOperators(visibilityRules) {
  if (!Array.isArray(visibilityRules)) return false;
  for (const rule of visibilityRules) {
    if (!rule) continue;
    if (isLmicOperator(rule.operator)) return true;
    if (Array.isArray(rule.conditions)) {
      for (const c of rule.conditions) {
        if (c && isLmicOperator(c.operator)) return true;
      }
    }
  }
  return false;
}
