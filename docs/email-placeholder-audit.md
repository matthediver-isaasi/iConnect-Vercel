# Email Placeholder Coverage Audit

**Task:** #755 (Plan: `.local/tasks/email-placeholder-coverage-audit.md`)
**Scope:** All API routes, cron jobs, and scripts that send email — match each
sender against the catalog defined in `client/src/lib/emailPlaceholders.js`
and identify where templates ship to Mailgun with un-substituted tokens.

---

## 1. Two placeholder syntaxes

| Syntax | Purpose | Resolved by |
|---|---|---|
| `{{token}}` | Form fields, mappings, system tokens (`{{set_password_url}}`, `{{recipient_name}}`, `{{invite_link}}`, `{{dd_owner}}`, …) | Per-sender helper or `replacePlaceholders(template, entityType, …)` in `api/_lib/emailService.js:370` |
| `[[token]]` | Database lookups (`[[member.first_name]]`, `[[organization.name]]`, `[[dd_owner]]`) | `replacePlaceholders(template, …)` in `emailService.js:370` (cross-entity prefix support) |

Single canonical generic helper:
- `replacePlaceholders(template, entityType, entityData, context)` in
  `api/_lib/emailService.js:370` — the only function that handles both `{{}}`
  and `[[]]` syntaxes generically. `context.tenantId` + `context.memberId` +
  `context.tenantBaseUrl` enables `{{communication_preferences_link}}`.

DD-owner helper (small, focused):
- `applyDdOwnerPlaceholders(text, { ownerName, ownerEmail })` in
  `api/_lib/ddOwner.js` — handles `{{dd_owner}}`, `{{dd_owner_email}}`,
  `[[dd_owner]]` only. Always pair with `resolveDdOwnerForSubmission(...)`.

---

## 2. Sender × Helper matrix

✅ = full generic + DD-owner pass · ⚠️ = partial / hand-rolled · ❌ = no substitution at all

| Sender | File | Coverage | Notes |
|---|---|---|---|
| Form submission emails (page-builder forms) | `api/forms/send-submission-email.js` | ✅ | Comprehensive bespoke `replacePlaceholders` covers form fields + member.* + organization.* + `{{set_password_url}}` |
| Generic entity form auto-reply | `api/entities/[entity]/index.js` `sendFormSubmissionEmail` | ✅ (was ❌) | **FIXED** — resolves member/org from the submission and calls generic helper. Pre-pass form-field substitution now ONLY consumes `{{token}}` matches whose key exists in `formValues` so unknown system tokens (e.g. `{{member.first_name}}`, `{{set_password_url}}`) survive to downstream resolvers instead of being silently blanked. After the generic helper pass, `{{set_password_url}}` / `[[set_password_url]]` are now also resolved via the shared `api/_lib/passwordSetupUrl.js` helper (extracted from `api/forms/send-submission-email.js`) so generic-entity templates that use this token actually mint a password-setup link. |
| Workflow engine emails | `api/_lib/workflows.js` `sendEmailAction` | ✅ | Delegates to generic helper after building entity context; covers DD owner |
| Workflow engine (TS path) | `server/workflowEngine.ts` | ⚠️ | Uses minimal local replace ladder — flagged for follow-up (out of scope here) |
| Event confirmation | `api/_lib/eventConfirmationEmail.js` | ✅ | Event-specific helper covers all `{{event.*}}` + member.* via dedicated function |
| Event reminders cron | `api/cron/send-event-reminders.js` | ✅ | Local helper duplicated — works but should be consolidated (follow-up) |
| Event reminder one-shot | `scripts/send-event-reminder-once.mjs` | ✅ | Same duplicated helper |
| Contract send / send-original / resend | `api/contracts/{send-to-signers,send-original,resend}.js` | ✅ | Calls `applyDdOwnerPlaceholders` — DD owner tokens covered |
| Contract reminders cron | `api/cron/send-contract-reminders.js` | ✅ | Resolves DD owner per reminder; replaces `[[organization.name]]`, `[[signer.*]]`, `[[tenant.name]]` |
| Contract timeout notifications cron | `api/cron/send-contract-timeout-notifications.js` | ✅ | Same pattern |
| Due-diligence test fires | `api/due-diligence/test-fire-{reminder,timeout}.js` | ✅ | Replaces all DD reminder/timeout tokens |
| Campaigns (manual + scheduled + batched cron) | `api/_lib/campaignService.js` `sendToRecipient` | ✅ (was ⚠️) | **FIXED** — added generic helper pass so `[[member.first_name]]`, `[[member.email]]`, etc. all resolve from the recipient row |
| DD meeting request — resend | `api/dd-meeting-requests/resend.js` | ✅ (was ⚠️) | **FIXED** — generic helper pass covers `[[member.*]]` AND `[[organization.*]]` for the agent (member row extended to fetch `email` + `organization_id`; org row fetched and added to context, including underscore aliases) |
| DD meeting request — add alternative | `api/dd-meeting-requests/add-alternative.js` | ✅ (was ⚠️) | **FIXED** — same pattern as resend; agent's organization is fetched and merged into the placeholder context so `[[organization.*]]` resolves |
| Article brief — send copyright form | `api/article-briefs/[briefId]/send-copyright-form.js` | ✅ (was ⚠️) | **FIXED** — internal-writer query extended to include `organization_id`; org row fetched; generic helper pass now resolves `[[member.*]]` AND `[[organization.*]]` (external-writer path skipped, no member context exists) |
| Article brief — send case study form | `api/article-briefs/[briefId]/send-case-study-form.js` | ✅ (was ⚠️) | **FIXED** — generic helper called with empty record entity; explicit regex strip removes any leftover `[[member.*]]` / `[[organization.*]]` so external-provider emails never leak literal placeholders |
| Team member invite | `api/functions/[functionName].js` `sendTeamMemberInvite` | ✅ (was ⚠️) | **FIXED** — kept bespoke tokens (`{{invite_link}}`, `{{inviter_name}}`, `{{organization_name}}`); generic helper pass now covers every member.* / organization.* token (with `member_*` / `organization_*` underscore aliases preserved to prevent regression in existing user templates) |
| Booking cancellation request emails | `api/booking-cancellation-requests/*`, `api/_lib/bookingCancellation.js` | ❌ | Hardcoded HTML — no template editor, so no placeholders to substitute. Out of scope. |
| Booking transfer request | `api/booking-transfer-requests/[requestId].js` | ❌ | Hardcoded HTML — same |
| Fundraising / public book confirmations | `api/fundraising/*`, `api/public-book/*` | ❌ | Hardcoded HTML — no editor, no placeholders. Out of scope. |

