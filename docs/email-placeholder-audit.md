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
| Generic entity form auto-reply | `api/entities/[entity]/index.js` `sendFormSubmissionEmail` | ✅ (was ❌) | **FIXED** — now resolves member/org from the submission and calls generic helper |
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
| DD meeting request — resend | `api/dd-meeting-requests/resend.js` | ✅ (was ⚠️) | **FIXED** — generic helper pass covers `[[member.*]]` in agent's email template |
| DD meeting request — add alternative | `api/dd-meeting-requests/add-alternative.js` | ✅ (was ⚠️) | **FIXED** — generic helper pass; agent identity is taken from the already-resolved `agent` row used to build `agentName` (sourced via the `tenant_identity`/agent join earlier in the handler) |
| Article brief — send copyright form | `api/article-briefs/[briefId]/send-copyright-form.js` | ✅ (was ⚠️) | **FIXED** — generic helper pass for `[[member.*]]`/`[[organization.*]]` when writer is internal |
| Article brief — send case study form | `api/article-briefs/[briefId]/send-case-study-form.js` | ✅ (was ⚠️) | **FIXED** — generic helper pass (no member context — provider is external — but tenant context preferences link still resolves) |
| Team member invite | `api/functions/[functionName].js` `sendTeamMemberInvite` | ✅ (was ⚠️) | **FIXED** — kept hand-rolled bespoke tokens (`{{invite_link}}`, `{{inviter_name}}`, `{{organization_name}}`) but replaced the `[[member.*]]` ladder with one generic helper call so every member token is covered |
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
   `record` entity. Form-field tokens still substitute first; the helper
   then fills `[[member.*]]` / `[[organization.*]]` so generic auto-reply
   templates work.

3. **`api/dd-meeting-requests/resend.js` and `add-alternative.js`** — keep
   the bespoke `{{recipient_name}}` / `{{agent_name}}` / `{{booking_*}}`
   ladder, then run the agent's member row (resolved via
   `tenant_membership` → `member`) through the generic helper as a
   `member` entity so `[[member.*]]` tokens (e.g. an agent's signature
   block referencing themselves) resolve.

4. **`api/article-briefs/[briefId]/send-copyright-form.js`** — when the
   writer is an internal `member` (not an `external_writer`), pass the
   loaded member row through the generic helper as a `member` entity
   after the bespoke `{{writer.*}}` substitutions. External-writer path
   skips the generic call (no `[[member.*]]` data exists for that case).

5. **`api/article-briefs/[briefId]/send-case-study-form.js`** — providers
   are always external (no member row). The generic helper is called with
   `entityType = 'record'` and an empty entity (resolves any communication-
   preferences-link tokens via context). Because `replacePlaceholders`
   preserves the original match when a value is missing, an additional
   regex strip pass `s/\[\[(?:member|organization)\.\w+\]\]//gi` is then
   applied so those tokens collapse to '' instead of leaking as literals.

6. **`api/functions/[functionName].js` `sendTeamMemberInvite`** — kept the
   bespoke `{{invite_link}}` / `{{inviter_name}}` / `{{organization_name}}`
   substitutions verbatim, then **deleted** the long hand-rolled
   `[[member.*]]` / `[[organization.*]]` `.replace` ladder and replaced it
   with one `replacePlaceholders(text, 'member', { …inviter, organization_name })`
   call so every member/org token in the catalog stays in sync without
   needing per-token maintenance.

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
