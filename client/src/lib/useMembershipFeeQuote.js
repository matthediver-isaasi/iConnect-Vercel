/**
 * Task #3498: fetch the server-derived fee for a form whose conditional
 * membership-structure rule matches the current answers. Display-only — the
 * charge amount is always re-derived server-side at payment-create time.
 *
 * The query key contains only the inputs that affect the fee (config, rule,
 * mapped answers, prefill org), so edits to unrelated fields don't refetch;
 * react-query dedupes the page-level hook and any other consumers.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { resolveMembershipMatch, membershipQuoteKey } from './formPaymentQuote';
import { bundlePriceSource, notifyBundleUnavailable } from './formBundles.js';
import { cartPriceSource, notifyCartUnavailable } from './formCart.js';

export function useMembershipFeeQuote({
  form,
  formValues,
  prefillOrganizationId = null,
  applicantContinuationToken = null,
  resumeToken = null,
  credentialDiscriminator = 'none',
  enabled = true,
}) {
  const match = useMemo(() => resolveMembershipMatch(form, formValues), [form, formValues]);
  const bundle = bundlePriceSource(form);
  const cart = cartPriceSource(form);
  const requiresQuote = !!match || !!bundle || !!cart;
  const key = useMemo(() => JSON.stringify({
    membership: membershipQuoteKey(match, formValues, form),
    bundleFieldId: bundle?.id || null,
    bundleId: bundle ? formValues?.[bundle.id] ?? null : null,
    cartFieldId: cart?.id || null,
    answers: formValues || {},
  }), [match, formValues, form, bundle, cart]);

  const query = useQuery({
    // credentialDiscriminator is an opaque caller-generated scope. Raw bearer
    // credentials must never enter query keys/devtools.
    queryKey: ['membership-fee-quote', form?.id, key, prefillOrganizationId || null, credentialDiscriminator],
    queryFn: async () => {
      const res = await fetch('/api/public/form-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'quote',
          form_id: form.id,
          submission_data: formValues || {},
          prefill_organization_id: prefillOrganizationId || null,
          ...(applicantContinuationToken && {
            applicant_continuation_token: applicantContinuationToken,
          }),
          ...(!applicantContinuationToken && resumeToken && {
            resume_token: resumeToken,
          }),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        notifyBundleUnavailable(form.id, json, res.status);
        notifyCartUnavailable(form.id, json, res.status);
        throw new Error(json.error || 'The fee could not be calculated');
      }
      return json;
    },
    enabled: !!enabled && !!form?.id && requiresQuote,
    // Bundle selection changes must re-quote, including A → B → A. A cached
    // price is never a fallback while the new authoritative request runs.
    staleTime: bundle || cart ? 0 : 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  return {
    matched: requiresQuote,
    source: cart ? 'cart' : match ? 'membership' : bundle ? 'bundle' : null,
    quote: requiresQuote && !query.isError && !((bundle || cart) && query.isFetching) ? query.data || null : null,
    loading: requiresQuote && (query.isLoading || query.isFetching),
    error: query.error ? (query.error.message || 'The fee could not be calculated') : null,
    refetch: query.refetch,
  };
}