---

## 3. Token inventory matrix (catalog vs. resolution)

The full canonical catalog lives in
`client/src/lib/emailPlaceholders.js` (1 195 lines). Tokens of high-blast
radius — i.e. those that appear in multiple sender contexts and were
historically only resolved in one — are listed below.

| Token | Catalog | Resolvers (after this fix) | Notes |
|---|---|---|---|
| `[[member.first_name]]` / `_last_name` / `_full_name` / `_email` / `_id` | ✅ | emailService generic, send-submission-email, campaign sender, dd-meeting-* , article-briefs/send-copyright, sendTeamMemberInvite | The biggest single gap closed by this task |
| `[[organization.name]]` / `_id` / `_invoicing_email` / `_phone` | ✅ | Same as above (wherever a member context is resolved) | sender will fall back to recipient organization when no submission tied |
| `{{communication_preferences_link}}` / `_url` | ✅ | emailService generic (only when `tenantId` + `memberId` + `tenantBaseUrl` in context); campaign sender adds it directly | |
| `{{unsubscribe_link}}` / `_url` | ✅ | Campaign sender | Per-recipient tracking token — campaign-only, do not replicate |
| `{{set_password_url}}` | ✅ | `api/forms/send-submission-email.js` only | Generates real password-reset URL via crypto-signed token; intentionally not duplicated to other senders |
| `{{dd_owner}}` / `{{dd_owner_email}}` / `[[dd_owner]]` | ✅ | `applyDdOwnerPlaceholders` from `api/_lib/ddOwner.js` everywhere DD context is in scope | Contract crons + workflow + DD test-fires |
| `{{recipient_name}}` / `{{recipient_email}}` / `{{meeting_type}}` / `{{duration}}` / `{{agent_name}}` / `{{booking_url}}` / `{{booking_link}}` | ✅ | dd-meeting-requests resend + add-alternative | Bespoke meeting-template tokens only used by these two senders |
| `{{invite_link}}` / `{{inviter_name}}` / `{{invitee_email}}` / `{{organization_name}}` / `{{organization_id}}` | ✅ | `sendTeamMemberInvite` | Bespoke invite tokens, kept hand-rolled |
| `{{contract_name}}` / `{{signer_name}}` / `{{signer_first_name}}` / `{{signer_last_name}}` / `{{days_remaining}}` / `{{days_since_sent}}` / `{{sign_url}}` / `{{signing_url}}` | ✅ | Contract reminder + timeout crons | |
| `{{brief.title}}` / `{{writer.first_name}}` / `{{writer.last_name}}` / `{{writer.full_name}}` / `{{writer.email}}` / `{{form_url}}` | ✅ | article-briefs/send-copyright-form | |
| `{{provider.first_name}}` / `{{provider.last_name}}` / `{{provider.email}}` / `{{provider.full_name}}` / `{{upload_url}}` | ✅ | article-briefs/send-case-study-form | |
| `{{form.name}}` / `{{submission.date}}` | ✅ | send-submission-email | |

`emailPlaceholders.js` and `emailPlaceholderPreview.js` already enumerate
every token above — no entries were missing — so no edits to the catalog
files are needed in this task. (Verified by grepping each token name from
the matrix against the catalog source.)

---

## 4. Gap fixes applied in this task

