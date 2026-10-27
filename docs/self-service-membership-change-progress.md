# Self-service membership changes: implementation boundary

## Step 3 financial execution — accounting decision and initial guard

The owner selected iConnect-only member credit with liability accounting.
New surplus must not remain independently spendable as an accounting credit
note as well as a member voucher.

The existing membership-voucher redemption path already posts explicit funding
against gross invoices using the dedicated voucher clearing account. Therefore
credit readiness uses that same mapping, not a separate issuance-only account.
For Xero credit-policy previews, the server now verifies an active,
payment-enabled CURRENTLIABILITY account, matching base currency and the same
accounting organisation as the original payment. Its identity is included in
the confirmed authority; confirmation re-resolves it rather than trusting
browser-supplied account details.

This is a read-only prerequisite, **not completed credit issuance or Step 3**.
No provider transfer, voucher or new financial execution is enabled by this
guard. Still required: durable accounting-transfer claims and reconciliation,
atomic backed-credit issuance with membership application, no-expiry consumer
coverage, redemption binding enforcement, and the subsequent replacement-term
and cancellation execution paths. Preserve the existing retained-credit-note
semantics for historical settlements.

The admin Membership tab now also exposes the shared upfront financial-change
flow: preview, confirmation, separate explicit approval, collection-invoice
links, recorded/manual refund status, and read-only recovery/history. A first
recovery checks the saved authority and returns an approval-required state
instead of failing because execution has not yet begun. Confirmation recovery
does not persist personal form data in browser storage.

Personal credit remains independently disabled in BOTH the server execution
choice validator and the UI capability flag. A verified liability account is
not permission to issue credit. Existing retained-credit-note settlements keep
their historical semantics. Replacement terms, cancellation and monthly balance
settlement are not enabled by the upfront controls.

268 focused backend/database and mounted UI tests passed; the production build
passed. No database migration was needed or applied for this update. No live
payment, refund, credit, invoice or membership was changed during verification.

## Current connected monthly delivery — 26 October 2026

This section supersedes the historical implementation notes below.

The retained-term monthly administrative path is now connected from the member
Membership tab through authoritative preview, immutable confirmation, explicit
finance approval, provider execution, atomic application and recovery. It covers
fixed Stripe schedules, fixed GoCardless amounts and dynamic GoCardless pricing
revisions. Recovery never starts a new provider write. Approval is recorded
atomically with the write claim, so an interrupted response cannot orphan an
otherwise approved operation.

Dynamic pricing revisions serialize with collection reservations. A reservation
must carry the effective revision and current matching pricing snapshot. Fixed
operational amounts, application, hold release and the notification queue commit
together. Original purchase/consent evidence remains unchanged. New instalment
invoice context uses the applied target at the original collection/service date;
historical invoices and earlier periods retain their original context.

The admin panel offers separate monthly preview/save/approval/recovery states,
retains an uncertain confirmation's idempotency key across reloads, and shows
operation and notification history. It does not expose the unfinished member
FormBuilder flow.

### Financial eligibility remains deliberately restricted

Executable quotes currently require complete Xero-backed historical invoice
and independently verified payment evidence, personal cash funding, and no
unsettled balance or prepaid surplus needing a separate settlement. Fixed
remaining instalments must divide exactly. Discounts, conditional VAT,
voucher-reduced/mixed funding, replacement terms and cancellations are rejected,
not silently approximated. This is **not unrestricted monthly amendment support**
or completion of the entire self-service brief. In particular, many fixed
annual-instalment purchases have a difference between daily service consumed
and cash received and will require the later settlement flow.

### Verification and rollout

- 428 relevant isolated tests passed, including PostgreSQL concurrency,
  permission, atomic rollback and stale-price checks; mounted admin tests passed.
- Production build passed.
- Development workflow restarted and login route rendered. The authenticated
  admin panel was checked through mounted tests, not a live signed-in browser.
- Applied `202612310026_member_dynamic_monthly_application.sql` to live DEST
  `lvmzliemqnieeoruhkik`.
- SHA-256: `77f08b93ce30d1444cf315488bde19f1d0017b65801bf432f916d0448adb05d0`.
- Verified service-only entry points, protected internal finalizer, notification
  RLS and absence of direct notification DML for public/authenticated/service
  roles. There were zero provider operations and notifications after migration.
- Earlier execution migrations 022 and 025 remain applied. No further migration
  is pending for this delivery.
- No live provider mutation, member change or test notification was performed.
  Deploy the updated code before using the connected administrative flow.

## Source cash/service reconciliation for monthly quotes

The production purchase adapter now offers `reconcileFunding`: it joins
independently verified provider receipts to the source-linked invoice net/VAT
and historical service prices. An authorised invoice alone is never paid cash.
Missing, duplicate, unsettled, mismatched or additional unpriced receipts prevent
a complete funding result. Payment dates follow actual collection evidence;
service consumed still follows original membership-start anniversaries.
Provider funding is re-read after invoice verification to reject concurrent
settlement changes.

