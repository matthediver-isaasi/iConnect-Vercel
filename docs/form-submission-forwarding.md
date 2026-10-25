# Forwarding form submissions

Form Submissions management users can forward one submission to an active member
of the tenant's default organisation with a valid email address. Both member search
and server-side send/retry checks enforce that organisation; missing or ambiguous
default-organisation configuration blocks forwarding. The action includes a TipTap message
and visible recipient, creation/sent time, delivery state, expiry and revocation.

The email contains no answers. Its seven-day, read-only link uses a random
256-bit bearer in a URL fragment. Only its SHA-256 hash is persisted. The isolated
viewer clears the fragment, avoids application analytics, disables caching and
referrers, and uses the existing rate-limited attachment/answer transport.
Anyone with the emailed link can view until expiry/revocation; the picker does
not make the public link identity-bound.

## Permissions and privacy

- Server enforcement uses Form Submissions management permission, including
  tenant-owned role and individual feature exclusions, not FormBuilder permission.
- Recipients must belong to the tenant. Database insertion independently checks
  the selected member and recipient email.
- Shared projection enforces published survey-version anonymity and cohort
  thresholds on send and each view. Anonymous attachments stay hidden.
- A saved form-definition snapshot is preferred. Older ordinary submissions
  without one use the current form fields; surveys always use their stored
  published version. Raw payment metadata/internal fields are not exposed.
- Deleting the submission removes the share. Revoking one forward does not revoke
  automatic alert links or other forwards.

## Delivery and recovery

Each request has a tenant-scoped idempotency key. A retry must retain submission,
member, actor and sanitized message. Definitive provider rejection can be
explicitly retried through a compare-and-set claim; uncertain/sending outcomes
are never automatically resent. Successful provider acceptance is shown as
“Sent”, not proof of delivery/opening.

If the process dies during delivery or finalization, the request can remain
“Sending”. Investigate provider acceptance before making another request.
Unknown outcomes have no active bearer. No raw links are returned by admin
history, persisted, logged or tracked in email.

## Rollout

Apply `supabase/migrations/20261216_form_submission_forwarding.sql` to the
approved application database before deploying the updated code. It creates a
service-only RLS-protected table and recipient-validation trigger; it does not
alter existing submissions or send emails. The existing form-alert schema is a
prerequisite.

Verification covers mocked API delivery, capability reads, UI state and an
isolated PostgreSQL migration/access check. No real member email is sent by tests.

### Live storage verification

Applied on 25 October 2026 to approved live DEST (`lvmzliemqnieeoruhkik`).
Migration SHA-256:
`5456e2ef0abff59c5c6c7111c13c0a50e968c5ca267cf5f5406f8b65501c683e`.
Verified RLS, denied anonymous/authenticated access, narrow service-role column
updates, no service-role delete, enabled recipient guard, submission foreign key
and idempotency uniqueness. The initial transaction rolled back when the
production default grants were detected; the corrected migration explicitly
revokes those defaults, with a regression fixture reproducing them.
No submission data changed, no forward rows created and no emails sent.
Application-code deployment remains separate.
