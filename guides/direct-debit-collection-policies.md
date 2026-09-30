# Direct Debit collection policies

## Status and scope

This feature separates the membership term from the authority to collect by
Direct Debit. The core policy, consent, renewal, read model, and administrator
and member-facing UI are implemented in source, including the dynamic scheduler.
The four schema migrations listed below were applied atomically to **DEST**
on 18 September 2026, with server-only RPC privileges verified. No existing
agreements were backfilled or converted, and no provider requests were made.

The read-only audit checked destination records and provider mirrors, not the
live GoCardless API. Source verification and schema application do not prove
that a deployed application bundle or scheduled job is running this code.

This policy is also separate from the post-grace arrears policy. The latter
controls what happens after a failed collection; it does not grant authority to
continue beyond a membership term or to vary the monthly price.

## Policy model

An enabled Direct Debit membership structure must choose both:

1. `dd_collection_end_policy`: `stop` or `continue`
2. `dd_pricing_policy`: `fixed` or `dynamic`

The saved policy has `dd_policy_version = 1`. The combinations are:

| End policy | Pricing policy | Behaviour |
| --- | --- | --- |
| `stop` | `fixed` | Stamp the monthly amount at consent, keep it fixed for the term, and stop after the term's finite collection schedule. A new renewal is required before further collections. |
| `stop` | `dynamic` | Recalculate each monthly collection from the one active structure in the purchased scope, but never schedule a collection beyond the saved term end. A new renewal is required afterwards. |
| `continue` | `fixed` | Keep the amount fixed during the term. At renewal, create a successor commitment and restamp its amount from the applicable structure. The old term and plan remain immutable. |
| `continue` | `dynamic` | Recalculate each monthly collection during the term and automatically create a successor commitment at renewal. Each collection and each successor term remain bounded by saved consent and term dates. |

Dynamic pricing requires `dd_invoicing_mode = per_instalment`. It is
mandate-only: a variable-price agreement cannot include a first payment in the
Billing Request. Currency cannot change dynamically.

All four combinations use a finite schedule for one membership term. A
`continue` policy means that the renewal engine may create a new agreement,
commitment, plan, and schedule for the next term. It does not turn the current
provider schedule into an unbounded subscription.

## Configuration and validation

The administrator settings are in
`client/src/pages/MembershipTierManagement.jsx`. The Payment step presents the
two policy selectors rather than four opaque choices and explains the combined
result. The same result is included in the structure summary.

The API persists and validates the three structure fields in
`api/membership/tiers.js`. Shared validation and compatibility rules live in
`shared/gocardlessCollectionPolicy.js`:

- a partially populated version 1 policy is rejected;
- dynamic pricing without per-instalment invoicing is rejected;
- a legacy structure with an actual boolean `dd_auto_renew` can be interpreted
  as fixed pricing plus `continue` or `stop`;
- absent, string-valued, or invalid legacy evidence is not inferred.

The migration adds the structure columns and a database check constraint in
`supabase/migrations/20261108_explicit_direct_debit_collection_policy.sql`.

## Consent and immutable evidence

`api/_lib/gocardlessDirectDebit.js` resolves the offer and copies the policy
into the consent snapshot:

```text
membership_billing_agreements.metadata.dd.collection_policy
membership_billing_agreements.metadata.dd.commitment.commitment_snapshot.collection_policy
```

The snapshot also retains the term key, term start, term end, renewal date,
collection count, currency, initial displayed monthly amount, pricing scope,
and invoicing mode. For dynamic pricing, annual/final totals are deliberately
not presented as agreed fixed totals.

`monthlyBillingRequestFingerprint` includes the policy, so a retry cannot reuse
a consent flow with different collection authority. The migration's
`guard_dd_collection_policy_snapshot` trigger prevents later changes to a
purchased agreement policy.

Only persisted consent evidence may answer whether collections continue or
whether prices can vary. Never derive bought terms from today's structure.

