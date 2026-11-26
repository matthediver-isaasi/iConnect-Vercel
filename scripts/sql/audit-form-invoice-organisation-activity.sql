-- Read-only, all-tenant audit. Execute only on the verified current production
-- destination. No names, form answers, addresses, affiliations or provider calls.
-- A candidate is evidence for review, NEVER authorization to update a live row.
WITH scoped AS (
  SELECT s.id, s.tenant_id, s.form_id, s.created_date, s.organization_id,
    s.payment_provider, s.payment_amount, s.payment_currency,
    s.payment_meta->'invoice_order' AS authority,
    s.payment_meta#>'{invoice_order,snapshot}' AS snapshot,
    s.payment_meta#>'{invoice_order,snapshot,organizationCustomer}' AS customer,
    q.queue_count, q.queue_authority_matches, q.customer_binding_matches,
    q.queue_has_invoice
  FROM public.form_submission s
  LEFT JOIN LATERAL (
    SELECT count(*) AS queue_count,
      bool_and(
        aq.snapshot = s.payment_meta#>'{invoice_order,snapshot}'
        AND aq.provider = s.payment_meta#>>'{invoice_order,provider}'
        AND aq.company_id = s.payment_meta#>>'{invoice_order,companyId}'
        AND aq.connection_id = s.payment_meta#>>'{invoice_order,connectionId}'
      ) AS queue_authority_matches,
      bool_and(
        aq.company_id = s.payment_meta#>>'{invoice_order,snapshot,organizationCustomer,companyId}'
        AND aq.connection_id = s.payment_meta#>>'{invoice_order,snapshot,organizationCustomer,connectionId}'
      ) AS customer_binding_matches,
      bool_and(nullif(aq.invoice_result->>'id', '') IS NOT NULL) AS queue_has_invoice
    FROM public.accounting_request_queue aq
    WHERE aq.tenant_id = s.tenant_id
      AND aq.source_type = 'form_invoice_order'
      AND aq.operation = 'invoice' AND aq.source_id = s.id::text
  ) q ON true
  WHERE s.payment_provider = 'invoice'
    OR s.payment_meta ? 'invoice_order' OR q.queue_count > 0
), verified AS (
  SELECT s.*, o.id AS tenant_valid_organization_id,
    coalesce(
      s.payment_provider = 'invoice'
      AND s.authority->'version' = '1'::jsonb
      AND s.customer->'version' = '1'::jsonb
      AND s.snapshot#>>'{linkage,formId}' = s.form_id::text
      AND s.authority->'amount' = to_jsonb(s.payment_amount)
      AND s.authority->>'currency' = s.payment_currency
      AND s.customer->>'contactId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND s.queue_count = 1 AND s.queue_authority_matches
      AND s.customer_binding_matches AND o.id IS NOT NULL,
      false
    ) AS trusted_authority
  FROM scoped s
  LEFT JOIN public.organization o ON o.tenant_id = s.tenant_id
    AND o.id = CASE
      WHEN s.customer->>'organizationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (s.customer->>'organizationId')::uuid
      ELSE NULL
    END
), classified AS (
  SELECT *, CASE
    WHEN nullif(customer->>'organizationId', '') IS NULL
      THEN 'excluded_no_frozen_organization_id'
    WHEN tenant_valid_organization_id IS NULL
      THEN 'excluded_invalid_or_non_tenant_organization'
    WHEN NOT trusted_authority THEN 'excluded_unverified_authority'
    WHEN organization_id IS NULL THEN 'candidate_requires_approval'
    WHEN organization_id = tenant_valid_organization_id THEN 'already_linked'
    ELSE 'excluded_conflicting_existing_link'
  END AS classification
  FROM verified
)
SELECT now() AS audited_at,
  (SELECT count(*) FROM public.accounting_request_queue
    WHERE source_type = 'form_invoice_order' AND operation = 'invoice') AS invoice_queue_rows,
  (SELECT count(*) FROM public.accounting_request_queue aq
    WHERE aq.source_type = 'form_invoice_order' AND aq.operation = 'invoice'
      AND NOT EXISTS (SELECT 1 FROM public.form_submission s
        WHERE s.tenant_id = aq.tenant_id AND s.id::text = aq.source_id)) AS orphaned_queue_rows,
  (SELECT count(*) FROM classified) AS scoped_submissions,
  (SELECT count(*) FROM classified WHERE organization_id IS NULL) AS missing_organization,
  (SELECT count(*) FROM classified WHERE classification = 'candidate_requires_approval') AS candidates,
  (SELECT count(*) FROM classified WHERE classification = 'already_linked') AS already_linked,
  (SELECT jsonb_agg(to_jsonb(counts) ORDER BY classification)
    FROM (SELECT classification, count(*) AS submissions
      FROM classified GROUP BY classification) counts) AS classification_counts,
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'submission_id', id, 'tenant_id', tenant_id, 'form_id', form_id,
    'created_date', created_date, 'organization_id', organization_id,
    'frozen_organization_id', customer->>'organizationId',
    'tenant_valid_organization_id', tenant_valid_organization_id,
    'trusted_authority', trusted_authority, 'classification', classification,
    'queue_count', queue_count, 'queue_authority_matches', queue_authority_matches,
    'queue_has_invoice', queue_has_invoice
  ) ORDER BY created_date, id), '[]'::jsonb) FROM classified) AS submissions;
