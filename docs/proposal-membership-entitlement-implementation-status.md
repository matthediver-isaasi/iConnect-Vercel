# Proposal organisational membership entitlements

## Rollout status

On 2026-11-24, the six migrations below were applied atomically to the approved
live Supabase project `lvmzliemqnieeoruhkik`, recorded as
`proposal_membership_complete_contract_rollout`. Do not reapply them separately.
Post-install verification found zero grants, consumptions, reservations and
membership products, with service-only lookup access and no direct grant writes.
The isolated PostgreSQL suites and 64 focused behaviour/UI tests passed.

**Activation remains blocked on deployment parity.** Vercel's Production target
was verified as `capacity2` (`7ac6ec86edef7a72121fac029fded34bfb1c6bf3`), which
lacks the membership integration. Preview `funnel`
(`f7010ecc345364de82cafe3e2a0d204ae1daf80e`) includes it. Both use the live
database. The flag `PROPOSAL_MEMBERSHIP_ENTITLEMENTS_ENABLED` was absent and
was deliberately not added or enabled. Deploy matching readers and writers to
Production before enabling it across the environments sharing the database;
environment changes require fresh deployments. No deployment was initiated.
Catalogue discovery reports rollout pending while the flag remains off.

The approved migration sequence installed was:

1. `202701240001_proposal_membership_entitlement_contract.sql`
2. `202701240002_proposal_membership_catalogue.sql`
3. `202701240003_proposal_membership_consumption.sql`
4. `202701240004_proposal_membership_payment_reservations.sql`
5. `202701240005_proposal_membership_form_reservations.sql`
6. `202701240006_proposal_membership_fee_token_reservations.sql`

Deploy all matching readers and writers before enabling the flag. These depend
on the existing catalogue, quote, exhibition, membership history, rolling
commitment, membership payment quote and form submission schemas. The catalogue
migration patches the existing creation function only when its expected anchors
match; an unfamiliar function body aborts the migration rather than replacing it
blindly. Do not replay the entire migration directory or backfill old proposals.

## Commercial meaning

- A product names an explicit tenant-owned organisational schedule. It cannot
  simultaneously be an event ticket or exhibition space.
- A resolved line/component freezes the schedule identity/name and one-period,
  base-fee-only meaning. Product and bundle quantities must independently be one.
  Repeating a schedule in a proposal is an error, not a collapsed grant.
- Descriptions carry the included coverage through previews, accepted versions,
  public proposals and PDFs. No Sales price, tax or invoice timing is altered.
- The accepted-version status transition inserts immutable grants in the same
  transaction. Both acceptance actors use that status authority; invoice and
  notification outcomes do not control entitlement eligibility.

## Eligibility and creation

The organisational simulator looks up an exact schedule match for a new period.
It retains the normal annual price, freezes the original calculated base fee and
VAT, and previews a zero base fee. It does not consume the grant. It never
retrofits existing history or substitutes a successor schedule.

Every organisation history INSERT passes through the consumption trigger.
It locks the organisation and grant, checks the server-authored pricing marker,
and writes a separate consumption ledger in the history transaction. Failed
insertion rolls consumption back. A stale preview or legacy writer missing the
marker fails visibly instead of charging the base fee. The original grant,
consumption and covered history provenance cannot be edited.

The common incentive/history snapshot adapter carries proposal provenance into
record-fee, manual/advance renewal, workflow, annual renewal and saved-form
finalisation records. Approved add-ons remain payable. Approved add-on lookup
errors now fail rather than becoming an empty charge.

Monthly offers are not offered for a proposal-covered term. An existing payment
agreement requires review; this feature never cancels a subscription or changes
already committed provider charges. Rolling renewal history reservation also
passes the database creation guard before provider collection.

## Checkout ownership

Card membership checkout reserves the entitlement with its durable payment quote
before exposing a PaymentIntent. Repeated checkout creation reuses that original
quote and provider idempotency key. Generic form checkout reserves against its
saved submission before payment. A competing history writer cannot take a grant
reserved by either checkout.

Emailed fee links retain the proposal marker in their cost breakdown and reserve
by immutable fee-token identity before provider payment. Confirmation and
reconciliation retain this identity. Portal `create_payment` / `confirm_payment`
requests are delegated at the route entry to the shared form payment handler,
which uses the saved payment quote instead of the unreachable legacy branch's
fresh simulation.

A reservation is not consumption. Failed checkout can resume using the original
quote/submission. There is deliberately no automatic release after an uncertain
provider outcome and no cancellation/revocation policy in this feature.

## Payment and invoice evidence

Zero-due covered histories use `proposal_entitlement` as the payment method and
leave `paid_at` empty. The existing `paid` status is retained only as the legacy
activation/access state. The UI labels these rows **Complimentary — no payment
required**, not a received payment. Scheduled activation dates are retained.

Add-on amounts remain on history when present; invoice creation receives a zero
membership base and separate add-on lines. Provider dispatch guards prevent a
covered base being invoiced again. A retry verifies approved add-ons against the
saved history total before invoicing them.

The organisation benefits panel reads grants and consumption separately and
shows original base, adjustment and remaining fee. Proposal invoices are queried
by immutable accepted version, so later staged invoices appear without changing
the grant. All provider identities are retained. No invoice is interpreted as
paid merely because the benefit exists.

Entitlement reads require tenant administrator access. Proposal links and invoice
details additionally require the normal Sales view permission. No new public
invoice download authority or broader Sales permission is granted.

## Verification

All checks used isolated fixtures, never live invoices, collections, email or
backfills:

```sh
node scripts/run-isolated-tests.mjs node --test shared/proposalMembershipEntitlements.test.mjs api/_lib/proposalMembershipEntitlements.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test supabase/migrations/proposalMembershipEntitlementContract.test.mjs api/_lib/salesCatalogueCreate.postgres.test.mjs
node scripts/run-isolated-tests.mjs node --test client/src/components/proposalMembershipEntitlements.ui.test.mjs
node scripts/run-isolated-tests.mjs node --test api/_lib/salesQuote.test.mjs api/_lib/salesCatalogue.test.mjs client/src/pages/sales/catalogueProductForm.test.mjs api/_lib/formMembershipFinalize.behavior.test.mjs api/_lib/formMembershipPaymentQuote.test.mjs
```

The database tests use disposable Unix-socket PostgreSQL. They cover rollback,
duplicate quantities, standalone/bundle grants, stale consumption, concurrent
creators, checkout reservation retries, generic form ownership and role denial.
UI tests render fixture states; they do not prove authenticated production UI
or provider-side behavior. A separately approved rollout must verify the actual
target schema and matching deployed readers/writers.
