# Zoom confirmation retry protection

Both change-Zoom endpoints require `resendConfirmations: true` and a UUID
`confirmationOperationId` for explicit sends. The dialog generates the UUID
after consent, retaining it across batches and transport retries. Closing and
starting a new consented action creates a new operation.

Background registration (merged separately) uses its durable `requestKey`
instead of `confirmationOperationId`, and the background worker's own delivery
claims. Both endpoints validate the appropriate identity before accepting
explicit email consent. The schedule admin control also uses the shared dialog.

A service-only ledger identifies each booking by tenant, event/session scope,
resource, operation and booking. Its unique key atomically claims the send.
Completed claims replay their acknowledged result without sending again.
Claims are bound to the selected Zoom target and conversion choice.

An in-flight request, provider timeout, partial template delivery, or failure
to save the completion stamp does **not** release the claim. The API returns
an email-phase error rather than claiming success or sending again.
Administrators must check delivery before closing and starting a separate
resend. This is duplicate prevention, not an exactly-once delivery guarantee:
a crash before sending can leave an email unsent. No confirmation templates
or unsuccessful template results are reported as errors.

## Rollout

`supabase/migrations/202612310110_zoom_confirmation_delivery.sql` must precede
the API rollout. The hash-pinned destination-only runner is included in
`scripts/post-merge.sh`. It is offline by default:

    node scripts/apply-zoom-confirmation-delivery.mjs

This task did not apply the migration to a shared database or send real email.
If the table is missing, confirmation claims fail closed without email sends.
Ordinary confirmations outside these two endpoints are unchanged.

## Verification

    node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/zoomConfirmationDelivery.test.mjs api/events/changeZoomRegistration.test.mjs api/complex-event-sessions/changeZoomRegistration.test.mjs client/src/components/events/changeZoomWorkflow.test.mjs client/src/components/events/ChangeZoomDialog.mounted.test.mjs scripts/zoom-confirmation-delivery.postgres.test.mjs

Tests cover both handlers with real retry orchestration, lost HTTP responses,
concurrent retries, deliberate later resends, missing consent/identity,
uncertain provider responses and final writes, partial template sends,
claim failures, and PostgreSQL uniqueness and role grants.
