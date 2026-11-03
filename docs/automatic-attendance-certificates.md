# Automatic attendance certificates

Qualifying attendance now uses the existing certificate renderer and delivery
service after the CPD points attempt and before completing that attendance outbox
item. This is generic to standard and complex event bookings.

- Only a current `attended` outcome can enter automatic sending.
- Existing template, recipient, eligibility, retained-PDF and survey-grant checks
  still apply. No custom email template is required: the system message remains
  available.
- Guests may receive a certificate where the normal certificate eligibility
  rules allow it. This does not create a member account or invent a CPD ledger
  award. A missing member award requiring administrator confirmation is never
  overridden automatically.
- Any prior accepted attendee certificate prevents an automatic resend. Test
  sends and badge notifications are separate purposes.
- Concurrent attempts use a deterministic delivery request and the existing
  database claim. A definite failed delivery can be retried; pending or unknown
  delivery requires reconciliation, never an automatic resend.
- Rendering/provider failures keep the points outbox retryable. Repeated points
  processing remains idempotent. The worker claims one item at a time and stops
  claiming after its short time budget, so PDF work does not strand a batch of
  unstarted claims.

The server-only adapter injects a system context into the shared delivery handler.
No public authentication bypass or new HTTP endpoint was added. Audit actor is
`system:attendance-certificate`.

## Deployment and recovery

No schema migration is required. Deploy the application changes to enable this
for future cron runs. Previously completed outbox items are not silently reopened.

The approved event recovery script is
`scripts/recover-approved-bnms-attendance-certificates.mjs`.
Default execution checks eligibility without sending; `--send` sends the approved
39 qualifying bookings through the same idempotent service. It targets DEST and
refuses a changed cohort count. It does not send to below-threshold, absent or
ambiguous bookings.

Tests:

`node --test api/_lib/automaticAttendanceCertificate.test.mjs api/_lib/attendeeCpdCertificate.test.mjs api/_lib/eventCpdPointsService.test.mjs`