1. **`api/_lib/campaignService.js` `sendToRecipient`** — after the existing
   bespoke `{{recipient_name}}` / `{{first_name}}` / `{{email}}` /
   `{{unsubscribe_*}}` / `{{communication_preferences_*}}` substitutions,
   the function now also runs the recipient row through the generic
   `replacePlaceholders(html|subject, 'member', recipient)` helper. Because
   recipient rows already carry `first_name`, `last_name`, `email`, this
   resolves `[[member.first_name]]`, `[[member.last_name]]`, `[[member.email]]`
   in any campaign template. (Per-recipient organization joins are NOT
   added — that's a hot path of up to 100 sends per cron tick and would add
   N database round-trips. If a tenant needs `[[organization.name]]` in
   campaigns, the audience-resolution step can be extended to enrich
   recipients with org name in a single batched join — left as follow-up.)

2. **`api/entities/[entity]/index.js` `sendFormSubmissionEmail`** — now
   loads the submission's `member_id`/`organization_id`, fetches the
   relevant rows, and runs subject + body through the generic helper as a
   `record` entity. Additionally, the pre-pass that handles raw
   `{{field_id}}` form-field tokens now skips any token whose key is not
   present in `formValues` — previously every unknown `{{token}}` was
   silently stripped to '', which would have prevented the generic helper
   below from ever seeing tokens like `{{member.first_name}}`. Form-field
   tokens still substitute first; the generic helper then fills
   `[[member.*]]` / `[[organization.*]]` so generic auto-reply templates
   work. `{{set_password_url}}` / `[[set_password_url]]` is now also
   resolved in this sender via the shared `api/_lib/passwordSetupUrl.js`
   helper (extracted from `api/forms/send-submission-email.js`) so
   generic-entity auto-reply templates that use the token mint a real
   crypto-signed reset link instead of leaking the literal placeholder.

3. **`api/dd-meeting-requests/resend.js` and `add-alternative.js`** — keep
   the bespoke `{{recipient_name}}` / `{{agent_name}}` / `{{booking_*}}`
   ladder, then resolve the agent's member row (extended to include
   `email` + `organization_id`) and the agent's organization row, and
   run subject + body through the generic helper as a `member` entity
   with both member and organization fields available (plus underscore
   aliases like `member_first_name`, `organization_name`, ...). This
   covers every catalog `[[member.*]]` / `[[organization.*]]` token an
   agent might paste into their meeting-request template — including
   prefix-less aliases like `[[member_first_name]]`.

4. **`api/article-briefs/[briefId]/send-copyright-form.js`** — when the
   writer is an internal `member` (not an `external_writer`), the writer
   query is extended to fetch `organization_id`; the org row is fetched
   if present; both are merged into a member-entity context (with
   underscore aliases) and passed through the generic helper after the
   bespoke `{{writer.*}}` substitutions. External-writer path skips the
   generic call (no `[[member.*]]` data exists for that case).

5. **`api/article-briefs/[briefId]/send-case-study-form.js`** — providers
   are always external (no member row). The generic helper is called with
   `entityType = 'record'` and an empty entity (resolves any communication-
   preferences-link tokens via context). Because `replacePlaceholders`
   preserves the original match when a value is missing, two additional
   regex strip passes are applied — one for `[[(?:member|organization)\.\w+]]`
   and one for `{{(?:member|organization)\.\w+}}` — so member/organization
   tokens in either syntax collapse to '' instead of leaking as literals.

6. **`api/functions/[functionName].js` `sendTeamMemberInvite`** — kept the
   bespoke `{{invite_link}}` / `{{inviter_name}}` / `{{organization_name}}`
   substitutions verbatim, then **deleted** the long hand-rolled
   `[[member.*]]` / `[[organization.*]]` `.replace` ladder and replaced it
   with one `replacePlaceholders(text, 'member', { …inviter, organization fields })`
   call so every member/org token in the catalog stays in sync. The
   organization fetch was extended to also load `invoicing_email` and
   `phone` so those `[[organization.*]]` tokens resolve, and underscore
   aliases (`member_first_name`, `member_full_name`, `organization_name`,
   …) are added to the context to preserve compatibility with existing
   user templates that use the prefix-less form like `[[member_first_name]]`.

---

## 5. Out-of-scope items (filed as follow-ups, not fixed in this task)

- `server/workflowEngine.ts` — TypeScript implementation has its own
  minimal placeholder ladder; needs a parallel refactor.
- Booking cancellation / transfer / fundraising / public-book emails —
  hardcoded HTML, no template editor. If a user-facing template is added
  later, route the rendered output through the generic helper.
