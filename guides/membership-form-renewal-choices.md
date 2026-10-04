# Membership Form Renewal Choices

**Author:** Replit Agent
**Last Updated:** October 2026
**Module:** Membership forms and successor payment ownership

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Eligibility and payment terms](#eligibility-and-payment-terms)
4. [Configuration and rollout](#configuration-and-rollout)
5. [Entry points and recovery](#entry-points-and-recovery)
6. [Verification and outstanding work](#verification-and-outstanding-work)

## Overview

This implementation is **locally verified; production rollout remains disabled**.
It connects the dedicated
Membership Payment element to server-resolved successor terms and introduces
shared database ownership before form and recurring-worker payment effects.
It does not change the generic Payment field.

The current term and successor are separate obligations. An early upfront
payment buys the full successor immediately while activation remains scheduled.
DD authorization is not payment settlement. Neither election may cancel a
current mandate, forgive arrears, or replace the old term's instalments.

## Architecture

| File | Purpose |
|------|---------|
| `api/_lib/formMembershipRenewalEvidence.js` | Pure assessment of persisted evidence and inclusive windows |
| `api/_lib/formMembershipRenewalContext.js` | Owner-scoped discovery, successor simulation and frozen-quote recovery |
| `api/_lib/membershipSuccessorElection.js` | Shared service-only claims and rollout capability check |
| `api/forms/membership-payment.js` | Form quote, upfront creation, and delegation to monthly setup |
| `api/_lib/formMembershipPaymentQuote.js` | Frozen upfront quote persistence and reconciliation fields |
| `api/membership/direct-debit.js` | Member DD setup from elected simulation |
| `api/membership/org-direct-debit.js` | Organisation DD setup from elected simulation |
| `api/membership/monthly-card.js` | Supported monthly-card setup and idempotency |
| `api/_lib/rollingMonthlyRenewal.js` | Shared worker claim before agreement creation |
| `api/_lib/stripeCardRenewals.js` | Fixed-date Stripe worker coordination |
| `api/_lib/ddRenewalCapabilities.js` | Explicit live/preview effect boundary for successor RPCs |
| `api/_lib/gocardlessDdRenewals.js` | Live interpreter for those effects |
| `client/src/components/forms/MembershipPaymentField.jsx` | Renewal states, dates, choices and current-obligation explanation |
| `client/src/pages/FormBuilder.jsx` | Builder guidance |
| `supabase/migrations/20261201_membership_successor_election.sql` | Ownership, grants, quote binding and write guards |
| `scripts/apply-membership-successor-election.mjs` | Explicit DEST-only contract inspection/apply runner |
| `api/_lib/successorPaymentAttempt.js` | Retry confirmed-cancelled upfront intents without replacing their original quote |
| `api/_lib/formMembershipRenewalDryRun.js` | Read-only snapshot preview using shared eligibility, price and DD scheduling code |
| `scripts/preview-membership-form-renewal.mjs` | Agent-invoked isolated preview CLI |

### Design principles

1. Server-loaded owner evidence decides whether a purchase is a renewal; request parameters cannot redefine it.
2. Persist the first accepted quote so retries do not reprice an existing commitment.
3. Acquire shared ownership before external effects to prevent competing successor payments.
4. Do not automatically release ambiguous external outcomes, because elapsed time does not prove that no charge exists.
5. Preserve the existing dry-run effect boundary rather than introducing direct writable RPC access into previews.

## Eligibility and payment terms

```text
successor start = persisted predecessor end + one UTC calendar day
successor end = calendar term calculation using the successor structure
window anchor = predecessor end (fixed) or successor start (rolling)
eligible dates = [anchor - purchased open days, anchor + purchased grace days]
```

Zero-day windows retain their literal meaning. Paused owners, untrusted
expiry-only records, overlapping histories, absent purchased policy and
conflicting reservations do not authorize a new payment.

Fixed upfront histories are not converted into rolling commitments.
Their predecessor relationship belongs to the election rather than fabricated
old anchor/renewal fields. New fixed upfront elected purchases store their
renewal policy separately from joining incentive evidence.

A continuing DD arrangement is presented as continuing automatically. Changing
the next term is optional within the purchased window. Future monthly-card
setup remains unavailable where the existing card implementation cannot defer
its initial collection; the form does not advertise that unsupported option.

## Configuration and rollout

Rollout is now tenant-specific through `membership_successor_tenant_rollout`.
The scoped capability takes `p_tenant_id`; the legacy no-argument capability
always returns false. Form quotes, worker reservations and the atomic database
reservation enforce the same tenant boundary. Missing rows remain disabled.
The tenant-rollout migration does not enable any tenant and refuses to replace
an active global rollout. BNMS is the intended first rollout; enablement still
requires the legacy-history and provider/browser acceptance checks below.
Deploy tenant-aware application code before enabling a tenant.

The tenant-rollout migration `20261205_membership_successor_tenant_rollout`
was applied to DEST on 4 October 2026. Read-back confirmed BNMS disabled,
zero enabled tenants and the legacy global capability disabled. SOURCE was
not migrated. Targeted tenant isolation and renewal regressions passed; this
does not establish production application deployment or provider acceptance.

No duplicate renewal-window setting is added to forms. Windows come from the
purchased policy; supported methods come from the successor structure and
tenant provider availability.

The feature is separately rollout-gated. A missing capability RPC or disabled
server-owned rollout row means the old joining
and payment behavior remains in use. Other database errors fail explicitly.
Installing the migration leaves rollout disabled. The application service role
cannot enable it. Resolve the outstanding work below before enabling rollout.
Legacy continuing arrangements without canonical history dates retain their
existing worker path if no election conflicts; forms cannot elect against
those undated predecessors.

### Migration status

- Required and installed: `20261201_membership_successor_election.sql`,
  `20261202_membership_successor_payment_attempts.sql`, and
  `20261203_membership_successor_unused_release.sql`, plus
  `20261204_membership_successor_attempt_settlement.sql`.
- Applied to disposable local PostgreSQL test clusters only.
- Applied to DEST: **all four, 4 October 2026**, with rollout disabled.
- Applied to workspace SOURCE: **no**.
- DEST prerequisite function contract fingerprint checked before applying:
  `8d21f5aad8d40f9cc6faf8911f3a7ae39880bfc3d15706fc8432c84c2708528f`.
- Applied migration SHA-256:
  `01185bd0d4c4fae4a96da3370a41cc86194de2cadcc34619a4abdd439faa630b`.
- Payment-attempt migration SHA-256:
  `02d53d8d55ed406d72cd16c11edcd6872c69efcaf1499907653906dec58850a6`.
- Unused-release migration SHA-256:
  `90d7cef5cfa0a091e0bd31063b9b13008550d4874cbc18efc5163b89514d64bb`.
- Attempt-settlement migration SHA-256:
  `73c6eaeac5866ae4d1bc8e7a850b5643a4a71716d5b608380ca87e1430f21744`.
- Post-settlement installed contract SHA-256:
  `09c023e2928bc8a1933d4a48ae897fb4538b7ac03f1f69db0da60b9c097f6f7a`.
- Read-back confirmed all four schema components, disabled rollout and zero elections.
- Provider contracts and deployed payment journeys verified: **no**.
- Production rollout or live financial changes: **none**.

The runner's default invocation prints its plan without connecting anywhere.
`--verify-dest` explicitly reads the approved DEST target's installed function
contracts. Applying requires separate approval and
`--apply --expected-contract=<reviewed hash>`. There is no SOURCE or default
database fallback. The hash is a drift check, not evidence of provider behavior.

## Entry points and recovery

The form uses `create_payment`, `start_direct_debit`, and `start_monthly_card`.
Monthly actions delegate through server-created request context; the browser
does not supply an authoritative simulation. Existing completion and webhook
paths continue to use saved payment quotes and billing agreements.

Repeated upfront requests reuse the same saved quote and provider idempotency
key. Existing DD agreement and flow recovery remain in use. A retry outside the
provider idempotency guarantee must not blindly create another charge.

Current reservation rows cannot be released by browser roles or ordinary
service-role table updates. An authenticated payer may use **Restart unused
renewal** after 30 minutes. Its service-only RPC releases only reservations
without any quote, agreement or membership history. A shared lock and insert
fence prevent a delayed creator from using the released election.

After a quote or agreement exists, elapsed time is never proof that no external
effect occurred. Resume the saved checkout or reconcile its provider outcome.
For an upfront intent confirmed cancelled by Stripe, a service-only attempt
ledger retains the same elected term and frozen quote while giving the retry a
new idempotency key. The original provider identity is never overwritten.
The rolling commitment guard accepts that replacement only through the
tenant/quote-bound attempt and its reserved form election. Real PostgreSQL tests
insert the paid history and replay it, rather than stopping at attempt binding.
Unbound attempts older than the provider-key retry budget require reconciliation;
they are not silently retried under a fresh key.

Fixed elected monthly-card setup saves agreement and history before Checkout.
A local binding failure preserves the owned Checkout session for same-key replay.
Form re-entry discovers the pending election through its persisted history,
agreement and quote relationships, even after the successor history's start
date arrives. It retains the original predecessor and frozen simulation;
paused owners remain blocked.
An expired or terminated monthly provider arrangement is not automatically
replaced or released by this operation. Its external state must be reconciled;
the restart button explicitly refuses it rather than promising a fresh plan.

## Verification and outstanding work

Local tests cover evidence windows, full successor dates and price, mandate-only
DD requests, delayed-date lower bounds, callback-first quote binding, an isolated
PostgreSQL form/worker reservation race, service-only grants, immutable replay,
and compatibility installation alongside existing rolling/DD migrations.
Existing provider recovery and renewal regression tests also run locally.

These are mocked-provider and disposable-database tests. They do not prove
GoCardless holiday scheduling, sandbox acceptance, actual collections, live
accounting delivery, or the authenticated browser journey.

Additional local coverage includes the actual upfront form request handler,
fixed-card provider/local-failure replay, concurrent cancelled-intent retries,
unused-release versus delayed-creator races, revoked elected mandates and
failed elected first collections. The existing PostgreSQL DD collection suite
now asserts that a prepaid successor and the old term remain independent during
collection retries and completion. Component tests cover restart refusal and
scheduled/paid versus merely active display.

Still required before production acceptance/enablement:

- Provider sandbox evidence for actual banking-day adjustment and both complete
  payment-method switch journeys. Fixtures cannot prove provider acceptance.
- Signed-in browser acceptance on a correctly mapped tenant. The development
  preview currently resolves to “Tenant not found”; component fixtures do not
  establish authenticated browser acceptance.
- Explicit rollout approval. No live charge, mandate cancellation, production
  member rewrite or feature enablement has been performed.

### Agent dry runs

Use the isolated runner, which removes live credentials and blocks network and
provider access:

```bash
node scripts/run-isolated-tests.mjs node scripts/preview-membership-form-renewal.mjs \
  scripts/fixtures/membership-renewal-upfront.json direct_debit 2026-11-01

node scripts/run-isolated-tests.mjs node scripts/preview-membership-form-renewal.mjs \
  scripts/fixtures/membership-renewal-upfront.json upfront 2026-11-01
```

The supplied example is illustrative, not a real member: £120 upfront or
12 × £10 DD, current expiry 31 December 2026, successor 1 January–31 December
2027. Results list **proposed** effects and an empty executed-effects array.
An actual expected provider collection date remains null until provider evidence
exists; the requested lower-bound date is reported separately.

The CLI accepts a local JSON snapshot containing `evidence`, the authoritative
successor `simulation`, and an optional `providerEarliestChargeDate`. It does not
fetch tenant/member data itself. A real-member preview requires separately
authorized read-only discovery first; do not invent missing historical authority.