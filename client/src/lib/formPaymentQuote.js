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
export function membershipQuoteKey(match, formValues) {
  if (!match) return null;
  const mappedFieldIds = [...new Set(Object.values(match.fieldMappings || {}))].sort();
  const vals = {};
  for (const fid of mappedFieldIds) {
    vals[fid] = (formValues || {})[fid] ?? null;
  }
  return JSON.stringify({ configId: match.configId, ruleId: match.ruleId, vals });
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