This currently admits the existing strict dynamic-DD/Xero historical-price
scope only; it does not support voucher-reduced payments or other accounting
providers. It does not implement a target monthly pricing quote, dynamic-DD
revision execution or notifications, and it does not make Step 2 complete.

## Monthly execution coordinator

`memberMonthlyChangeExecution.js` now coordinates confirmed authority, fresh
purchase/provider ownership checks, provider execution and atomic finalization.
Only stored monthlyExecution version-1 pricing/provider authority is accepted;
posted payment amounts are ignored. Source, target structure and band snapshots
are revalidated before a new operation. Replays use the durable operation
instead of trying to reload an already-changed Stripe schedule as a new purchase.
Recovery never initiates a provider write and uses only saved approval.

This coordinator is internal and is not yet exposed by the production endpoint:
the production confirmation resolver still needs to produce the fully verified
monthlyExecution envelope. Its tests use explicitly synthetic authorities.
Dynamic DD and notifications remain unfinished. This is not Step 2 completion
or authorization to enable monthly member-facing execution.

Read-only provider reconciliation no longer rejects a previously prepared
operation solely because its effective boundary has passed. New preparation
and new provider writes still require a future boundary. Changed payment
evidence remains uncertain; this does not waive finalization checks or enable
dynamic DD.

## Live DEST migration status — 26 October 2026

Applied together in one transaction to pinned DEST `lvmzliemqnieeoruhkik`:

- `202612310022_member_amendment_provider_operations.sql`
  SHA256 `016d6c22853c8650d663e61da020eabece560c4d26f936b63036c0db2ad7c32c`
- `202612310025_member_monthly_finalization.sql`
  SHA256 `dce558e58639e2d8e115167dfe28ca78cad6947ec44af00ac61074afb6eaad55`

Verified RLS on all three new tables, no direct writes for anon/authenticated/
service_role, and service-only execution of all seven operational RPCs.
The pending finalization queue was empty. No provider calls, membership changes,
or financial operations were executed. SOURCE was not modified.

This supersedes the historical “unapplied” notes below; it does not enable the
unfinished monthly entry flow. Dynamic DD integration and monthly confirmation
authority still require implementation before member testing.

The retry audit confirmed that GoCardless retries the existing provider payment
by ID, not a new payment at the current plan price. Retry preview evidence now
leaves a missing original amount unknown instead of substituting the plan price;
the original failed-payment amount survives a prospective pricing change.

## Monthly operational entitlement projection

The shared single-member and batched reporting readers can now project a
finalized monthly operation's effective-dated membership scope while retaining
the original purchase amounts, invoice linkage and consent snapshot. Future
changes are not promoted early; expired changes remain audit evidence only,
except that renewal resolution can select the last purchased scope.
Provider-applied is not finalized and cannot grant membership.

The required finalization payload is deliberately explicit:
`operation.evidence.application` contains operationId, effectiveDate, expiresOn,
appliedAt and targetSnapshot (config/band). It must match the operation's
persisted source purchase/agreement/plan and the original renewal boundary.
Only one finalized operation per purchase is currently supported; ambiguous
rows fail closed instead of selecting a winner.

The draft `202612310025_member_monthly_finalization.sql` emits this payload
atomically with operation finalization (which releases the collection hold)
and the audit event. It admits only fixed monthly retained-term changes with
confirmed administrative authority, no surplus or carried prepaid value, no unresolved funding blockers,
exact approved/provider future obligation, and unchanged source/target evidence.
The internal `finalize` method re-reads the provider before calling it. SQL
rejects provider evidence older than sixty seconds.

Administrative finalization approval is stored immutably before reconciliation,
with tenant/operation/actor/reason binding. The scheduled recovery job can finish
only these approved operations; it never invents approval or starts provider
money movement. Uncertain outcomes stay held. A failed application remains in
the pending queue; a committed application disappears from it atomically.

Real isolated PostgreSQL tests verify injected final-audit failure rolls back
application and leaves the hold intact, concurrent finalization is idempotent,
uncertain outcomes cannot apply, original purchase evidence remains unchanged,
and anon/authenticated roles cannot invoke the RPC.

This is not an enabled monthly execution path. Production monthly confirmation
authority, dynamic collection revision pinning, collector/retry pricing-reader
audit, notifications and end-to-end production integration still need completion
before either monthly migration can be applied. No live database migration or
financial operation was performed.

## Scheduled monthly provider reconciliation

