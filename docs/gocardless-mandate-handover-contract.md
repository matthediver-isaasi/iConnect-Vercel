# GoCardless mandate handover: implementation contract

Status: implementation connected; release is controlled by the service-owned
environment release table. Both additive migrations have been applied to the
destination database. Existing live membership, payment and mandate records
were not changed. A missing/disabled release row blocks authorization.
Sandbox and live release rows were recorded against the verified provider
evidence on 2026-11-03, with a five-minute activation delay. This is a release
configuration change, not a live mandate operation. Source changes still need
to reach the main application before its users can access the new endpoint.

The handover engine now has isolated tests for ordered stop/create/verify/commit/
retire, ambiguous creation and retirement responses, and provider-created payments
during cancellation. Additive SQL defines mutation intents, a reference fence and
an identity-only commit. Production client factories fence provider mutations;
webhooks route replacement identities separately, and reconciliation resumes
incomplete phases. A five-minute settling window under the prepared fence
allows requests from an earlier deployment to drain before destructive work.

Fixed subscriptions qualify only when their full remaining schedule fits the
provider preview and agrees with the paid-instalment ledger. Larger or ambiguous
remainders require assistance rather than extrapolation. Dynamic schedules
retain their existing date and pricing authority; annual replacement creates no
payment. Imported or externally scheduled mandates fail closed.

## Agreed product behavior

The owner clarified that when an existing mandate cannot be changed, the flow
must cancel it and create a replacement. This is replacement of payment
authority, not cancellation of membership. The safety requirements still
require authorization of the replacement before destructive retirement of the
old mandate, so abandonment leaves working collections intact.

The owner subsequently approved building against the existing live connection
without any live cancellations during development. Sandbox authorization is no
longer a prerequisite for further implementation work. This does not authorize
live payment or mandate mutations as tests, or establish provider handover proof.

## Release and recovery

The release table is not browser-readable or service-writable. Its row must
reference retained provider evidence. The endpoint checks the same release
contract as the preparation RPC. Unknown provider outcomes retain their phase
and stable idempotency key; status refresh and the reconciliation cron resume
them. A definitive provider rejection or failed ownership/schedule check becomes
action-required. Review after a destructive phase retains the collection fence;
operators must reconcile provider state rather than clear it to restart.

Use `scripts/apply-gocardless-mandate-replacement.mjs` for destination-pinned
installation. It validates effective privileges, not merely GRANT text.
The provider-only script `scripts/prove-gocardless-replacement-sandbox.mjs`
cannot target live and uses the provider's public synthetic bank details.
It does not modify application members, agreements or plans.
`scripts/release-gocardless-mandate-replacement.mjs <sandbox|live>` validates the
retained proof and writes only the restricted release record.

The workspace's legacy SOURCE database cannot resolve real member sessions.
Browser coverage uses intercepted fixture responses without changing application
authentication. A real signed-in live-member UI was not exercised as a test.

## Local checks

- `node --test api/_lib/gocardlessMandateReplacementPolicy.test.mjs api/_lib/gocardless.test.mjs`
- `node --import tsx --test client/src/components/membership/HistoryMandateReplacement.test.jsx`
- `node scripts/test-gocardless-mandate-replacement-sql.mjs`

## Provider evidence

Reviewed 2026-11-03:

