# Manual CPD awards

On an administrator's member detail CPD tab, **Award manual CPD** is available
with the existing CPD correction permission. The action is not exposed on
member self-service pages.

Choose an active certificate template, positive decimal points, an event/activity
title and a date. Templates must contain points and a title placeholder;
unsupported required placeholders are reported instead of filled with samples.
Previewing produces a PDF without saving points or sending email.

Saving appends a distinct manual award to the shared CPD ledger and archives its
generated certificate privately. No booking, event attendance or event-wide
rules are created or changed. Members see the award in their ordinary CPD balance
and history and can preview/download its certificate under existing permissions.
The archived PDF does not change when a template is subsequently edited.

Optional email uses the member's current address and a sanitised TipTap message.
Email happens after the award is saved. Exact retries reuse the saved award and
delivery request. Confirmed failures may retry; pending/unknown provider outcomes
must not automatically resend. These states require investigation if they persist.
Existing event/import correction controls are unchanged; this feature does not
add correction/reversal controls for standalone manual awards.

## Rollout and verification

Applied `20261208_manual_cpd_awards.sql` to live DEST (`lvmzliemqnieeoruhkik`)
with owner approval after tests. SHA-256:
`214495283d60e46fedde36fbaf7107cbf92a6654dcccb4e0ebf2b379e96bcf28`.
Verified unchanged contents of 5,991 existing ledger entries, unchanged ledger
grants/RLS, retained immutability, tenant/member validation, and protected RPC
and email-delivery permissions. SOURCE was unchanged. No real awards or emails
were created by testing. Deploy the API/frontend changes to expose the feature.

Forty isolated tests passed, covering SQL constraints/idempotency/access,
input validation/sanitization, API preview/save/email separation, existing
certificate access and mounted UI/retry behavior. The workflow started cleanly.
Workspace screenshot showed the existing tenant-not-found limitation, not the
authenticated page; the signed-in UI and real email delivery were not visually
or end-to-end verified.