The existing authenticated amendment cron now includes bounded recovery of
stale claimed monthly provider operations. It loads executing/uncertain rows
in oldest-updated order, preserves their original tenant/member/actor binding,
and calls only read-only provider reconciliation. It never starts a provider
write, retries an unknown write, releases a hold or claims membership completion.
Provider success is reported as requiring finalization. Individual failures
are isolated; missing storage is explicitly reported as migration-required.
Unclaimed reservations and already provider-applied rows are not selected.

This closes automatic provider-outcome recovery, not atomic entitlement
application. The monthly infrastructure migration remains unapplied, so this
runner reports disabled on databases without it. Effective-dated monthly
pricing/application and transactional hold release are still required before
monthly changes can be enabled. No live financial operation was performed.

## Step 1 authority storage

Added `202612310023_member_change_authority.sql` and the internal shared
`memberChangeAuthority.js` confirmation service. The storage records source,
target, calculation, funding evidence, settlement requirements and policy
snapshots with authenticated actor provenance. It is append-only and service-only.
Confirmation serializes on the member, verifies current source/target/policy,
rejects competing legacy proposals, and supports exact idempotent replay.
The legacy insertion guard closes the inverse conflict path.

The service now has a production resolver, `memberChangeAuthorityResolver.js`,
which reuses the existing provider-backed original-payment verification and
v2 calculations. The authenticated finance-admin endpoint
`POST /api/membership/member-amendments` accepts `preview_change` and
`confirm_change`. Both require `memberId` and `selection` (configId, optional
bandId, reason, optional effectiveDate). Confirmation additionally requires the
preview fingerprint and idempotencyKey. Browser-supplied payment evidence,
tenant and actor identities are not used as authority.

The admitted production scope is the existing verified paid-upfront annual
personal purchase scope, with retained/replacement-term calculations governed by
the source schedule. Confirmation re-reads provider evidence, snapshots the
tenant approval/credit policy, and records requirements without applying them.
Monthly funding and cancellation evidence remain unsupported and fail closed;
member initiation remains disabled until the opted-in FormBuilder flow exists.
Thus this connects authority recording for the admitted scope, not all planned
payment/cancellation rails.

The Step 1 migration was applied to live DEST on 26 October 2026.
SHA-256: `a920cb708db9d01bd506fe17e33565bfc94f98bb802d1f0de93e61a89d820018`.
Live checks verified RLS, no anon/authenticated table or function access,
service-role SELECT-only table access and service-only confirmation execution.
The authority table contained zero records after migration. No purchases,
payments or entitlement were changed. No UI exposes the new actions yet. Neither action
settles, applies membership, issues credit or releases provider holds.

### Step 2: confirmation recovery

`recover_change` on the same finance-admin endpoint reads the immutable record
using member, tenant, request key, actor and preview fingerprint. Confirmation
retries recover an already-saved matching request before consulting providers.
A changed selection, actor or fingerprint conflicts; storage errors do not
silently create a replacement request. This recovers confirmation only, never
represents it as settlement or applied entitlement.

### Step 2: retained-term upfront execution

`memberChangeExecution.js` now connects a confirmed authority to the existing
settlement/application engine, instead of introducing a second entitlement
reader. Finance-admin POST actions `execute_change` and `resume_change` accept
memberId and authorityId. Execute additionally requires approve=true, a reason,
and settlementChoice (`collect`, `refund` or `none`). The immutable execution
link records explicit approval and the chosen rail. Conflicting legacy proposals
remain blocked; generic settlement calls cannot override the approved choice.

Supported execution is **retained-term, verified upfront personal annual rolling
membership only**. Collection creates the existing additional-payment invoice;
refund uses the existing verified manual, bank-reconciled refund process, not
automatic cash transfer. Personal-credit issuance, replacement-term execution,
cancellation and monthly provider changes remain blocked.

Resume never initiates money. Existing reservations are reconciled read-only;
only verified settled outcomes proceed through the existing atomic application
RPC. Application, settlement state, audit event and notification are committed
together. A failed final database write leaves settlement recoverable, and an
already-applied operation returns its existing application. The existing cron
now also resumes due approved executions within a shared invocation budget.

`202612310024_member_change_execution.sql` was applied to live DEST on
26 October 2026 after isolated tests and exact live prerequisite-function body
comparisons. SHA-256:
`a5cfc11777690802be5a927aff5f37d4193b0d253ca4ec1a50b30c409b48e866`.
RLS, service-only RPC execution, SELECT-only service table access and denied
anon/authenticated access were verified. Zero execution rows were created.
The application code still requires deployment; no live financial calls were made.

Real PostgreSQL tests inject a failure in the final notification insert to prove
that application and state updates roll back together; concurrent retries then
commit one application while leaving the original purchase unchanged.

**Monthly provider-hold release remains unfinished and its migration remains
unapplied.** Upfront purchases in this admitted scope have no recurring collection
plan to release. These results must not be reported as completed monthly
finalization or completion of the entire self-service feature.