### Legacy agreements

`resolveSavedCollectionPolicy` applies these rules:

1. A valid saved version 1 `collection_policy` is explicit evidence.
2. If that is absent, a saved boolean `metadata.dd.auto_renew` is legacy
   evidence for `continue` or `stop`, always with fixed pricing.
3. Missing or invalid evidence is marked `needs_review`. Existing fixed prices
   are retained, dynamic pricing is never inferred, and renewal continuation
   fails closed.
4. An invalid explicit policy does not fall back to legacy `auto_renew`.

The member/admin UI labels legacy boolean evidence as saved legacy consent.
Incomplete evidence is shown as requiring administrator review rather than
being silently replaced by current configuration.

## Fixed collection path

For fixed pricing, `ensureSubscriptionForAgreement` in
`api/_lib/gocardlessDirectDebit.js` creates or reuses the local plan and creates
a finite GoCardless subscription from the immutable agreement snapshot. The
provider amount does not change when the structure is edited during that term.

Provider payment events are mirrored in `gocardless_payments`. An amount stored
on an agreement or plan is an agreed amount, not evidence that a provider
payment is scheduled or collected.

## Dynamic reservation and submission path

Dynamic orchestration is in
`api/_lib/gocardlessDynamicCollections.js`.

For each intended collection:

1. Resolve exactly one active membership structure for the saved purchased
   scope and intended date.
2. Preserve the purchased pricing basis for band selection rather than using a
   mutable member profile as new authority.
3. Resolve the current monthly amount, VAT rule, nominal code, structure, and
   band into a price snapshot.
4. Wait for the provider submission window.
5. Call the tenant-scoped
   `reserve_gocardless_dynamic_collection` RPC. It locks the owner, plan, and
   agreement and rechecks pause, cancellation, arrears, mandate, term, sequence,
   currency, and explicit dynamic consent.
6. Submit a one-off GoCardless payment with a deterministic idempotency key.
7. Verify provider amount, currency, mandate, absence of a subscription link,
   and charge date.
8. Call `attach_gocardless_dynamic_payment` to attach immutable provider
   evidence and mirror the payment.

Reservations live in `gocardless_collection_reservations`. Their price,
sequence, term, due date, and idempotency identity cannot be edited or deleted.
A provider identity cannot be replaced after attachment. A reservation is only
a local calculation until provider evidence is attached.

Dynamic scheduling stops when the saved collection count is exhausted or the
next date would exceed the saved term end. Renewal is a separate operation.
Ambiguous scope, changed pricing basis, missed notice deadline, paused or
cancelled ownership, arrears, or provider disagreement blocks collection and
records an actionable error rather than guessing.

`due_date` retains the intended monthly cadence; `requested_charge_date` is
reserved from the mandate's freshly fetched, provider-authoritative
`next_possible_charge_date`. They can differ around non-working days. We never
submit a guessed bank date and discover only afterwards that the provider
rolled it beyond the term. The requested date must remain inside the term and
no more than seven days after the intended date. A reservation retry reuses its
original amount and date even after a partial provider failure.

