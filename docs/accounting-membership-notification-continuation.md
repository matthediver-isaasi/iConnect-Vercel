# Queued membership invoice notifications

## Scope and ownership

Only manual individual renewals and manual organisation renewals / advance invoices
provide the explicit notification authority required for new queue adoption.
Both Xero and QuickBooks use the same continuation. Legacy synchronous paths
remain in place when new adoption is disabled or the source is unsupported.
Once accepted, even immediate queue completion returns before legacy email,
add-on and note handling; the queue is the sole continuation owner.

Paid invoices, Stripe settlements, form submissions, add-ons, instalment plans,
and GoCardless migration/collection work retain their existing owners.
There is no new activation, benefit allocation, collection or financial write in
this continuation. Existing linked invoices may become paid while their
notification is retrying; that does not create another financial operation.
Cron/workflow/public fee-token paths without explicit notification authority
are not newly opted in.

## Delivery and crash handling

Recipient selection, email amounts/year/tier, note text and actor are saved before
provider preparation, using the original tier recipient policy. Addresses are
deduplicated. Missing recipients block acceptance rather than silently completing.
Email branding/templates are rendered using the existing helpers at send time.
QuickBooks invoices without numbers retain the existing numberless subject and
PDF-token fallback.

The queue link stage first verifies invoice linkage, then completes delivery.
Each recipient has a service-only delivery receipt. Claiming occurs immediately
before transport, after rendering/inbox preparation. Confirmed acceptance must
include the provider message ID. A definite rejection returns the recipient to
pending; successful recipients are never resent when another recipient fails.
The final CRM note and its receipt are committed in one transaction, so replay
after a lost response cannot duplicate the note.

Each continuation loads recipient receipts before using the provider-call budget.
Already accepted recipients consume no send budget on later runs, so large
recipient lists advance across bounded worker invocations rather than repeatedly
processing the same prefix. Provider HTTP 5xx, timeout responses, and missing
authoritative responses are uncertain outcomes, not retryable rejections.

An uncertain response, a missing provider receipt, or a crash after a send claim
requires review. **No timeout automatically authorizes a resend.** This chooses
duplicate prevention over automatic recovery of ambiguous sends. “Delivered” in
the ledger means provider acceptance, not proof of inbox arrival or reading.
Queue errors distinguish pending delivery from delivery requiring review.
Inspect the receipt and provider logs under service authorization; do not reset
claims without evidence that the send was rejected. No new review/resend UI or
provider-delivery webhook is introduced here.

Old snapshots without notification authority are not reconstructed from current
settings. If still processing, they fail closed into review at continuation.
Previously completed requests are not automatically reopened or backfilled.

## Migration and rollout

Apply `supabase/migrations/202612050003_accounting_membership_notifications.sql`
after the two accounting queue migrations, using the approved DEST-only migration
process. This implementation applies it only in disposable test PostgreSQL:
**neither SOURCE nor DEST was migrated; no production flags were changed.**
Do not enable membership production sources until migration and separately
approved rollout checks are complete.

## Verification

`node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/accountingMembershipContinuation.test.mjs api/_lib/accountingMembershipContinuation.postgres.test.mjs`

Tests cover both providers and both owner types, partial deliveries, rejected
sends, uncertain sends, missing receipts, crash/checkpoint failures, note rollback
and replay, concurrent claims, stale tokens and service-only SQL access.
Provider calls are mocked; tests do not send real invoices or emails.
