---
name: Form submission email sending
description: Exactly-once server-side submission emails via a jsonb claim column; three send paths share one module.
---

# Form submission emails

Submission emails (form `submission_emails` array + legacy single-email fields)
are sent by ONE shared server module used by three paths: the public
form-submission endpoint (trigger `server`), the retained legacy client call
`/api/forms/send-submission-email` (trigger `client`, kept as backstop for old
cached clients), and the generic entity-API FormSubmission insert
(trigger `entity-api`).

**Exactly-once:** the sender claims `form_submission.submission_email_state`
(jsonb) via atomic `UPDATE … WHERE submission_email_state IS NULL`; losers see
the existing state and skip. The final outcome
(`status: sent|skipped|failed`, per-email results, trigger, reason) is written
back to the same column and shown in the admin Form Submissions detail dialog.

**Why:** emails used to be sent only by a browser follow-up call after submit;
redirects/ad-blockers/embeds silently lost them, and the entity-API path
ignored the `submission_emails` array entirely.

**How to apply:** any NEW path that creates form_submission rows and wants
submission emails must go through `sendSubmissionEmailsGuarded` — never call
`sendEmail` for form configs directly, or double-sends/silent drops return.
If the claim column is missing (stale dev SOURCE DB), guarded server paths
skip; only the legacy client endpoint is allowed unguarded sends.
The workspace MAILGUN key gets 401 on tenant domains (e.g. bnms.iconn.app) and
falls back to mail.iconn.app — env-specific, not a code bug.
