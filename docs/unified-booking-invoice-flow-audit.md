# Unified booking/invoice flow: implementation audit

## Status

**Schema applied to approved DEST on 2026-11-19; activation remains disabled.**
The owner reports matching code deployed; reader/worker release capability has
not yet been independently verified. No live booking, provider, payment or
email writes were performed during the schema rollout.

### Approved schema rollout evidence

Applied `202701220001_unified_booking_contract.sql` using
`scripts/apply-unified-booking-contract.mjs --apply` to pinned DEST
`lvmzliemqnieeoruhkik`, with verified TLS. SHA-256:
`6ef29240623d9f8f84fc73e95dbc2a400858f3cd23460290d840f9300ee3529a`.
The related disposable PostgreSQL migration-chain regression passed, followed
by rollback-only rehearsal against the actual target schema before commit.
Independent post-commit reads confirmed three RLS/service-only tables and
14 protected functions. Existing booking-attempt/billing row hashes and the
legacy booking finalizer were preserved during application.

The normalized unique email index passes the readiness definition.
The rollout remains `enabled=false`, `reader_version=0`, `worker_version=0`;
the readiness reader returns version 2, disabled. Source was not modified.
No historical retries or test purchases ran. Application/schema discovery was
notified to reload. Re-run `--verify` for schema verification while the gate
is still disabled; never blindly replay this non-idempotent migration.
Activation requires independent reader/worker verification and separate
owner approval, as specified below.

Implemented boundaries:

- Standard **and** complex bookings, including purchases without vouchers, enter
  the same version-2 atomic booking/funding/intent transaction.
- Server-authorised customer discovery offers self and eligible organisation/group
  customers independently of payment method. Selected contact email is not the
  individual booker's email. Guest customers are booker-named; organisation is
  optional reference text and never an automatic organisation relationship.
- Provider-neutral private contracts freeze customer, original company,
  payment identity/parameters, ticket provisioning policy and tax instructions.
  Unknown versions and forged selections fail explicitly.
- New guest PO bookings create automatic unpaid billing records with explicit
  contract provenance, without invented administrator approval or a member
  prerequisite. New card/free/fully-funded transactions use the same authority;
  zero balances have no invoice or accounting handoff.
- A leased invoice outbox survives commit-before-enqueue crashes and failed
  scheduling/status writes. Optional member provisioning is independent, uses
  frozen ticket policy, and separates member creation from enabling login.
- Xero and QuickBooks consume the original customer/company snapshot, preserve
  existing addresses, distinguish uncertain lookup from confirmed absence, and
  reuse original write identities. Delayed QBO handoff has a narrowly bound
  exception to the old capture age windows, not a general bypass.
- Registration and billing reports show customer, invoice/retry/review and
  provisioning states. Guest classification survives explicit conversion; member
  activity association cannot remap/reissue an invoice.
- New PO bookings store actual `invoice` payment authority with separate original
  method/version markers, so existing reconciliation, invoice email and
  cancellation readers recognise real invoices. Historical `public_invoice_po`
  records keep their original record-only/approval semantics.
- Registration success is independent of post-confirmation accounting and
  provisioning failures. Authentication, payment, relationship, tenant, credit,
  capacity and atomic database persistence errors remain real failures.

## Audited legacy paths

The following table records the starting boundaries and the replacement contract,
not a list of unfinished runtime changes.

