# Cancellation credit-note recovery

## Rollout

Apply `supabase/migrations/202612060001_cancellation_credit_recovery.sql`
to approved DEST before deploying the code. The pinned runner is:

```
node scripts/apply-cancellation-credit-recovery.mjs
node scripts/apply-cancellation-credit-recovery.mjs --apply --review-sha256=<printed hash>
```

The runner verifies RLS and restricted grants. Deploy both API and frontend,
including the existing `reconcile-booking-credits` scheduled worker and its
updated function time budget. Preview-only deployment does not update the
production worker.

## Boundaries

- Cancellation approval is independent from credit-note completion.
- The new protected queue owns Xero cancellation credit intents; the existing
  reversal-evidence table remains reporting evidence, not permission to write.
- New single and group cancellations save the amount, invoice, provider
  company, booking scope and reference before any provider write.
- A database compare-and-set admits one worker. Interrupted processing goes
  to review; it is never blindly reclaimed for another financial write.
- Retryable pre-write failures respect the shared Xero company cooldown.
- Provider writes use a stable idempotency key. Discovery checks existing
  references, contact, currency, amount and allocation invoice before creation.
- Uncertain writes, mismatched matches and changed balances require review.
- A created but unallocated credit is explicitly reported as needing
  allocation review, not as fully reconciled.
- Automated recovery does not repeat cancellation, refunds, voucher returns,
  membership changes, or emails. If an email was requested and the credit was
  completed asynchronously, the status tells the administrator to check
  delivery separately.
- Existing historical failures are displayed but are not automatically
  converted into new credit intents. Their stored error may not include the
  amount originally approved. Verify that amount and existing provider
  evidence before authorizing a historical recovery.

## Verification

```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/_lib/cancellationCreditRecovery.postgres.test.mjs \
  api/_lib/cancellationCreditRecovery.test.mjs \
  api/_lib/xeroCreditNoteAmounts.test.mjs \
  client/src/pages/CancellationRequests.creditNoteRecovery.test.mjs
```

Local fixtures cover access controls, single-writer claims, cooldowns,
ambiguous writes, existing credits and persistent status rendering. They do
not establish that a production invoice has been credited.
