# Task 4365 — read-only diagnosis

## Scope and safety

This investigation was performed against the reported DEST submission and
member. It used only:

- DEST database metadata/`SELECT` reads;
- Stripe retrieve/list operations;
- Vercel project, deployment, domain, and alias `GET` operations; and
- local Git/source inspection.

No confirmation endpoint, webhook, reconciliation job, recovery routine, RPC,
replay, repair, refund, cancellation, or other mutation was invoked. Credentials
were resolved and used only inside programmatic clients and are not recorded
here. Personal data, addresses, email addresses, names, credential values, and
Checkout URLs are omitted.

## Resolved context

- DEST tenant: `ff2df806-b321-4254-b651-3af11fccf1db` (active).
- The submission and reported member belong to that same tenant.
- Payment provider: Stripe monthly card.
- Stripe mode: test, consistently shown by the tenant configuration, billing
  agreement, Checkout resource, and provider `livemode=false`.
- Stripe account: `acct_…LW36` (standard GB test account). This was resolved
  by retrieving the account through the tenant's selected test credential.
- Accounting provider: Xero is the tenant's active accounting provider.
- Xero destination classification: the persisted Xero connection is a normal
  Xero organisation, not Xero's Demo Company and not a tenant labelled test or
  sandbox. Xero has no separate sandbox API environment, so this must be
  treated as a live accounting destination for fixture-approval purposes. The
  organisation label and provider tenant identifier were present but are
  intentionally not reproduced.
- The Checkout return host was the tenant's development wildcard host. Vercel
  resolves that host to deployment `dpl_Ep…JeH4`, source commit
  `4e9483540dcb37077fc59a9e00e8beedb78f5a66`, created
  `2026-09-10T16:21:55.867Z`, ready before this checkout began.

The production custom-domain deployment is a different, older deployment at
commit `aaa9e9008ec751cab605ce9a12f98b34dd29c7a6`. It was not the return host for
this reported checkout and therefore is not treated as the executing version.

## Sanitized timeline (UTC)

| Time | Evidence |
|---|---|
| 17:17:42.969 | DEST form submission created with payment state `pending` initially (later state described below). |
| 17:17:43 | Stripe subscription-mode Checkout Session created in test mode. |
| 17:18:17 | Stripe subscription and first invoice created. |
| 17:18:18 | Stripe first invoice marked paid for GBP 5.08. |
| 17:18:20 | Stripe emitted invoice-created/finalized/paid/payment-succeeded events and a subscription-created event. |
| 17:18:21 | Stripe emitted `checkout.session.completed`. |
| 17:18:25 | Stripe emitted subscription/schedule update events. |
| 17:18:26.301 | Local provisional billing agreement last updated. |
| 17:18:26.801 | Submission changed to `setup_complete` and received its payment timestamp. |
| 17:18:31–38 | Organisation/member entity pipelines completed; the reported member and relationship links were persisted. |

## Correlated state

### Provider payment

Stripe is authoritative that checkout completed:

- Checkout mode is `subscription`, status is `complete`, payment status is
  `paid`, and metadata identifies the monthly-card flow and the correct tenant
  and submission.
- The resulting Stripe subscription is `active`.
- The first Stripe invoice is `paid`; amount due and amount paid are both 508
  minor units (GBP 5.08).
- Stripe contains the expected checkout, subscription, invoice, and schedule
  events.

This is not an abandoned or unpaid checkout.

### Immutable accepted plan terms

The billing agreement contains the checkout-time card snapshot used by the
monthly-card processor. These values are immutable evidence of the terms the
app accepted; they are not inferred from the tenant's current configuration:

- terms version: `v1`, accepted `2026-09-10T17:17:43.202Z`;
- membership year: `2026/2027`, starting `2026-09-10`;
- currency and instalment price: GBP 5.08 (508 minor units);
- accepted instalment count: 12;
- arithmetic plan total: GBP 60.96 (`12 × 5.08`);
- accepted displayed/final annual cost: GBP 61.00;
- VAT recorded: GBP 0.00;
- activation policy: `first_payment`;
- accounting invoicing mode: **`per_instalment`**;
- post-grace collection policy: stop collecting, with a seven-day grace
  period; and
- Stripe's finite provider schedule runs from
  `2026-09-10T17:18:17Z` to `2027-09-10T17:18:17Z`, is configured to cancel at
  its end, and has a first billing period ending
  `2026-10-10T17:18:17Z`.

The GBP 61.00 accepted annual/final display value and GBP 60.96 collection
total are both preserved in the snapshot. The provider economics for this
fixed plan are 12 charges of GBP 5.08, rather than a one-off GBP 61.00 charge.

### Entity pipelines

The submission is `new` with `payment_status=setup_complete`,
`payment_provider=stripe_monthly_card`, and `payment_paid_at` populated.
Entity processing completed successfully:

- one organisation pipeline link exists;
- one member pipeline link exists and targets the reported member;
- the member-creation provenance row exists;
- related-record processing reports success, no partial outcome, zero failures,
  and one successful member link; and
- the reported member is active.

One member workflow evaluation ran at member creation and was `skipped`; there
is no evidence of a membership-paid workflow because no membership-history row
was established.