| Boundary | Current implementation | Required replacement |
| --- | --- | --- |
| Standard checkout | `api/functions/[functionName].js` registers bookings and later calls `completePublicTicketMembers`, then `enqueueCheckoutEventInvoice`; public PO is excluded | Commit booking, funding and invoice intent together; optional provisioning must not block invoice processing |
| Complex checkout | `api/public/complex-event-booking.js` has the same explicit public-PO exclusion after capacity/allocation/funding work | Same versioned authority and commit boundary as standard checkout |
| Card preparation | `eventInvoiceAddressPolicy.js` binds member/Xero address policy and Stripe request identity; `complex-event-payment-intent.js` consumes it | Provider-neutral booker/customer instructions for every payment method; preserve existing payment bindings |
| Customer choice | `EventInvoiceAddressStep.jsx` offers personal or linked-organisation **address**, not accounting-customer identity | Self plus server-verified eligible organisations and deduplicated direct/organisation-linked groups; independent of payment method |
| Contact producer | `eventInvoiceContact` chooses personal customer for card; organisation for non-card; guest organisation text can become contact name | Freeze the chosen customer for members; guest customer is always the booker, with optional company reference |
| Accounting capture | `eventInvoiceProducer.js` loads configuration after booking; failed enqueue relies on a separate status-marker write | Persist an intent/status before accounting work, so a crash or failed marker write cannot make an obligation disappear |
| Voucher continuation | `bookingCreditAttempt.js` retains funding invoice input and replays committed attempts, but continuation reads/status writes can throw | Preserve original committed registration result through post-commit invoice failures; reuse original snapshot and attempt identity |
| Provisioning policy | `publicTicketMemberPurchase.js` enables creation for association selections and changes ticket policy on public PO | New version must follow frozen ticket policy without automatic relationships; legacy snapshots retain original authority |
| Public PO validation | `publicInvoicePo.js` is explicitly record-only; existing address/purchaser validation is shared with historical paths | New version permits blank organisation reference and creates automatic unpaid invoice intent without a member prerequisite |
| Public PO approval | `public_invoice_po_bill` and `public_invoice_po_billing` store member/actor approval provenance; billing UI requires member creation | Separate automatic authority from historical admin approval; do not manufacture an actor or silently relax old provenance |
| Xero recovery | `eventInvoiceRecoveryXero.js` protects member-card addresses through lookup; deferred member address can be read at retry | New customer contract must apply across payer types/payment methods and use frozen address evidence, not current member data |
| QuickBooks recovery | `accountingEventSource.js` searches customer display name then checks contact email; captures provider/company | Support verified selected-entity ownership independent of booker email; retain company binding and ambiguous-write fences |
| Invoice email | `publicPoInvoiceEmail.js` operates on approved public-PO billing records and frozen/corrected booker details | Recognise explicit new automatic authority without automatically mailing historical intentions or uncertain sends |
| Cancellation | `bookingCancellation.js` excludes `public_invoice_po` from Xero credit-note work | Decide from versioned invoice evidence and existing refund authority, not method string alone |
| Reports | `event-registration-report.js` projects recovery markers and filters public PO by method/classification; billing UI is approval-oriented | Show durable pre-queue failures, frozen customer and automatic invoice status; keep guest classification after conversion |

## Versioned contract

Use a distinct booking-flow contract version, separate from provider snapshot
versions. A provider snapshot currently having `version: 1` is not a reliable
way to distinguish booking policy. The new booking contract is version 2;
documenting it does not install or activate it.

Only a server-created, tenant/source/event/attempt-bound durable record may
establish that version. A browser-supplied version is not authority.

### Immutable instructions

The transaction-time envelope must preserve these independent identities:

- Verified booker classification and authenticated member ID where applicable.
- Original booker name/email and guest organisation reference, if supplied.
- Chosen customer kind, tenant-scoped entity ID, name/contact and private invoice
  address evidence. Customer selection is never inferred from attendee, funding
  owner, cardholder or organisation text.
- Eligible relationship evidence at initial selection. Retry reads the frozen
  selection; it does not reselect a different customer from current relationships.
- Provider and company binding, or explicit unavailable/review evidence. Failure
  to establish a company must not silently bind a later company's invoice.
- Original payment attempt identity, method, verified Stripe evidence or unpaid
  PO instructions; amounts, currency, credits, tax and line evidence.
- Ticket member-creation and guest-access policy, separately snapshotted.
- Booking group, expected batch, event kind and invoice eligibility.

Store private instructions in service-only protected storage, not in broadly
readable booking JSON or client-writable settings. Reports receive a redacted
projection. Reject unknown versions rather than treating them as legacy.

### Commit and replay

1. Authorise booker and selected customer; validate permissions, amounts,
   payment evidence, capacity and credits. These remain real failures.
2. Prepare immutable instructions under the original scoped attempt identity.
   On replay, changed inputs conflict; a missing payment response never creates
   a fresh charge identity.
3. Commit booking/funding and durable invoice intent/status atomically. This
   requires additive transactional RPC changes covering **all** entry paths,
   not just the existing public-member or voucher batch RPC.
4. A worker claims committed intents using leases and fencing. Provider capture
   is an idempotent handoff. Crashes between commit and enqueue remain discoverable
   from the intent table without reconstructing current settings.
5. Invoice/provider/link/provisioning failures update retry/review state.
   Successful registration is not reversed by these failures. A status-write
   failure leaves durable pending work discoverable for another worker.
6. Free and fully-funded transactions record non-applicability; they do not
   become zero-value invoice operations.

### Historical compatibility

- Missing booking-flow version permits only genuinely legacy payment authority,
  never new automatic authority. Both booking handlers recognise version-2
  Stripe metadata and require the original tenant/source/event/member-bound
  contract, attempt and payment ID. Legacy/version-1 submissions of such payments
  are rejected before booking or compensation. Existing new-flow booking
  details are not returned through a legacy payment replay.
- Existing pending card attempts, provisioning snapshots, billing approvals and
  queued provider operations keep their original instructions.