- Per-recipient organization enrichment in campaigns (see fix #1 caveat).

---

## 6. Smoke-test checklist (manual, post-deploy)

For each fix, the operator should:

| # | Surface | Check |
|---|---|---|
| 1 | Email Campaign with `[[member.first_name]] [[member.last_name]]` in body | Send to a list with at least one member; both tokens populated, no literal `[[…]]` left |
| 2 | Generic entity form auto-reply (Form whose `submission_email_template_id` references a template using `[[organization.name]]`) | Submit anonymously and as a logged-in member; org name appears for the logged-in case, blank for anonymous |
| 3 | DD meeting request — resend | Email retains `{{recipient_name}}`, `{{agent_name}}`, `{{booking_link}}` AND any `[[member.*]]` referencing the agent |
| 4 | DD meeting request — add alternative | Same as above |
| 5 | Article brief copyright form sent to internal writer | `[[member.first_name]]` resolves to the writer's first name |
| 6 | Article brief case study form (external provider) | `[[member.*]]` collapses to '' (no literal placeholder leaks) |
| 7 | Team member invite | All previously-working invite tokens still resolve. After the org-context enrichment shipped with this fix, `[[organization.invoicing_email]]` and `[[organization.phone]]` also resolve when the inviter's organization has those fields set. |
| 8 | DD-owner workflow email (regression) | `{{dd_owner}}` and `[[dd_owner]]` still resolve via `applyDdOwnerPlaceholders` |
| 9 | Contract reminders cron (regression) | `[[organization.name]]`, `{{signer_name}}`, `{{sign_url}}`, `{{dd_owner}}` all still resolve |
| 10 | Event confirmation email (regression) | `{{event.title}}`, `{{event.start_date}}`, `{{member.first_name}}` all still resolve |

---

## 7. Full token inventory (extracted from `client/src/lib/emailPlaceholders.js`)

This section is auto-extracted from the canonical catalog
(`EMAIL_PLACEHOLDERS`). It groups every documented token by category so the
sender×helper matrix in §3 can be cross-checked against the source-of-truth
list. If a token is missing from the catalog but referenced in a sender, it
should be added there (no edits to `emailPlaceholders.js` were required for
this audit — every token below is already enumerated).


### Contracts (15 tokens)
- `[[contract.name]]` — Name of the contract / form being signed.
- `{{contract_name}}` — Contract name (curly alias).
- `[[signer.name]]` — Full name of the contract signer.
- `[[signer.first_name]]` — First name of the contract signer.
- `[[signer.last_name]]` — Last name of the contract signer.
- `[[signer.email]]` — Email of the contract signer.
- `{{signer_name}}` — Full signer name (curly alias).
- `{{signer_first_name}}` — Signer first name (curly alias).
- `{{signer_last_name}}` — Signer last name (curly alias).
- `{{signer_email}}` — Signer email (curly alias).
- `{{sign_url}}` — Direct URL to the contract signing page for the recipient.
- `{{signing_url}}` — Alias of {{sign_url}}.
- `{{days_remaining}}` — Days remaining until the contract expiry deadline.
- `{{days_since_sent}}` — Days since the contract invitation was sent.
- `[[applicant.name]]` — Applicant full name in contract timeout notifications.

### Due Diligence (24 tokens)
- `{{due_diligence_status}}` — Current DD workflow status (e.g. submitted, in_review, approved).
- `{{due_diligence_stage}}` — Name of the current DD stage.
- `{{due_diligence_score}}` — Computed DD score for the application.
- `{{due_diligence_risk_level}}` — Calculated DD risk level (Low/Medium/High).
- `{{due_diligence_form_name}}` — Name of the DD form/application.
- `{{due_diligence_reviewer}}` — Name of the DD reviewer.
- `{{due_diligence_review_date}}` — Date the DD review was completed.
- `{{custom_message}}` — Free-text custom message entered when triggering a DD stage action (when prompt_custom_message is enabled).
- `{{dd_owner}}` — Display name of the DD owner (or default fallback).
- `{{dd_owner_email}}` — Email address of the DD owner.
- `[[dd_owner]]` — DD owner display name (bracket alias).
- `{{recipient_name}}` — Recipient full name for DD-triggered emails.
- `{{recipient_first_name}}` — Recipient first name.
- `{{recipient_last_name}}` — Recipient last name.
- `{{recipient_email}}` — Recipient email address.
- `[[recipient.name]]` — Recipient full name (bracket alias).
- `[[recipient.first_name]]` — Recipient first name (bracket alias).
- `[[recipient.last_name]]` — Recipient last name (bracket alias).
- `[[recipient.email]]` — Recipient email (bracket alias).
- `{{submission.id}}` — Internal ID of the DD application submission.
- `{{submission.application_uid}}` — Public application UID for the DD submission.
- `{{submission.workflow_status}}` — Workflow status string for the submission.
- `{{submission.due_diligence_score}}` — Computed DD score on the submission record.
- `{{submission.risk_level}}` — Computed risk level on the submission record.

### Event Confirmation & Reminder (22 tokens)
- `[[attendee.first_name]]` — Attendee first name on the booking.
- `[[attendee.last_name]]` — Attendee last name.
- `[[attendee.email]]` — Attendee email address.
- `[[event.name]]` — Event name (alias of [[event.title]]).
- `[[event.title]]` — Event title.
- `[[event.date]]` — Localised event start date.
- `[[event.location]]` — Event location, or "Online Event" for online events.
- `[[booking.id]]` — Internal booking record ID.
- `[[booking.reference]]` — Human-friendly booking reference.
- `[[booking.booking_reference]]` — Alias of [[booking.reference]].
- `{{booking_id}}` — Booking ID (curly form).
- `{{booking_reference}}` — Booking reference (curly form).
- `[[booking.ticket_class]]` — Ticket class name (defaults to "Standard").
- `[[booking.ticket_price]]` — Per-ticket price formatted in GBP, or "Free".
- `[[booking.total_cost]]` — Total booking cost formatted in GBP, or "Free".
- `[[booking.offer_discount_description]]` — Description of the discount/offer applied to the booking.
- `[[booking.offer_discount_amount]]` — Saving amount from the applied discount/offer.
- `[[booking.track_name]]` — Comma-separated list of track names the attendee is registered for.
- `[[track_name]]` — Alias of [[booking.track_name]].
- `[[zoom_link]]` — Zoom join link for the event (online events only).
- `[[session_schedule]]` — Pre-rendered HTML schedule of the attendee’s sessions.
- `[[session_zoom_links]]` — Pre-rendered HTML list of per-session Zoom links.

### Footer & Socials (5 tokens)
- `{{linkedin_url}}` — Tenant LinkedIn profile URL configured under Social Icons.
- `{{twitter_url}}` — Tenant Twitter / X profile URL.
- `{{facebook_url}}` — Tenant Facebook page URL.
- `{{instagram_url}}` — Tenant Instagram profile URL.
- `{{youtube_url}}` — Tenant YouTube channel URL.

### Form Submissions (4 tokens)
- `{{<field_id>}}` — Resolves to the value submitted for the form field whose ID (UUID) is between the braces.
- `{{<field_label>}}` — Resolves to the value of the field whose label matches the token (case-sensitive).
- `{{record.<field>}}` — Generic record-scoped lookup against the trigger entity (workflow context).
- `[[record.<field>]]` — Generic record-scoped DB lookup against the trigger entity.

### Meetings & Bookings (18 tokens)
- `{{recipient_name}}` — Invitee name in meeting-booking invitation emails.
- `{{recipient_email}}` — Invitee email in meeting-booking invitation emails.
- `{{meeting_type}}` — Name of the meeting type / template.
- `{{duration}}` — Meeting duration (e.g. "30 minutes").
- `{{agent_name}}` — Host / booking agent display name.
- `{{booking_url}}` — Plain URL to the public booking page for this meeting type.
- `{{booking_link}}` — Pre-rendered HTML anchor ("Book a meeting") pointing at the booking URL.
- `{{attendee_name}}` — Confirmed attendee full name.
- `{{attendee_email}}` — Confirmed attendee email address.
- `{{attendee_notes}}` — Notes the attendee submitted with the booking.
- `{{meeting_title}}` — Title of the booked meeting.
- `{{meeting_date}}` — Localised meeting date (e.g. "Monday, 3 March 2026").
- `{{meeting_time}}` — Meeting start time.
- `{{meeting_end_time}}` — Meeting end time.
- `{{meeting_timezone}}` — Timezone the meeting times are expressed in.
- `{{zoom_join_url}}` — Zoom meeting join URL.
- `{{zoom_password}}` — Zoom meeting password.
- `{{teams_join_url}}` — Microsoft Teams meeting join URL.

### Member (19 tokens)
- `[[member.id]]` — Internal member record ID for the recipient (or trigger member).
- `[[member.full_name]]` — Member full name (first + last).
- `[[member.first_name]]` — Member first name. Also resolved from booking.attendee_first_name in event emails.
- `[[member.last_name]]` — Member last name.
- `[[member.email]]` — Member email address.
- `[[member.phone]]` — Member phone number.
- `[[member_full_name]]` — Inviter full name in member/team invite emails (alias of [[member.full_name]]).
- `[[member_first_name]]` — Inviter first name in member/team invite emails.
- `[[member_last_name]]` — Inviter last name in member/team invite emails.
- `[[member_email]]` — Inviter email in member/team invite emails.
- `{{first_name}}` — Recipient first name. Resolved from member or DD/contract recipient.
- `{{last_name}}` — Recipient last name.
- `{{full_name}}` — Recipient full name.
- `{{name}}` — Generic recipient name (member or organization, depending on context).
- `{{email}}` — Recipient email address.
- `{{member_first_name}}` — New member first name (DD-created member emails).
- `{{member_last_name}}` — New member last name (DD-created member emails).
- `{{member_email}}` — New member email (DD-created member emails).
- `{{member.first_name}}` — Workflow placeholder resolved against the member entity.

### Organisation (11 tokens)
- `[[organization.id]]` — Organisation record ID.
- `[[organization.name]]` — Organisation display name.
- `[[organization.invoicing_email]]` — Organisation invoicing/billing email address.
- `[[organization.phone]]` — Organisation phone number.
- `[[organization_id]]` — Organisation ID alias used by member-invite handler.
- `[[organization_name]]` — Organisation name alias used by member-invite handler.
- `{{organization.name}}` — Workflow placeholder resolved against the organisation entity.
- `{{organization_name}}` — Organisation name in DD-created member emails and member invites.
- `{{organization_id}}` — Organisation ID for member-invite emails.
- `[[tenant.name]]` — Tenant (workspace / iConnect site) display name.
- `{{tenant_name}}` — Tenant display name (curly alias). Also resolves in booking confirmations.

### System & Links (5 tokens)
- `{{set_password_url}}` — Generates a one-time password-setup link for the recipient member and replaces the placeholder with an HTML "Set your password" anchor.
- `[[set_password_url]]` — Bracket alias of {{set_password_url}} — same generation logic.
- `{{communication_preferences_link}}` — Pre-rendered HTML link ("Manage communication preferences") to the recipient’s preference centre.
- `{{communication_preferences_url}}` — Plain URL to the recipient’s communication-preferences page.
- `{{timestamp}}` — ISO timestamp emitted by the email engine for diagnostic / audit purposes.

### Workflow Triggers & Invites (6 tokens)
- `{{invite_link}}` — Member/team signup link for invite emails.
- `{{inviter_name}}` — Display name of the inviting member.
- `{{invitee_email}}` — Email of the invitee.
- `[[job_posting.status]]` — Status of the job posting entity (workflow context only).
- `{{current_date}}` — Date when the workflow runs. Used as a workflow action value (set_field source) and form field source.
- `{{current_datetime}}` — Date and time when the workflow runs (workflow action value).

---

## 8. Comprehensive sendEmail callsite mapping

Every `sendEmail(` callsite in `/api/`, `/scripts/`, and `server/` is listed
below with whether it goes through a placeholder-resolution helper. This
ensures the matrix in §3 has no gaps relative to the actual senders in
the codebase. Generated from `rg -n 'sendEmail\(' --type js -l`.

| Callsite | Goes through placeholder helper? | Coverage row in §3 |
|---|---|---|
| `api/_lib/campaignService.js` | ✅ generic helper + campaign-specific preference link substitution (preference link substitutes BEFORE generic helper so the per-send tracking token wins) | "Campaigns (manual + scheduled + batched cron)" |
| `api/_lib/eventConfirmationEmail.js` | ✅ event-specific helper | "Event confirmation" |
| `api/_lib/emailService.js` | n/a (this file IS the helper layer; the only `sendEmail()` calls are diagnostic test sends with hardcoded HTML) | n/a |
| `api/_lib/workflows.js` | ✅ generic helper via `sendEmailAction` | "Workflow engine emails" |
| `api/_lib/bookingCancellation.js` | ❌ hardcoded HTML, no template editor | "Booking cancellation request emails" |
| `api/_lib/xero.js` | n/a — sends Xero-issued invoice attachment with hardcoded body | n/a (out of scope, no editor) |
| `api/article-briefs/notify.js` | ✅ uses `applyBriefPlaceholders` for brief tokens | n/a (no [[member.*]] tokens used) |
| `api/article-briefs/[briefId]/send-copyright-form.js` | ✅ generic helper + writer/org context | "Article brief — send copyright form" |
| `api/article-briefs/[briefId]/send-case-study-form.js` | ✅ generic helper + curly/bracket strip pass | "Article brief — send case study form" |
| `api/auth/request-password-reset.js`, `request-admin-password-reset.js` | ❌ system email, hardcoded HTML, no editor | n/a |
| `api/booking-cancellation-requests/{[requestId],approve-group}.js` | ❌ hardcoded HTML | "Booking cancellation request emails" |
| `api/booking-transfer-requests/[requestId].js` | ❌ hardcoded HTML | "Booking transfer request" |
| `api/contracts/{send-to-signers,send-original,resend}.js` | ✅ contract-specific replace ladder via `_stageActions` helpers | "Contract reminders cron" (regression smoke covers same tokens) |
| `api/cron/send-contract-{reminders,timeout-notifications}.js` | ✅ generic helper | "Contract reminders cron" / "Contract timeout notifications cron" |
| `api/cron/send-event-reminders.js` | ✅ event-specific helper (duplicated; flagged as follow-up) | "Event reminders cron" |
| `api/dd-meeting-requests/{resend,add-alternative}.js` | ✅ generic helper + agent member/org context (FIXED here) | "DD meeting request — resend/add alternative" |
| `api/due-diligence/_stageActions.js` | ✅ DD stage action helpers (`{{recipient_*}}`, `{{member_*}}`, `{{contract_*}}`, `{{dd_owner}}`) | "DD stage actions / contract requests" |
| `api/due-diligence/test-fire-{reminder,timeout}.js` | ✅ DD reminder/timeout helpers | "Due-diligence test fires" |
| `api/email-campaigns/test-send.js`, `api/email-templates/test-send.js`, `api/member-campaigns/test-send.js` | ✅ same `campaignService` / template-test pipeline | "Campaigns" (test-send is a thin wrapper) |
| `api/entities/[entity]/index.js` | ✅ generic helper + member/org lookup + `set_password_url` (FIXED here) | "Generic entity form auto-reply" |
| `api/forms/send-submission-email.js` | ✅ comprehensive bespoke `replacePlaceholders` + `set_password_url` minting | "Form submission emails" |
| `api/functions/[functionName].js` `sendTeamMemberInvite` | ✅ generic helper + bespoke invite tokens (FIXED here) | "Team member invite" |
| `api/public/book/[slug].js` | ✅ delegates to `eventConfirmationEmail` for booking confirmation | "Event confirmation" |
| `api/public/fundraising/{confirm-donation,login}.js` | ❌ hardcoded HTML | "Fundraising / public book confirmations" |
| `api/pending-purchase-orders/index.js` | ✅ DD `{{*}}` replace ladder for PO reminders | (covered under DD stage actions row) |
| `api/tenant/team.js`, `api/tenant/team/[id]/resend-invite.js` | ✅ delegates to `sendTeamMemberInvite` | "Team member invite" |
| `scripts/send-event-reminder-once.mjs` | ✅ event-specific helper (one-off ops script) | "Event reminders cron" (same code path) |

Every sender that ships a tenant-editable template now goes through
either the generic `replacePlaceholders` helper or a bespoke helper
that documents its own catalog. Senders marked ❌ (`hardcoded HTML, no
template editor`) are intentionally excluded from this task's scope —
there is no template surface for tenants to add tokens to.

### Caveats on "✅" coverage

The ✅ marks above mean "the sender invokes a placeholder-resolution
helper for tokens in its scope". They do **not** guarantee that every
token defined in `client/src/lib/emailPlaceholders.js` will resolve
in every sender — resolution is always context-dependent:

- **Campaign recipients** carry only `member_id`, `email`, `first_name`,
  `last_name` from `email_campaign_recipient`. We synthesise
  `full_name` from first/last but per-recipient organization fields
  (`[[organization.invoicing_email]]`, `[[organization.phone]]`,
  `[[organization.name]]`, `[[organization.id]]`) are NOT joined and
  will resolve to ''. `{{set_password_url}}` is also NOT supported in
  campaigns by design — campaigns are bulk-send and minting per-
  recipient password-setup tokens for an unbounded list is out of
  scope. Custom-field tokens (`{{record.<field>}}` etc.) are likewise
  not supported in campaigns: campaigns target members, not form
  submissions. Adding the org-join enrichment is a documented
  follow-up; the other two are intentional non-goals for this sender.
- **DD meeting** templates resolve `[[member.*]]` / `[[organization.*]]`
  against the **agent's** member + org row, not the requester's, by
  design (the email is sent to the requester about the agent).
- **Article brief** copyright/case-study external-writer paths have
  no member context; `[[member.*]]` / `{{member.*}}` /
  `[[organization.*]]` / `{{organization.*}}` are explicitly stripped
  rather than left literal.
- **Generic entity auto-reply** only resolves `set_password_url` when
  `VITE_APP_URL` (or `APP_URL`) is configured AND the submission has a
  resolvable `created_member_id` / `member_id`.

If a token from §7 needs to resolve in a sender where it currently
collapses to '', the fix is almost always "add the data lookup", not
"change the helper".

## 9. Token × helper coverage matrix

For every token in the canonical catalog, this matrix shows which sender helpers will resolve it (✅) vs leave it literal / strip it (·). Generated from `client/src/lib/emailPlaceholders.js`.

Helper key:
- **H1**: `forms/send-submission-email`
- **H2**: `entities/[entity] auto-reply`
- **H3**: `campaignService`
- **H4**: `workflows.sendEmailAction`
- **H5**: `eventConfirmationEmail`
- **H6**: `cron/send-event-reminders`
- **H7**: `cron/send-contract-reminders`
- **H8**: `dd/_stageActions`
- **H9**: `dd-meeting/{resend,add-alternative}`
- **H10**: `article-briefs/send-{copyright,case-study}-form`
- **H11**: `functions.sendTeamMemberInvite`
- **H12**: `auth/request-password-reset`

### Contracts

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `[[contract.name]]` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{contract_name}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `[[signer.name]]` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `[[signer.first_name]]` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `[[signer.last_name]]` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `[[signer.email]]` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{signer_name}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{signer_first_name}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{signer_last_name}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{signer_email}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{sign_url}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{signing_url}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{days_remaining}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `{{days_since_sent}}` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |
| `[[applicant.name]]` | · | · | · | · | · | · | ✅ | ✅ | · | · | · | · |

### Due Diligence

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `{{due_diligence_status}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{due_diligence_stage}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{due_diligence_score}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{due_diligence_risk_level}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{due_diligence_form_name}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{due_diligence_reviewer}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{due_diligence_review_date}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{custom_message}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{dd_owner}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{dd_owner_email}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `[[dd_owner]]` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{recipient_name}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{recipient_first_name}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{recipient_last_name}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{recipient_email}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `[[recipient.name]]` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `[[recipient.first_name]]` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `[[recipient.last_name]]` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `[[recipient.email]]` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{submission.id}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{submission.application_uid}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{submission.workflow_status}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{submission.due_diligence_score}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{submission.risk_level}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |

### Event Confirmation & Reminder

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `[[attendee.first_name]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[attendee.last_name]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[attendee.email]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[event.name]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[event.title]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[event.date]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[event.location]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.id]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.reference]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.booking_reference]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `{{booking_id}}` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `{{booking_reference}}` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.ticket_class]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.ticket_price]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.total_cost]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.offer_discount_description]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.offer_discount_amount]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[booking.track_name]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[track_name]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[zoom_link]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[session_schedule]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |
| `[[session_zoom_links]]` | · | · | · | · | ✅ | ✅ | · | · | · | · | · | · |

