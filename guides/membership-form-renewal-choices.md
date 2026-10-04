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
| `api/_lib/formExpiryOnlyRenewal.js` | Narrow BNMS attestation and assigned-policy evidence checks |
| `api/_lib/expiryOnlyRenewalPolicy.js` | Reload immutable history/member/config-bound operator assignments |
| `api/_lib/membershipSimulationCore.js` | Independent successor pricing without fabricated legacy commencement or joining incentives |
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
| `supabase/migrations/20261206_bnms_expiry_only_form_renewal.sql` | Additive expiry-only reservation admission; does not enable rollout |
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

### BNMS attested expiry-only memberships

The read-only DEST audit on 4 October 2026 confirmed **83** non-deleted paid
histories with expiry but no commencement. All have the approved upfront-paid
attestation. **11** have an explicit immutable expiry-policy assignment with an
effective annual member schedule; none of those 11 has an open billing agreement.
The other **72 lack policy-assignment authority**. These counts describe
readiness, not payment permission, settlement verification or blanket approval.

The exception is restricted to BNMS member histories from the reviewed
`bnms_non_dd_current_backfill` import, the `2025/2026` membership year, paid
upfront annual GBP membership, unknown commencement and no recurring commitment.
It requires versioned provenance with the original source hash, the explicit
operator paid attestation, retained expiry authority and unknown-start authority.
An import note alone is insufficient.

`loadExpiryOnlyRenewalPolicy` reloads and validates the server-owned
`membership_expiry_policy_assignment` against the history, member, tenant,
expiry and assigned configuration. Its immutable 90-day opening/grace snapshot
defines the window. We use **that exact assigned config ID**, effective at expiry
plus one day; we do not infer a replacement schedule from a tier label or use
today's default. An unavailable/expired assignment needs separate review.

```text
verified imported expiry + immutable operator assignment
  → current commencement remains null; historical amounts remain unchanged
  → inclusive window: [expiry − 90 days, expiry + 90 days]
  → successor starts at expiry + 1 day, including checkout during grace
  → server reloads assignment and prices the full annual successor
  → shared atomic election reserves the successor before provider effects
```

The successor establishes its own dated term and anchor. The imported history
is not passed to rolling commitment builders as though it were a fully dated
commitment. Its identity remains in the election and `formRenewal.predecessorId`.
The simulator leaves tenure unknown, does not apply new-joiner incentives or
invent historical rollover credit, and never stamps a historical price.
The UI labels the old paid state as **administrator attestation, not verified
provider settlement**.

Additional undated histories or dated histories overlapping the unknown-start
record require review. Future paid/pending successors, open agreements, pauses
and existing elections still block a competing purchase. Frozen election
recovery remains separate from preparing a new quote. The database independently
revalidates the attestation, exact assignment/config, expiry, annual successor
length and conflicting obligations under the existing owner lock. Workers
cannot use this exception: it is for payer-initiated form renewal only and grants
no automatic billing consent.

Missing assignments return `expiry_only_policy_unavailable`; a missing database
capability returns `expiry_only_reservation_migration_required`. Neither state
can produce a new renewal quote. Provider failures and unexpected database errors
remain explicit failures, not permission to fall back to joining checkout.

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
existing worker path if no election conflicts. The BNMS form exception above
excludes any history linked to a billing agreement and does not expand worker
authority.

The old expiry-only grace-end sweep also recognises an elected recurring
successor. It requires the same tenant/member/predecessor election, matching
agreement and term dates, canonical current rolling term, active history, and
confirmed payment (`paid` or the DD/card `partial` progress state). The agreement
must be active, or completed with a settled term. A pending mandate, scheduled or
unactivated history, foreign/released election, cancelled agreement, expired
successor or failed evidence read cannot be treated as renewal protection.
On success the predecessor receives only its normal `renewed` lifecycle audit;
historical financial fields and member login/role remain unchanged. The successor
continues under its own collection and activation policy.

### Migration status

- New expiry-only migration: `20261206_bnms_expiry_only_form_renewal.sql`.
  **Applied to DEST only on 4 October 2026 after explicit approval**; not applied
  to SOURCE. Installed expiry-policy and tenant-rollout prerequisites were
  inspected before applying. The application checks its capability before
  offering this path. It changes no history, assignment, rollout flag or provider state.
  Transactional checks and a separate committed read-back confirmed both new
  functions installed, the capability returning true, service-only execution
  grants, zero enabled tenants, and global/BNMS rollout disabled.
  All 963 member histories, 365 organisation histories, 11 policy assignments,
  zero elections and existing rollout records retained identical fingerprints.
  These are migration safety checks, not provider or authenticated browser acceptance.
- Expiry-only migration SHA-256:
  `11c1e64c0bc1a342466718e78ed0b212220d386c48df4f0f282b3ab992c278ee`.
- Reviewed expiry-only prerequisite contract SHA-256:
  `c5467e6e43764a309e95c142c1944fb8245458ac8ab25508bcfd55e385c5cc2d`.
- Committed expiry-only contract SHA-256:
  `084371823be76028074619a4b078c7a928c848fc7dff7d269562eeaf91d9c685`.
- The 72 unassigned records require explicit operator-approved assignments,
  not a bulk inferred migration. No new assignments were made in this work.

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

For the expiry-only migration, select `--expiry-only`. Its inspection uses a
read-only transaction, verified TLS and independently pinned DEST SQL/REST project
identities. Application additionally requires `--expected-migration=<reviewed hash>`
and fingerprints the reservation, prerequisite functions, grants, table constraints
and assignment trigger. Brief table locks protect history/policy/rollout snapshots;
unexpected changes abort the transaction. Do not reapply an already-installed
or partially installed migration. No provider API is called by the installer.

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

Expiry-only tests cover inclusive windows, missing/foreign assignments, multiple
histories, pending/paid successors, pauses, frozen recovery and missing schema.
The real member simulator is checked with joining incentives enabled: the
successor still uses the full fee and tenure stays unknown. Disposable PostgreSQL
tests install the new migration, reject unassigned/forged/conflicting claims,
race upfront against DD and worker claims, replay the winner, check browser-role
grants and compare the unchanged predecessor. These are not provider acceptance
or authenticated browser evidence.

Grace-end regressions cover both DD and card successors with paid and confirmed
partial payment, unknown historical amounts, one-row response caps, pending
authorization/activation, ownership and boundary mismatches, completed plans,
elapsed successors and failed protection reads. They invoke the actual legacy
expiry sweep and assert that renewed members keep login without rewriting old
financial evidence.

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