Reference: [GoCardless Payment API](https://docs.gocardless.com/docs/api-reference/payment).

## Reconciliation and scheduler

`api/cron/reconcile-gocardless.js` invokes
`reconcileDynamicCollections` before the existing agreement, plan,
subscription, payment, and invoice reconciliation stages so a legacy backlog
does not exhaust the invocation before dynamic schedules are checked.

The dynamic reconciler:

- selects bounded batches of live dynamic plans whose next collection is
  within its horizon;
- uses tenant-specific GoCardless credentials;
- retries idempotently from the durable reservation;
- stores `dynamic_next_check_at` and a visible
  `dynamic_collection_error`;
- counts failures as flagged rather than silently treating them as success.

The source wiring does not establish that the destination schema is present or
that the deployed schedule has executed. Verify deployment and scheduler
operation separately during rollout. Do not manually invoke reconciliation as
a harmless test: it can create provider payments for eligible live plans.

Webhook recovery in `resolveDynamicPayment` accepts provider metadata only as a
lookup hint. It still requires and verifies the matching immutable reservation.

## Renewal path

`api/_lib/gocardlessDdRenewals.js` reads continuation authority from the
previous agreement's saved policy. It does not use a later structure setting as
renewal consent.

- `stop` sends/retains the confirmation-required renewal path and does not
  automatically create further collections.
- `continue` permits automatic successor-term setup after notice and at the
  saved renewal boundary.
- missing or invalid consent produces no renewal action and requires review.

The successor simulation may use the active structure and current price, but it
is constrained by the previous saved continuation and pricing policy. The new
agreement receives its own immutable policy and commitment snapshot.
`membership_dd_renewals` remains the idempotent renewal notice and transition
ledger.

For fixed pricing, the successor amount is restamped at renewal. For dynamic
pricing, the successor retains dynamic authority but each actual collection is
still separately priced and reserved.

## Accounting path

`api/_lib/gocardlessAccounting.js` creates or settles per-instalment accounting
documents only from mirrored provider payment evidence.

For a dynamic payment, accounting additionally requires a matching immutable
reservation with the same tenant, agreement, provider payment, amount, and
currency. Its saved price/tax snapshot is supplied to the instalment invoice
path. Missing or conflicting reservation evidence is an explicit failure; it
must not produce an invoice from today's mutable structure.

Accounting status does not prove collection. `confirmed` and `paid_out`
provider payment statuses are the collected states used by the commitment read
model.

### Dynamic term completion

Dynamic plans have no subscription `finished` event. After successful payment
handling and accounting, `api/_lib/gocardlessDynamicCompletion.js` calls
`complete_gocardless_dynamic_term`. Reconciliation independently recovers this
step after interrupted webhooks.

The RPC derives the authorised collection slots within the saved term. It
requires a reservation and matching confirmed/paid-out provider evidence for
every slot, and rejects unresolved arrears. In one transaction it expires the
plan, stamps completion, marks the correct tenant-owned history paid, and
records completion/audit/notification evidence. Submitted payments do not
qualify. Purchased price snapshots and unknown dynamic totals are not changed.

Completion notices have a retained recipient/message manifest and independent
per-recipient delivery claims. Retries skip accepted recipients. Explicitly
rejected deliveries can retry; uncertain transport acceptance requires review
instead of risking duplicate mail. The service-only
`resolve_gocardless_dynamic_completion_delivery` RPC requires evidence of
acceptance or rejection before resolving that state. Mailgun transport and a
database transaction cannot jointly promise exactly-once delivery.

Dynamic confirmation and failure receipts receive the verified provider amount
and currency, never the opening consent-time quote.

## Commitment and payment-plan display

The commitment API in `api/membership/member-membership.js` shapes persisted
history and agreement evidence. It enriches only tenant- and owner-matched
Direct Debit commitments with:

- the saved collection policy;
- current provider payment evidence;
- dynamic reservation/price preview where applicable;
- pause, arrears, lifecycle, policy, and read-error blockers.

It never substitutes current structure values for bought terms. Dynamic
commitments omit an agreed fixed total and fixed monthly amount.

`api/_lib/gocardlessCollectionDetails.js` deliberately distinguishes:

- **agreed**: saved fixed amount, not a confirmed provider charge;
- **reserved**: local dynamic price, not provider-confirmed;
- **provider scheduled**: accepted by the provider, not yet collected;
- **last collected**: historical collection, not the next amount;
- **blocked/unknown**: no safe positive claim can be made.

`client/src/components/membership/DirectDebitCommitmentDetails.jsx` renders
these distinctions in the Current or Scheduled Membership Commitment section.
It shows the term policy, pricing policy, current evidenced amount, provider
date/status where available, dynamic preview, last collection, and blockers.
`DirectDebitPlanCard.jsx` reuses the same presentation.

### Pending is not paid

An agreement in `payment_setup_required` or `mandate_pending`, a membership
history row in `pending_payment_setup`, a submitted mandate, or a locally
reserved amount is **not** a paid membership and is not proof of a collection.
The UI and APIs must not label these states as paid.

## Read-only supplied-record audit

A read-only, tenant-scoped destination audit was performed before
implementation. No member identifiers or personal details are reproduced here.

The record contained one saved legacy Direct Debit agreement with:

- a 12-month term from 18 September 2026 to 17 September 2027;
- a renewal date of 18 September 2027;
- saved legacy continuation evidence (`auto_renew: true`);
- a fixed amount of £10.66 for 12 instalments (£127.92 total);
- agreement status `mandate_pending`;
- a local mandate mirror at `submitted`;
- membership status `pending_payment_setup` and payment status `unpaid`;
- no payment plan, no scheduled plan collections, and no mirrored collected
  payments.

The audit therefore established that the saved term duration did not, by
itself, answer collection continuation. Saved legacy consent indicated
fixed-per-term continuation, but setup was still pending and nothing was paid.
The audit inspected local destination evidence only; it did not check the live
GoCardless API.

## Database rollout

The DEST-pinned runner is:

```sh
node scripts/apply-explicit-direct-debit-collection-policy.mjs
```

With no flags it is an offline dry run. It prints the destination label,
review hash, migration name, and `writesPerformed: false`. The reviewed bundle
contains:

1. `20260924_gocardless_org_renewal_owners.sql`
2. `20261108_direct_debit_dated_commitments.sql`
3. `20261108_explicit_direct_debit_collection_policy.sql`
4. `20261109_gocardless_dynamic_term_completion.sql`

Application requires both an explicit apply flag and the exact reviewed hash:

```sh
node scripts/apply-explicit-direct-debit-collection-policy.mjs \
  --apply --review-sha256=<reviewed-dry-run-hash>
```

The runner applies the bundle in one transaction, uses verified destination
TLS, and verifies that the dynamic reservation RPCs are service-role-only.
Do not run the apply form merely to test the script. The bundle was applied
successfully to **DEST** on 18 September 2026. Its final reviewed SHA-256 was
`866233170013cff468f85a987f47971017bdd07d70956b53588756e8805d705f`.
No migration in this bundle remains pending on DEST. The legacy SOURCE
database was not modified.

## Safe regression commands

Use the isolated network boundary so tests cannot reach configured databases or
providers:

```sh
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/gocardlessCollectionPolicy.test.mjs \
  api/_lib/gocardlessCollectionDetails.test.mjs \
  api/_lib/gocardlessDynamicCollections.test.mjs \
  api/_lib/gocardlessDynamicCompletion.test.mjs \
  api/_lib/gocardlessDirectDebit.test.mjs \
  api/_lib/gocardlessDdRenewals.test.mjs
```

The policy suite covers all four combinations, immutable snapshots, legacy
evidence, term boundaries, and renewal authority. The collection-details suite
covers agreed, reserved, provider-scheduled, collected, blocked, and failed-read
presentation. Direct Debit and renewal suites use mocked provider/database
dependencies.

The migration runner's no-flag form is also safe and performs no database
writes:

```sh
node scripts/apply-explicit-direct-debit-collection-policy.mjs
```

These commands do not prove that the destination schema is deployed, that a
cron schedule is active, or that GoCardless will accept a real collection.
Never use a live reconciliation invocation as a regression test.

Additional verification during implementation included disposable PostgreSQL
tests for commitment and form binding, concurrent reservation claims,
immutability, pause/tenant guards, amount mismatches and RPC privileges;
isolated browser checks for save/reload/duplicate/schedule and all four
commitment labels; and a successful production build.