### Monthly purchase evidence adapter

The owner confirmed that variable-monthly service periods follow membership-start
anniversaries, independently of scheduled or actual collection dates.
`memberVariableMonthlyService.js` now reconciles historical, purchase-scoped net
and VAT prices by those periods, with independent month-end clamping and exact
partial-period day proration. It retains a period/evidence audit breakdown and
rejects missing, duplicate, foreign, unverified or misaligned price evidence.
The shared funding reconciliation invokes this resolver when supplied variable
monthly period evidence; an explicit monthly-price basis cannot fall back to an
unexplained delivered-service total. No annual-price/12 or current-price fallback
is used. Variable monthly target changes still require the effective-dated
collection quote; the fixed-term calculation refuses to invent one.

The read-only historical-price loader now joins tenant/plan-scoped dynamic DD
reservations to their payment ledger and retrieves the source-linked Xero invoice.
It requires the original full-service gross price to match the invoice's net/tax
totals, rejects adjustments and ambiguous links, and maps collection ordinals to
membership anniversaries. The purchase authority exposes this as `reconcileService`.
This is not an assertion of settled cash; authorised unpaid invoices can prove
service prices, but cannot become settled funding.

Coverage remains deliberately limited: voucher-reduced collections, missing
invoices, shortened final periods and non-Xero accounting need additional evidence
adapters. No current-price or annual-price/12 fallback exists. The dynamic revision
writer and monthly finalization remain unfinished. No migration or live financial
mutation was made for this loader.

`memberMonthlyPurchaseAuthority.js` loads the single current purchase, consent
agreement and payment plan using paged tenant/member-scoped reads. It verifies
the saved term, currency, instalment count, personal ownership, environment and
provider linkage before deriving a finite calendar from the provider schedule
or the original dynamic plan anchor. Month-end dates are clamped independently
from the original anchor, not accumulated from February.

Its read-only `prepare` method calls the existing monthly provider inspector.
Targets must still come from a trusted server pricing resolver; this internal
adapter is not exposed as a browser endpoint and does not enable execution.
Initial one-off DD payments are reconciled separately against the provider's
settled payment, saved date, mandate, amount and currency. Their date is
preserved independently from the recurring subscription's calendar. Dynamic
collection-day changes use the existing collector SQL history resolver; a
concurrent plan change causes the evidence load to fail rather than returning a
mixed calendar. Unverifiable histories remain blocked.

Monthly prepared evidence now separates settled gross receipts from submitted
or pending Direct Debits. Generated obligations remain immutable, but are not
reported as paid money. Usable credit remains null pending independent
delivered-service, tax and prior-credit reconciliation. No annual-price/12
assumption is used to fabricate credit.

48 isolated monthly/provider-operation/execution tests pass. No migration was
needed for these evidence helpers and no live provider calls were made.
Effective-dated pricing revisions, their reservation bridge, monthly entitlement
readers, atomic finalization and hold release remain unfinished.

37 focused tests pass, including real PostgreSQL concurrent confirmation,
stale target, actor ownership, immutable data, service grants, browser denial,
legacy conflict and changed-evidence refusal. These do not constitute provider
or live-provider/end-to-end verification. Resolver integration tests check fresh
evidence reads, ignored posted funding, governing-policy changes and disabled
member initiation; handler tests exercise authentication, tenant mismatch,
finance permission and session-derived actor binding.

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

### Claimed purchase/consent protection

The staged operation migration also guards updates and deletes of the source
membership and billing agreement after an external write has been claimed.
The guard serializes on the affected payment plans, remains in place for
uncertain and provider-applied outcomes, and protects agreement re-parenting as
well as deletion. Before a claim, changed snapshots still cause the existing
claim revalidation to fail.

The isolated PostgreSQL test now exercises these writes as `service_role`,
including source expiry and agreement ownership changes. All seven operation
orchestration/PostgreSQL tests pass. This closes an additional safety gap; it
does **not** implement atomic membership finalization or authorize releasing
holds on claimed operations. The migration is still unapplied and the new flow
remains disconnected.

Collection evidence cannot be re-parented into or out of a held plan either.
Those guards check both old and new plan ownership under ordered plan locks;
ordinary provider status/evidence updates remain allowed for reconciliation.

The next finalization work must introduce a validated membership-change
authority, not treat the existing provider adapter's `target.amountMinor` or
`target.termTotalMinor` as an entitlement selection. The adapter currently
binds billing economics, whereas the operational entitlement reader explicitly
supports only the original upfront retained-term scope. A finalizer that merely
sets the provider operation to `finalized` would release collections without
making monthly, replacement-term or cancellation entitlement effective in
those readers. Both authority and readers must be extended before wiring the
operation to a member-facing action.