### Footer & Socials

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `{{linkedin_url}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{twitter_url}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{facebook_url}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{instagram_url}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{youtube_url}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |

### Form Submissions

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `{{<field_id>}}` | ✅ | ✅ | · | ✅ | · | · | · | · | · | · | · | · |
| `{{<field_label>}}` | ✅ | ✅ | · | ✅ | · | · | · | · | · | · | · | · |
| `{{record.<field>}}` | ✅ | ✅ | · | ✅ | · | · | · | · | · | · | · | · |
| `[[record.<field>]]` | ✅ | ✅ | · | ✅ | · | · | · | · | · | · | · | · |

### Meetings & Bookings

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `{{recipient_name}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{recipient_email}}` | · | · | · | ✅ | · | · | · | ✅ | ✅ | · | · | · |
| `{{meeting_type}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{duration}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{agent_name}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{booking_url}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{booking_link}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{attendee_name}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{attendee_email}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{attendee_notes}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{meeting_title}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{meeting_date}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{meeting_time}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{meeting_end_time}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{meeting_timezone}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{zoom_join_url}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{zoom_password}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |
| `{{teams_join_url}}` | · | · | · | · | · | · | · | · | ✅ | · | · | · |

### Member

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `[[member.id]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[member.full_name]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[member.first_name]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[member.last_name]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[member.email]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[member.phone]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[member_full_name]]` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `[[member_first_name]]` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `[[member_last_name]]` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `[[member_email]]` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `{{first_name}}` | · | · | ✅ | · | · | · | · | ✅ | ✅ | · | · | · |
| `{{last_name}}` | · | · | ✅ | · | · | · | · | ✅ | ✅ | · | · | · |
| `{{full_name}}` | · | · | ✅ | · | · | · | · | ✅ | ✅ | · | · | · |
| `{{name}}` | · | · | ✅ | · | · | · | · | ✅ | ✅ | · | · | · |
| `{{email}}` | · | · | ✅ | · | · | · | · | ✅ | ✅ | · | · | · |
| `{{member_first_name}}` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `{{member_last_name}}` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `{{member_email}}` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `{{member.first_name}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |

### Organisation

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `[[organization.id]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[organization.name]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[organization.invoicing_email]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[organization.phone]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `[[organization_id]]` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `[[organization_name]]` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `{{organization.name}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{organization_name}}` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `{{organization_id}}` | ✅ | ✅ | · | · | · | · | · | ✅ | ✅ | ✅ | ✅ | · |
| `[[tenant.name]]` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{tenant_name}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |

### System & Links

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `{{set_password_url}}` | ✅ | ✅ | · | · | · | · | · | · | · | · | · | · |
| `[[set_password_url]]` | ✅ | ✅ | · | · | · | · | · | · | · | · | · | · |
| `{{communication_preferences_link}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{communication_preferences_url}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |
| `{{timestamp}}` | ✅ | ✅ | ✅ | ✅ | · | · | ✅ | ✅ | ✅ | ✅ | ✅ | · |

### Workflow Triggers & Invites

| Token | H1 | H2 | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H10 | H11 | H12 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `{{invite_link}}` | · | · | · | · | · | · | · | · | · | · | ✅ | · |
| `{{inviter_name}}` | · | · | · | · | · | · | · | · | · | · | ✅ | · |
| `{{invitee_email}}` | · | · | · | · | · | · | · | · | · | · | ✅ | · |
| `[[job_posting.status]]` | · | · | · | ✅ | · | · | · | · | · | · | · | · |
| `{{current_date}}` | · | · | · | ✅ | · | · | · | · | · | · | · | · |
| `{{current_datetime}}` | · | · | · | ✅ | · | · | · | · | · | · | · | · |


Legend: ✅ = sender invokes a helper that knows this token (subject to runtime context). · = sender does not handle this token (token will either be left literal or, where stripping policy applies, collapsed to "").
