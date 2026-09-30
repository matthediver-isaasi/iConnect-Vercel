# Task #4446 developer handoff

## What is implemented

- Annual Stripe confirmation now verifies the PaymentIntent, queues a
  completion receipt, conditionally records payment, and returns
  `paymentSucceeded: true` with `finalizing`; it does not run pipelines,
  accounting, emails, or address retrieval in the public request.
- Completion receipts use a processing lease and owner-token-fenced outcome
  RPC (`finish_form_payment_completion`). Queueing occurs before paid-marking
  in both browser confirmation and pending-payment reconciliation.
- Address recovery uses `latest_charge.billing_details.address` and a
  write-once database snapshot. A membership requiring an address but no
  configured profile mapping is now enrolled in the address retry queue.
- Minute cron cadence, a 20-row slice, and advisory stage headroom are in
  place. Receipt eligibility is normally one sweep; an abandoned lease becomes
  eligible after two minutes. Neither is a delivery/execution guarantee.
- `attention` is terminal for completion, API responses, browser return
  receipts, and all alternate membership/pipeline/DD/address sweeps. It is
  never automatically reclaimed or re-confirmed.
- Every managed reconciliation pipeline invocation has a newly fenced durable
  pipeline operation and receives the shared worker deadline. A prior
  in-flight operation remains attention-required. A prior known `done`
  operation is reused by ordinary primary retries and does not issue another
  processor fetch; only an explicitly typed `followup` with a persisted
  structured-action or related-record pending marker may claim further work.
- GoCardless Billing Request reads in the paid reconciliation path receive the
  remaining shared deadline as their abortable transport timeout. Email
  completion writes are fenced to the original `claim_id`, including a
  zero-row conditional update being reported as non-durable.
- Each individual 20261027/28/29 migration explicitly revokes browser roles and
  grants its SECURITY DEFINER RPCs only to `service_role`; address retries are
  owner-token fenced.

## Destination rollout

1. `20261027_form_payment_completion_owner_fencing.sql`
2. `20261027_form_stripe_membership_address_retry.sql`
3. `20261028_form_payment_completion_retry_and_pipeline_operation.sql`
4. `20261029_form_stripe_address_mapping_retry_completion.sql`

The base three migrations were applied atomically on the approved DEST database
using `scripts/apply-task4446-migrations.mjs --apply`. The guarded runner
performed its backfill preflight while locking the existing submission and
address-retry tables: zero historical paid Stripe completion rows matched the
intentional `20261028` queue backfill, and zero completion-retry rows were
created. The transaction committed without changing an existing submission.
Post-commit verification found all 12 server-only RPCs installed, with
`anon`/`authenticated` denied and `service_role` granted; both new tables and
the fenced address-retry signature are present.

`20261029_form_stripe_address_mapping_retry_completion.sql` was subsequently
applied **only** through
`scripts/apply-task4446-migrations.mjs --apply-20261029`. Its SHA-256 was
pinned, its top-level SQL contained zero data-mutation statements, and the
runner checked for active submission/address/pipeline processing while holding
a short write-blocking lock (refusing to commit if any were present). The
preflight and post-commit counts were stable:
3020 submissions, 2 address-retry rows, 16 mapping-ledger rows, 0 pipeline
rows, and 0 mapping-pending submissions. It retains configured address
mappings on the retry queue after snapshot capture, restores monthly-card
eligibility, and gates mapping-pending completion without mutating existing
submissions.

Do not run the runner against SOURCE or a generic `DATABASE_URL`. If a future
preflight reports any backfill candidates, stop and drain/review those
historical rows with explicit approval before applying; the runner refuses to
commit in that state.

## Operational safety semantics

1. **Bounded transport:** internal entity processing, Stripe, Mailgun,
   GoCardless reconciliation reads, and the accounting
   settlement/orchestrator use bounded deadline/transport coverage. The
   aggregate accounting deadline regression passed at 1200ms. Do not replace
   transport bounds with `Promise.race`.
2. **Ambiguous effects are deliberately not auto-recovered:** a lost paid
   processor response, an abandoned in-flight pipeline owner, and a stale
   submission-email claim become durable `attention`. Automatic completion,
   membership, pipeline, DD, address, and email sweeps exclude `attention`;
   an operator must investigate rather than replay an effect whose outcome is
   unknown. This is conservative by design, not a transient retry state.
3. **Known outcomes may recover safely:** a handler records `done` before its
   known 200 success or persisted retryable structured-action 409 response.
   A new ordinary primary receipt owner gets that durable `done` result with
   no pipeline fetch. Only a `followup` operation, and only when the
   submission still records structured-action or related-record pending work,
   can process that known partial work.
4. **Fair ordinary retries remain automatic:** Stripe completion receipts use
   a separate `next_attempt_at` retry table/RPC with bounded exponential
   backoff; the sweep claims this queue rather than an oldest-paid page.

## Evidence

- Architect verification passed: 180 server tests, 48 client tests, and SQL
  migration checks.
- Parent Playwright evidence passed: 12 fully intercepted local-fixture tests
  with Nix Chromium using `playwright.form-payment-return.config.mjs`.
- The aggregate accounting deadline regression passed at 1200ms.

## Possible follow-up work (not Task #4446 blockers)

- If an email provider later supplies a reliable idempotency or delivery-status
  lookup contract, an operator-assisted `attention` workflow could gain a
  separately designed resolution path. Do not turn current `attention` rows
  into automatic resends without that evidence.
- The pending-marker-gated `followup` protocol is intentionally limited to
  structured actions and related records. Any future type of post-payment
  partial work needs its own persisted completion evidence before it can join
  this path.