- A historical public-PO record remains record-only until its existing explicit
  approval path is used. New automatic work must not masquerade as that approval.
- Later member conversion may attach safe activity visibility but cannot replace
  invoice customer, reissue an invoice or change original guest classification.
- Unknown/new operations must be excluded from old worker claims at the database
  boundary. A UI-only rollout flag cannot prevent an old worker from consuming
  incompatible work.

## Readiness and rollout sequence

Schema rollout was approved and completed as recorded above. Activation remains
separate; the sequence below defines the remaining release gates.

1. Apply additive service-only schema/RPCs and immutability/replay guards after
    explicit environment approval. The new migration is
    `202701220001_unified_booking_contract.sql`. It deliberately starts disabled.
    Run the related migration-chain regression against disposable PostgreSQL,
    then rehearse the target's complete actual schema/migration chain before
    applying it there; repository fixtures are not a copy of that target.
2. Deploy compatible report, invoice, email, cancellation and recovery readers;
   ensure old worker claims cannot consume new authority.
3. Verify schema and worker capability, then enable new attempt creation through
   a fail-closed operational readiness gate. This is not a GFI/BNMS business-policy
   toggle and must not vary customer rules by tenant name.
4. Rollback disables **new** version-2 attempts, not recovery of existing ones.
   Keep compatible readers/workers and durable instructions until in-flight work
   finishes. Never downgrade a version-2 attempt to the old approval path.

### Activation checklist

- Keep `unified_booking_rollout.enabled = false` during schema and code deployment.
- Deploy the compatible standard/complex handlers, reports, invoice email and
  recovery worker together. Existing worker schedules must continue running.
- Confirm service-only grants, immutable snapshots, normalised member-email
  uniqueness and all legacy guard migrations on the approved target.
- Only after reader/worker verification, set `reader_version = 2` and
  `worker_version = 2` on the singleton. Set `enabled = true` in a separately
  approved activation. `unified_booking_readiness()` also verifies the actual
  valid normalised unique email index; readiness is not a tenant-name policy.
- Existing prepared version-2 contracts replay their original authority even if
  readiness later changes. Never clear those records or disable compatible
  consumers as a rollback.
- If rolling back, set only `enabled = false` to stop new version-2 contracts.
  Keep this additive schema and compatible readers/workers. Existing pending
  Stripe attempts and queued invoice operations must finish with their original
  customer, company, amount and payment identity.
- Observe pending/processing age, retry/review reasons and optional provisioning
  failures before expanding traffic. A company that could not be frozen remains
  review work; do not silently adopt today's accounting company.

## Local verification

Executed under the repository's fail-closed test isolation boundary:

```sh
node scripts/test-unified-booking-invoices.mjs
```

This sequential command covers new-contract unit, real HTTP-handler and mounted
UI regressions, plus disposable PostgreSQL suites. Its provider preparation
matrix crosses both providers, both event sources, all four customer kinds and
card/PO, with separate zero-balance assertions. Payment replay, expiry,
relationship changes, forged customers, incomplete discovery, existing-member
guest safety, handoff uncertainty, failed status writes, redacted reports and
optional provisioning failures are included. Historical producer/worker,
approval, email, report, payment-permission and mounted-control suites run too.

The PostgreSQL fixture applies the actual related public-PO, Xero recovery,
QuickBooks capture/queue, approval, correction and new unified migrations in
order. It verifies both event engines, atomic intent publication, readiness,
protected grants, immutable instructions, fenced replay, delayed QBO capture,
safe activity conversion and optional provisioning enabled/disabled/failure.
This is not a claim that every migration in the repository was replayed against
an exact production schema.

Provider requests are mocked; PostgreSQL uses fresh local Unix-socket databases,
not configured database URLs. No payment, contact, invoice or email was sent to
an external service. Build and preview observations must be recorded separately
from these isolated regression results.

### Recorded results

- 454 unit/handler/mounted checks passed in the complete sequential command,
  including omitted/version-1 payment downgrade attempts by guests and another
  authenticated member, mismatched contract scopes, refund/cancel rejection,
  non-card payment smuggling and committed-booking privacy.
- All eight disposable PostgreSQL suites passed, including the related migration
  chain and automatic billing/contact/optional-provisioning transaction.
- `npm run build` passed. Vite's existing large-chunk warnings remain.
- `git diff --check` passed.
- The application workflow restarted and serves port 5000 without a startup
  exception. The root screenshot still displays
  `Public API Error (404): Tenant not found`, matching the pre-existing preview
  tenant-resolution failure. The signed-in checkout/report UI was **not**
  visually verified in this environment; mounted component tests are not a
  substitute for that check.
- These original local results predate the approved schema application recorded
  above. Activation and live provider verification remain outstanding.