### Membership accounting

The local monthly-membership state did **not** finish:

- the provisional billing agreement remains
  `payment_setup_required`;
- it has no attached member, Stripe customer, Stripe subscription, or local
  attention flag;
- no member membership-history row exists for the reported member;
- no membership payment-plan row exists;
- no membership fee-token row exists;
- no membership instalment-invoice row exists for this agreement; and
- the submission has no terminal `monthly_card_state` (`done`, `conflict`, or a
  durable retry marker).

Consequently, Xero invoice creation/application was never reached. There is no
local accounting invoice identifier to retrieve from Xero, so no narrow,
privacy-safe Xero resource lookup was possible. The absence is upstream of
Xero, not evidence of a Xero invoice failure.

The invoicing-mode distinction is material:

- This agreement is **per-instalment**, so the correct behavior is to suppress
  an annual Xero membership invoice and create one small accounting invoice
  for each confirmed Stripe invoice.
- The paid first Stripe invoice should therefore eventually correspond to a
  GBP 5.08 `membership_instalment_invoices` row and its Xero posting.
- Under the accepted `first_payment` activation rule, that first confirmed
  instalment should make the agreement/payment plan active, activate the
  linked membership history, and mark membership payment progress `partial`;
  it should not mark the full 12-instalment membership `paid`.
- Full membership payment and plan completion are obligations of the twelfth
  successfully accounted collection (subject to no unresolved arrears), not
  of checkout completion.

The form finalizer's terminal `monthly_card_state.status=done` is narrower than
annual settlement: it means the member was resolved and attached, membership
history was created from the immutable snapshot, required submission
side-effects completed, and the finalizer lease closed. For this
per-instalment agreement, `done` must **not** imply that an annual Xero invoice
was created or that all 12 instalments were paid. After `done`, plan creation
and paid-invoice processing still owe the first-instalment accounting and
activation obligations above. The reported record did not reach even the
finalizer `done` checkpoint.

### Webhook and recovery coverage

- DEST contains no `payment_webhook_events` for this tenant in the incident
  interval.
- A Stripe account-level GET returned zero configured webhook endpoints.
  Therefore Stripe generated the events, but this account had no endpoint to
  deliver them to; the webhook safety net could not run.
- The deployed recovery cron only scans completed checkouts after the billing
  agreement has been stale for six hours. At the reported time (about two hours
  after checkout), this record was not yet eligible.

## Deployed implementation correlation

The Vercel alias used by this checkout maps exactly to local commit
`4e9483540dcb37077fc59a9e00e8beedb78f5a66`, so the executing server/client
implementation can be compared directly with committed source.

That version has three relevant behaviors:

1. The return-leg client calls confirmation once, then immediately removes the
   payment return parameters from the URL.
2. A retryable monthly-card server result is displayed as pending, but the
   client does not poll or retry. Although it retains the stored submission
   identifier, a refresh without return parameters is treated as an ordinary
   page load, so it does not resume confirmation.
3. Server finalization changes the submission to `setup_complete` before entity
   pipelines and the atomic membership-year claim. A later retryable exit can
   therefore leave exactly the observed split state: provider payment and
   entity creation complete, but agreement/member/history/plan accounting
   absent.

The persisted timestamps and rows show that finalization reached entity
processing and then stopped before the atomic membership claim. The exact
internal retry reason was not persisted: the deployed failure path removes the
processing lease instead of storing a durable failure reason. Without runtime
logs, it is not possible to distinguish conclusively among a lost lease/CAS
race, a claim error, or another retryable failure after entity processing.

The current workspace contains uncommitted changes in these same return,
finalization, and monthly-card files. They add durable retry outcomes and
resumable/recheck behavior, but they were not deployed at incident time and
were not modified or treated as production evidence by this diagnosis.

## Conclusion

The first Stripe payment succeeded, and the form's organisation/member entity
pipelines completed. Local monthly-membership finalization stopped before
attaching the member to the agreement and before creating membership history
and the payment plan. No accounting invoice was created. The immediate webhook
safety net was unavailable because the Stripe account had no webhook endpoint,
while scheduled recovery was not yet eligible due to its six-hour stale
threshold. The deployed return client had no automatic retry after its one-shot
pending result.

This diagnosis deliberately leaves the records unchanged. It does not confirm
that a later cron run repaired the record; the evidence above is a point-in-time
read, and no later replay or state-changing verification was performed.

## Limitations

- Runtime/deployment logs were not inspected.
- Stripe does not expose event delivery attempts when no webhook endpoint
  exists; event existence proves generation, not application receipt.
- The failed finalization reason was not durably recorded by the deployed
  version.
- No Xero resource could be queried narrowly because no local invoice ID was
  produced; broad contact/invoice searches were intentionally avoided to
  prevent unnecessary personal-data access.
- The stored Xero access-token expiry precedes the incident. Establishing
  present authorization would require an OAuth refresh, which may rotate and
  persist tokens and was therefore prohibited by the read-only constraint.
  This does not change the destination classification: the persisted connected
  organisation is non-demo/live, but current token usability was not tested.
- No confirmation, recovery, or replay was run to test a hypothesis.