- [Subscription API](https://docs.gocardless.com/docs/api-reference/subscription):
  subscription creation binds `links.mandate`; the update request only permits
  name, metadata, payment reference, amount, app fee and retry policy. It does
  not document reassignment to another mandate.
- Pausing a subscription stops creation of future payments, **not** collection
  of payments already created. `upcoming_payments` contains at most ten entries,
  so it is not a complete remaining-obligation ledger.
- New subscriptions must start on or after the successor mandate's
  `next_possible_charge_date`. Pausing and resuming can affect dates; it is not
  proof of an unchanged schedule.
- [Changing customer bank details](https://support.gocardless.com/hc/en-us/articles/19228313259420-Changing-customer-bank-details):
  cancellation of a mandate cancels associated subscriptions. GoCardless also
  describes an account-gated GBP dashboard bank-update feature that moves
  mandates between bank accounts. That is not evidence of a generally
  available Drop-in replacement API; do not substitute it without verification.

## Required cutover boundaries

| Arrangement | Required evidence before switching |
| --- | --- |
| Annual individual payment | Establish current individual membership, future renewal authority and every unsettled payment. Do not create a new annual payment as part of mandate authorization. |
| Provider monthly subscription | Verify scheduler ownership, complete remaining amounts/dates/count and all created payments. A successor subscription requires a separately proven, resumable stop/create cutover; changing a local mandate ID cannot transfer it. |
| App-scheduled monthly payments | Fence collection intent creation, retries, amendments and renewals against the operation, then atomically change future authority. Preserve existing payment-to-instalment allocations and immutable consent. |
| Shared or external scheduler | Assistance required. Absence of a GoCardless subscription does not prove absence of Xero or other external collection authority. Do not retire the mandate. |

Authorization must be mandate-only and recorded separately from the existing
billing agreement. Abandoning it must not pause or cancel working collections.
Provider identities must be verified server-side in their original tenant,
environment and provider-account context. Browser success is only authorization
progress, not completion of the switch.

A single service-owned operation must serialize every path that can create a
collection or reuse the original mandate. Persist intent before provider
mutation, retain stable idempotency keys across crashes, and verify ambiguous
outcomes by reading provider state. Do not release a fence on lease expiry when
an earlier provider mutation may still have succeeded.

Retirement needs its own persisted intent and confirmed provider outcome.
Old-mandate cancellation webhooks must route to that historical operation, not
cancel the successor membership. Historical payment events must retain their
original allocations. Unknown events or outcomes must not be labeled success.

GoCardless paid-instalment authority comes from the complete provider payment
inventory, not the shared plan's Stripe-maintained `instalments_paid` counter.
Reconcile subscription count with the original purchased count, subtract a
verified legacy Billing Request initial payment exactly once, and verify every
generated subscription payment is paid out before computing the remainder.
Background recovery prioritizes switching operations and rotates each attempted
row even when a pending authorization or provider error makes no progress.
The immutable prepared timestamp, not the last-attempt timestamp, controls
the five-minute settling window.

## Sandbox evidence boundary

An enabled, explicitly sandbox tenant connection was discovered with a
destination-pinned read-only query. A sandbox mandate-list GET authenticated
successfully. No live provider mutations or database writes were performed.

This establishes access only. It does **not** establish authorization,
subscription handover, old-mandate retirement, absence of duplicate collections,
or successful application integration.

Two separate mandate-only Billing Requests and hosted flows were subsequently
created in that sandbox for disposable original/replacement test identities.
They do not reference application members or billing agreements. Authorization
is still pending; no payments or subscriptions have been created. Local
continuation evidence is in ignored
`generated-artifacts/gocardless-handover/authorization.json`; do not commit
authorization URLs or treat flow creation as proof of a switch.

Before implementation rollout, retain evidence from disposable sandbox mandates
authorized through hosted/Drop-in flows, subscriptions and payments. Exercise:
authorization abandonment; duplicate starts and callbacks; pause/create crashes;
pending payments; insufficient charge lead time; shared/external schedules;
out-of-order old/new cancellation and payment events; and reconciliation.
Record exact expected and observed remaining obligations. Never present mocked
tests or the existing billing-request-only proof as this handover evidence.

### Completed provider proof

On 2026-11-03 the restricted sandbox customer, bank-account and mandate APIs
accepted disposable fixtures; `mandate_activated` activated their test mandates.
The test then created a two-instalment GBP subscription at 100 minor units per
instalment, stopped it, recreated it on the successor, and compared the complete
provider-returned schedule. Both amounts and dates matched. Provider payment
lists for both mandates were empty. Old mandate cancellation was read back as
`cancelled`, while the successor mandate and subscription remained `active`.
No live resource was mutated. Evidence is retained in the ignored
`generated-artifacts/gocardless-handover/provider-switch-evidence.json`.

This proves the provider stop/recreate/retire contract for that bounded schedule.
It is not proof of an unbounded preview, external scheduler, or real bank
settlement; those unsupported cases remain blocked or require assistance.
