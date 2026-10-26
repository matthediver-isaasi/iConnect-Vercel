# Self-service membership changes: implementation boundary

## Investigation

The reference BNMS form `6880a70a-8643-4fcc-a5b9-0af603f00b40`
uses a payment element whose price source is a hidden, locked Member Class radio.
No live form configuration was changed during this investigation.

Existing code to extend:

- `memberAmendments.js` and `memberAmendmentQuote.js`: authenticated-admin
  proposals, purchase snapshots, actual-day proration, idempotency and history.
  Current public capabilities deliberately restrict the active flow to a subset
  of fully paid upfront annual purchases, retaining the existing term.
- `memberAmendmentSettlement.js` and `memberAmendmentFinance.js`: additional
  Xero invoices, retained credit-note handling, verified manual refunds,
  application/reconciliation and notifications.
- `memberAmendmentMonthly.js` and its provider adapters: preparatory monthly
  inspection/amendment helpers, not a complete connected operational flow.
  Read `api/membership/member-amendments-monthly.contract.md` before integration.
- Existing membership vouchers and successor/renewal authority must remain the
  owners of credit reservation and competing future terms.

## Implemented preparatory slice

Admin Settings now includes Membership Changes & Credit Handling.
GET/PUT `/api/admin/membership-change-policy` uses authenticated tenant-admin
authority and explicit tenant context.

Safe defaults:

- Surplus requires administrator approval.
- Newly issued surplus credit has no expiry; administrators may choose 1–36500 days.
- Upgrades and downgrades require approval.
- Cancellation is at end of term, without unused-value credit/refund by default.

Saving this configuration does not enable any self-service execution. The API
returns `executionEnabled: false`, and the settings UI explains this.

The additive migration `20261217_membership_change_policy.sql` was **applied to
live DEST on 26 October 2026**, with owner approval. It adds a protected singleton policy and immutable policy
history; revision checks serialize even the first save. It does not update
existing forms, schedules, memberships, payment agreements or provider accounts.

Live verification confirmed RLS on both tables, no anonymous/authenticated
table or save-function access, service-role read-only table grants, and
service-only execution of the pinned-search-path save function. Both tables
were empty at application; no tenant policies or financial actions were created.
Migration SHA-256: `e28f938bf7d9f22b0657b0a3f9a8b878be00604b3a05b5a8182e796968d10eaf`.

## Still required for the original brief

### Shared calculation work added on 26 October 2026

`memberAmendmentCalculation.js` now supplies exact calendar-day and minor-unit
arithmetic shared with the existing admin quote path. Its additional internal
reconciliation/term functions cover retained terms, replacement terms,
immediate/end-of-term cancellation, and purchase-scoped settled funding.
Monthly evidence must include reconciled delivered-service obligations rather
than an assumption that half an annual price is refundable.

`membershipChangePolicy.js` also plans approval, surplus handling and credit
expiry using the governing source schedule; replacement-term downgrades remain
downgrades even when they require an additional payment.

These are **internal calculation functions, not enabled execution endpoints**.
Only the shared proration helper is integrated into the existing administrator
flow; new financial planning still requires trusted production evidence adapters,
atomic execution and UI integration. The monthly plan deliberately requires
provider coordination and does not label a remaining obligation as a charge due
today. Mixed-tax, partial/refunded funding, failed/pending collections, liabilities
and non-member funding block automatic settlement. Voucher returns are flagged
for their original credit authority, not converted into cash or extended expiry.

Both exact £100-to-£75 acceptance calculations pass in isolated tests. These
results do not demonstrate real provider collection, entitlement changes, credit
issuance or cancellation.

This is unfinished implementation work, not a list of optional enhancements:

1. Shared execution authority for retained versus replacement terms, governed
   consistently by the source membership's schedule; immutable financial evidence
   must account for real settled funds, previous credit/refunds and outstanding
   obligations rather than treating an invoice price as available cash.
2. Durable provider-operation claims and collection holds covering all Stripe
   and GoCardless workers, including in-flight collections and ambiguous outcomes.
   Dynamic DD needs the effective-dated revision/reservation bridge documented
   in the existing monthly adapter contract.
3. Personal surplus credit issuance using existing credit ownership/reservation
   infrastructure, including no-expiry support in all consumers, and explicitly
   authorised automatic refunds or visible manual intervention.
4. Immediate/end-of-term cancellation authority that coordinates access,
   obligations, future renewal and collection schedules without cancelling
   unrelated mandates or losing liabilities.
5. Explicit FormBuilder opt-in, authenticated current-purchase resolution,
   prefill and target eligibility, shared preview/confirm, member management UI
   and administrative approval/history using the same backend.
6. The full brief's financial examples and twenty acceptance scenarios, then
   deployment/migration and controlled provider testing. Existing application
   forms must remain unchanged unless explicitly enabled.

## Checks completed for the preparatory slice

18 focused tests passed: API validation and tenant authorization, expiry rules,
missing-schema failure, revision conflict, real isolated PostgreSQL grants and
concurrent first saves, plus mounted settings UI tests including tenant switches
and failed/ambiguous saves. No live payments, refunds or emails were
performed; the only live write was the approved policy-storage migration.
These tests are not acceptance evidence for the unfinished execution
flows above.

## Provider evidence integration

The original-payment verifier is now shared by the administrative preview,
confirmation and settlement paths. Preview and confirmation independently read
the source Xero invoice and its payment records and, for card purchases, verify
the original Stripe PaymentIntent and charge. Missing, refunded, credited,
ambiguous or unavailable evidence does not become a spendable balance.

The confirmed quote fingerprints the accounting tenant, payer contact, invoice,
payment IDs and exact original amounts. Settlement refuses changed provenance.
Zero-difference changes now verify the original payment too, including a fresh
read before application. Legacy zero-difference reservations without that
evidence require review rather than gaining access from their old state flag.

This code does not create a new payment document during preview, and does not
implement the remaining self-service UI, replacement-term application, monthly
provider coordination, cancellation or personal-credit issuance. The execution
migration approval was given conditionally on implementation and testing; no new
execution migration has been applied at this stage.

## Dormant monthly operation infrastructure

`memberAmendmentProviderOperations.js` adds an internal reserve/claim/write/
read-only-reconcile boundary around the existing fixed-card/fixed-DD adapters.
The draft migration `202612310022_member_amendment_provider_operations.sql`
persists prepared evidence, uses one active operation per plan and purchase,
serializes claims, and holds local collection/retry/cancellation writes.
Only an unclaimed reservation can be abandoned; an uncertain provider result
cannot release a hold or authorize another write.

**Not enabled and not applied to live DEST.** No API or worker invokes this
module yet. It must not be wired to a member or administrator action before
atomic entitlement finalization and the full production collector-path audit
are complete. In particular `provider_applied` deliberately retains its hold:
it is not a completed membership change. Dynamic DD is rejected before
reservation until its effective-dated price-revision bridge exists.

Isolated orchestration/PostgreSQL tests cover concurrent claims, permissions,
collection guards and ambiguous-result recovery. These tests are not proof of
the unimplemented end-to-end self-service journey or a completed migration
rollout. The owner's conditional migration approval remains unused.
