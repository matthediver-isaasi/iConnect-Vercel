# Per-registrant survey invitations

The Event Registration Report has a survey-envelope action for confirmed
registrations. It is disabled without an open, active, published event survey.
Removed assignments and future/closed response windows are excluded.

When attendance controls exist, the action is suppressed for registrations
without qualifying attendance. The server independently verifies current
provider outcomes against active targets or recorded QR check-ins. Source
event/session/agenda policies are checked even before the first provider sync.
Inactive historical provider targets do not become permission to send to
unverified attendees.

For events without attendance controls, the dialog warns that attendance is
unverified and requires explicit acknowledgement. All sends require preview
and confirmation. Multiple open surveys are selected explicitly.

The email goes to the booking's attendee address, never an inferred purchaser
or member address. The preview shows recipient, subject and the same HTML body
used for delivery. Links use the existing assignment token and trusted tenant
domain, preserving survey login and response rules. This does not create
certificate entitlements or change survey access. Email tracking and appended
footers are disabled for this fixed transactional message so the preview body
and assignment URL are preserved.

Server-side revalidation and a content fingerprint detect recipient, survey and
attendance changes after preview. A durable request ID prevents replay.
Concurrent or uncertain sends for the same registration/assignment are blocked.
There is deliberately no automatic retry of an uncertain provider outcome.
Provider acceptance is not proof of inbox delivery.

## Database rollout

Owner-approved migration `202612310050_registrant_survey_delivery.sql` applied
to verified DEST on 4 November 2026. SHA-256:
`8ffc8370fbcfad26919f23680f0e43dbaceee3b4fb71f497fcadd894672ab511`.
No email was sent during implementation or verification. Delivery table was
empty after migration. RLS, no browser grants, immutable recipient provenance,
and narrowly granted delivery-status updates were verified.

## Verification

Run the disposable PostgreSQL test separately from the isolated API/UI tests:

```sh
node --test api/_lib/registrantSurveyEmail.postgres.test.mjs
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/registrantSurveyEmail.test.mjs \
  client/src/components/events/RegistrantSurveyEmailAction.test.mjs \
  api/_lib/surveyAssignment.test.mjs
```

The local PostgreSQL harness creates and removes its own temporary database;
it is not a DEST test. The isolated tests mock all email sends.

The migration is additive; rolling back application code leaves its delivery
history intact. Do not drop the table or delete uncertain delivery rows to
retry emails. Reconcile provider evidence before changing an uncertain status.
