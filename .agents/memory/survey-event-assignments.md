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
