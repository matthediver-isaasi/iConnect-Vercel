---
name: Survey event assignments
description: Durable decisions for event-assigned surveys — exclusive assignment links, context-scoped dedupe, DB-boundary archive-not-delete.
---

# Survey event assignments — durable decisions

- **Reusable campaign survey links resolve at send time, not when a template
  is saved.** `{{event_survey_url}}` and `[[event.survey_url]]` use explicit
  `email_campaign.event_survey_context` (`event_type`, `event_id`,
  `assignment_id`), or the canonical automated `event_email.event_id` plus
  `event_survey_assignment_id`. Never infer an event from recipient booking
  history. Exactly one active assignment can be automatic; multiple require
  selection on the campaign/email configuration, not the shared template.
  **Why:** persisted recipients, scheduling and retries outlive authoring;
  assignments/forms can close, be archived or change publication state.
  **How to apply:** reuse `campaignEventSurvey.js` before generic placeholder
  substitution/link tracking and revalidate during delivery. Use existing
  assignment tokens and the trusted tenant URL helper, never Origin, minted
  tokens, frozen template URLs or relaxed access checks. Validation currently
  requires the assignment to be open even when scheduling for a future date.
  The additive columns live in
  `migrations/20260901_campaign_event_survey_context.sql`; its destination-only
  runner is `scripts/apply-campaign-event-survey-context.mjs`.

- **Assignment links are exclusive.** While a survey has any ACTIVE event
  assignment, the plain slug URL neither serves nor accepts responses.
  **Why:** respondent dedupe is scoped per response context (per-assignment
  vs per-form); coexisting paths would let a respondent double-submit by
  switching URLs. **How to apply:** any new survey entry point must carry an
  assignment token or re-check the active-assignment block.
- **Dedupe is context-scoped but race-safe with the existing unique index:**
  same respondent + same context hash to the same key, so no index change is
  needed when adding a new scope component.
- **Archive-not-delete is enforced at the DB boundary,** not just the API: a
  BEFORE DELETE guard trigger on the assignment table rejects deletes when
  responses exist, which also blocks the form→assignment FK cascade — so
  deleting a survey form with responded assignments fails and historic
  attribution survives. Response-less assignments still cascade cleanly.
  A rollback-only transactional verify script proves this against the real DB.
- **Replacing a SECURITY DEFINER function must re-issue its REVOKE/GRANT
  lockdown in the same migration** — CREATE OR REPLACE keeps grants on an
  existing deployment but defaults to PUBLIC-executable on a fresh one.
  Code review rejects the omission.

- **Certificate survey links are not assignment tokens.** A CPD certificate
  send creates/reuses one service-only entitlement per tenant, booking source,
  booking and assignment, plus a new hashed-only credential per actual send.
  Each credential is bound to a pending certificate delivery claim; the
  accepted delivery ledger row itself authorizes redemption, with no second
  activation write that could fail after provider acceptance. Pending,
  unknown and failed deliveries stay inactive; failed credentials may also
  be revoked. Preview never mints either.
  An answered entitlement cannot be reopened on resend. The URL credential
  lives in a fragment, is stripped synchronously in the HTML head before app
  analytics, and is passed to the assignment GET in a header and to survey
  submission in the body, never a route path or query. Keep the plain
  assignment/slug member-only policy unchanged; only the invitation-bearing
  assignment route can bypass it. The service-only SQL RPC locks entitlement
  and booking, rechecks confirmed attendee/email/event, current publication
  and response window, inserts response and completion in one transaction.
  The entitlement keeps a service-only response_id FK so staff can reconcile
  completion, but report routes never expose or join it: anonymous survey
  results remain redacted in their reporting rows. See
  `supabase/migrations/20261121_certificate_survey_grants.sql` and the
  dry-run-by-default pinned DEST runner
  `scripts/apply-certificate-survey-grants.mjs`.

## Campaign invitations share entitlement, not certificate delivery provenance
Campaign survey placeholders must generate attendee-authorised links, not plain
assignment URLs. Real and source-recipient test sends share the attendee's
booking/assignment entitlement but keep separate campaign delivery evidence.

**Why:** Rendering a populated survey list with ordinary assignment URLs passed
HTML tests but forced logged-out attendees to sign in. A source recipient gives
personalisation context, not access authority by itself.

**How to apply:** Verify generated-link redemption and submission, not just HTML.
Only accepted delivery authorises a credential. Never fabricate certificate
delivery for a campaign. Keep invitation fragments out of click-tracking URLs,
and disable provider tracking for invitation-bearing messages.
