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

export function useMembershipFeeQuote({ form, formValues, prefillOrganizationId = null, enabled = true }) {
  const match = useMemo(() => resolveMembershipMatch(form, formValues), [form, formValues]);
  const key = useMemo(() => membershipQuoteKey(match, formValues), [match, formValues]);

  const query = useQuery({
    queryKey: ['membership-fee-quote', form?.id, key, prefillOrganizationId || null],
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
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || 'The fee could not be calculated');
      }
      return json;
    },
    enabled: !!enabled && !!form?.id && !!match,
    staleTime: 60 * 1000,
    retry: false,
  });

  return {
    matched: !!match,
    quote: query.data || null,
    loading: !!match && (query.isLoading || query.isFetching),
    error: query.error ? (query.error.message || 'The fee could not be calculated') : null,
    refetch: query.refetch,
  };
}
