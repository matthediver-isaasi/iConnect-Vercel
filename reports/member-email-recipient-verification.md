# CRM Member Email — Mailgun correction and verification

Date: 2026-09-23

## Corrected transport

Member Detail Communications now composes through `POST /api/crm/send`, using the existing tenant-aware Mailgun email service. The former implementation used `/api/outlook/send` and Microsoft Graph: that was a real transport choice, not merely an endpoint naming issue. The previous Outlook recipient safeguards remain, but Outlook is no longer the CRM compose transport.

The shared `MemberEmails` component also serves AdminMemberEdit and MemberDetailView. Separate Outlook synchronization, historical correspondence, OAuth, and the unrelated Outlook send endpoint remain intact.

## Boundaries

- Authenticated tenant/admin authorization precedes any send. Header, submitted tenant, resolved tenant and session tenant must agree.
- The server looks up the selected member within that tenant and uses its current validated email as the only To. The browser's disabled To snapshot must match. Missing/anonymized members, invalid or stale addresses, malformed CC, header injection, unknown fields (including BCC), and lookup failures block sending.
- Optional CC consists only of sender-entered validated plain mailboxes. There is no campaign expansion, BCC, hidden copy or Outlook token lookup.
- Direct entry and refresh resolve identity from authenticated tenant-user context, with authenticated member-context fallback only after a successful unauthenticated tenant-user response. The active-tab store is a consistency guard, not the sole identity source. Failed/mismatched/refetching context blocks composition.
- Drafts and CC clear on member/tenant/address changes. Late responses after switching or unmount are ignored. Pending and uncertain sends cannot be retried in the same draft.
- Mailgun retains the existing tenant sender/domain/footer and explicit-domain-rejection fallback policies. It does not send from the administrator's Outlook mailbox. The UI describes this policy and labels successful submission as acceptance, not confirmed delivery.
- Provider rejection, unknown acceptance (including thrown transport errors), and accepted-but-history-write-failed are separate outcomes. Accepted messages with a logging warning are not presented as failed sends.
- History records the actual provider ID, From, To/CC and final rendered subject/body. The Microsoft message ID is null for Mailgun records; Outlook synchronization attribution is not fabricated. Sending domain is returned in response metadata, not persisted in a nonexistent history column.
- Existing history tenant/admin checks and agent-only/intra-organisation filters remain. Mailgun rows carry `email_provider: mailgun`; existing Outlook rows are preserved.

## Isolated verification

```sh
node scripts/run-isolated-tests.mjs node --test api/crm/send.mailgun-boundary.test.mjs api/crm/send.test.mjs api/_lib/emailServiceMailgunBoundary.test.mjs api/_lib/emailServiceDeliveryFailure.test.mjs api/outlook/emails/memberId.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test client/src/components/MemberEmails.test.jsx client/src/components/ComposeEmailModal.test.jsx
node scripts/run-isolated-tests.mjs node --test shared/memberEmailRecipients.test.mjs api/outlook/send.test.mjs api/outlook/emails/memberId.test.mjs api/_lib/outlookOAuthRedirect.test.mjs api/auth/outlook/callback.test.mjs
git diff --check
```

Results: 15 CRM/service/history tests, 15 rendered frontend tests, and 27 recipient/Outlook/OAuth regressions passed. Some history coverage overlaps across commands.

The integrated transport tests exercise the CRM handler through the real email service to a mocked final `client.messages.create` boundary, not just a mocked success response. They assert exact envelopes, tenant From/domain, processed footer, final rendered content, no CC, multiple explicit CC, explicit-rejection fallback, and no fallback/history write after ambiguous transport failure. Outlook/Graph calls and unexpected network access are prohibited.

Frontend tests exercise the parent-to-composer flow, including the fetch-interceptor's initially-null-to-authenticated-tenant bootstrap, unavailable Outlook history, authenticated member fallback, failure/mismatch blocking, failed context refetch, provider labels, context changes, late responses and unknown acceptance.

A production Vite build also passed (existing chunk-size warnings). The application workflow starts on port 5000. The preview root still displays `Public API Error (404): Tenant not found`, as in the earlier verification; this is not authenticated live Member Detail verification. No environment/database target was changed to bypass that limitation.

Completion review found that returning rendered content to every email-service caller could expose sensitive email bodies through existing workflow logs. Rendered content is now opt-in for CRM only; workflow delivery-result logging uses an explicit metadata allowlist. The additional isolated CRM/service/workflow suite passed 21 tests, including sentinel-content leakage regressions. Completion validation also reported two unrelated failures in its wider 627-test suite; focused suites passed.

## Migration status

Schema inspection found `member_email.microsoft_message_id` was NOT NULL and provider-neutral fields were absent. A narrow migration was therefore needed:

`supabase/migrations/20261122_member_email_provider_metadata.sql`

It makes Microsoft ID nullable, adds `email_provider` and `provider_message_id`, and creates a tenant/provider/message uniqueness index. Existing Outlook row data is not rewritten.

**Applied transactionally to the approved DEST database** through the destination-only guarded runner `scripts/apply-crm-member-email-provider.mjs`. Read-only preflight and postflight confirmed the expected schema, valid index, and unchanged row count (3,812). SOURCE and the workspace development database were not modified. **No migration remains pending on DEST for this correction.** Other deployments must apply the checked-in migration before using the new history fields.

## Limits

No real emails were sent. No production deployment, live delivery, mailbox rules, forwarding, or historical delivery investigation was verified. Acceptance is not a receipt. A lost response or history-write failure requires provider-side status review; absent CRM history does not prove that nothing was sent. Member address validation occurs at request time and does not lock edits across the external provider operation.