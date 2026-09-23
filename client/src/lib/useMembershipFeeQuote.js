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
  const key = useMemo(() => membershipQuoteKey(match, formValues, form), [match, formValues, form]);

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
        throw new Error(json.error || 'The fee could not be calculated');
      }
      return json;
    },
    enabled: !!enabled && !!form?.id && !!match,
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
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
