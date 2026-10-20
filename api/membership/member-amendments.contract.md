# Member amendment API — settlement extension (migration required)

## Settlement extension / integration contract

Existing preview/create remains compatible: proposals use settlementChoice defer.
New POST actions use `{action,amendmentId}` (UUID), never a client-supplied amount,
payer, invoice ID or settlement claim:

- `settle`: also `settlementChoice:"collect"|"credit"|"refund"`. Choice is locked
  on first reservation and cannot subsequently switch from retained credit to
  refund. Unsupported providers/evidence return explicit 422 blockers.
- `reconcile`: provider reads only after an uncertain mutation; never blindly
  repeats a money mutation. Returns current lifecycle.
- `apply`: only verified settlement (or exact zero delta), current unchanged
  purchase, unexpired original term, no overlapping successor or pause.
- `notify`: retries durable pending delivery; ambiguous delivery remains visible.

GET adds `lifecycle` keyed by amendment ID and runtime `capabilities`. Existing
proposal status/settlement_status/entitlement_applied remain immutable historical
facts; **use lifecycle**, not those old fields, to show current state. Lifecycle
states: reserved, awaiting_payment, uncertain, settled, applied, conflict.
Financial direction tax_adjustment and mixed-sign net/VAT deltas block settlement.
Initial connected provider implementation is Xero; unsupported domains fail closed.
**Release operational scope:** quote/preview, settlement (including historical
proposals) and application require assessMemberAmendmentOperationalScope from
membershipAmendmentReadOverlay.js. Only evidenced personal twelve-month annual
upfront rolling immediate-start → immediate-start changes are enabled. Original
rolling term key/anchor, annual cadence and tenant/member ownership must be
explicit. Fixed-date source/target, cadence changes and other reader-unsupported
scopes fail with operational_scope_unsupported BEFORE provider preparation,
money calls or lifecycle writes. SQL settlement reservation/application RPCs
independently enforce equivalent source AND target scope checks.
`none` is the fourth settlement choice, for exact zero net/VAT/gross only.
`refund` creates an exact credit note and waits for a **recorded manual** cash
refund, not a bank transfer or automated Stripe refund. Finance must record
credit-note Payments in Xero using reference `MA:<amendmentId>:refund`,
exact amount, AUTHORISED status, IsReconciled=true, and no invoice allocations.
RemainingCredit must be zero before settlement/application. Choosing retained
credit permanently excludes refund for that proposal.

Capabilities currently returned:
`preview,create,apply,invoice,refund,retainedCredit,reconcile,notifications:true`;
`providerAmendment,automatedCashRefund,repeatedAmendments:false`.
`refundMode:"xero_bank_reconciled_manual_refund_only"`,
`collectionMode:"xero_invoice_verified_payment"`.
These advertise connected implementation, not per-record eligibility. Settlement
preflight independently checks provider, payer, original paid invoice and payments,
credit coverage, tax regime, source/purchase linkage and card refund capacity.
For Stripe-funded amendments the original saved payment intent and its charge
must be readable, fully paid and without any prior refund or dispute.
Existing/unattributed payer credit notes, mixed revenue/tax, provider switches,
partial source refunds, tax-regime changes, organisation and monthly purchases
are explicit blockers. No amount is silently capped or approximated.

### Shared reader overlay

Compatibility export in api/_lib/memberAmendmentSettlement.js (delegates to the
dependency-light resolveMemberAmendmentReadOverlay, no financial rewrite):
`resolveMemberAmendmentOverlay({db,tenantId,history,asOf})`, async, returns
`{...history, effective_membership_amendment, effective_config_id,
effective_band_id, effective_commitment_snapshot}`. Original config_id, band_id,
commitment_snapshot, purchased economics and dates remain untouched, including
amounts inside effective_commitment_snapshot. Consumers must explicitly use
effective_* for entitlement/display/renewal scope. Pre-rollout missing overlay
table returns the original purchase; other read/evidence failures throw. The
renewal option carries the final effective scope after expiry without granting
expired access. SQL table member_membership_amendment_application is service-only.

### Monthly worker seam

Monthly worker owns memberAmendmentMonthly* and adapters. Its actual factory
exposes `quote(input),prepare(input),apply(prepared),reconcile(prepared)` as
documented in member-amendments-monthly.contract.md. These adapters are NOT
dispatched by this endpoint: no immutable monthly financial authority or shared
collection/cancellation hold exists yet in the core. ProviderAmendment remains
false and upfront settlement rejects provider-linked purchases. Do not connect
adapter writes before all documented cross-path locks and revisions exist.

### Durable recovery

New file-based cron handler api/cron/member-amendments.js uses fail-closed
CRON_SECRET, bounded due-row reconciliation and notification attempts. It is
scheduled every ten minutes in vercel.json; normal local file routing discovers
it. It does not make new money mutations or apply entitlement without an
administrator's separate apply action. Missing/ambiguous provider documents
stay uncertain and NEVER trigger resubmission. Interrupted notification sends
become uncertain after 15 minutes; only definitely not-submitted/pending delivery
is retried automatically. Notification kinds are settlement, settled and applied.
No migration or provider mutations should be run as implementation verification.

Apply re-verifies live settlement before its transactional purchase/paused/
successor/expiry checks. A late payment after a pause, renewal, overlapping
purchase or source edit is persisted as conflict; recorded financial evidence
is retained and no entitlement is granted. Late unchanged current terms may
apply with the original quoted effective date and original renewal boundary.
Repeat proposals for a source purchase stay blocked, including after application,
until cumulative revision pricing is implemented (never re-credit original basis).

Required additive migration:
supabase/migrations/202612310021_member_amendment_settlement.sql after 020.
Service-only RPCs reserve, finish and apply under member/source locks; original
proposals and purchase history remain immutable. No migration has been applied
as part of implementation.

---

## Historical proposal contract (unchanged)

`/api/membership/member-amendments` requires authenticated tenant admin access and
`commerce.monthly-finance-report` visibility for role-bearing accounts. Tenant
account admins without a member role use the existing finance-admin convention.
All reads and writes are scoped to the authenticated tenant. Never send tenantId.

## GET

`?memberId=<uuid>` returns:

- `current`: original full personal purchase record, or null. Never an override.
- `structures`: active, date-effective personal config records, each with `bands`.
  These are selectable candidates, not a promise of quote eligibility: preview
  performs strict policy validation (annual only, no conditional pricing).
- `history`: immutable amendment rows, newest first.
- `currentTermHistory`: history filtered by current original purchase ID.
- `capabilities`: `{preview:true,create:true,apply:false,invoice:false,refund:false,providerAmendment:false}`.
- `blockers`: current-source eligibility problems, or `[]`.

## POST

Body: `{action:"preview"|"create",memberId,configId,bandId:null|uuid,
effectiveDate:"YYYY-MM-DD",reason,settlementChoice:"defer",idempotencyKey,expectedQuote}`.
Reason is required, 1–2000 characters. Only today (UTC) is supported. A flat
target requires null bandId; a tiered target requires a band. Create requires a
new stable 8–128 character idempotency key (`A-Za-z0-9_.:-`). Retry exactly the
same request/key after network errors. Changing payload with the same key is 409.

Preview: `{quote:null|Quote,expectedQuote?:string,canCreate:boolean,blockers:string[]}`. A valid quote
has `canCreate:true` even though its application/settlement blockers remain.
Creating means tracking a proposal, **not changing membership or taking money**.
Pass the successful preview's `expectedQuote` unchanged on create. It is a SHA-256
fingerprint of the complete canonically ordered quote excluding only `quotedAt`.
Create recalculates authoritatively and returns 409 `quote_changed` if the source,
target, tax setting, dates or amounts differ; show a fresh preview and require
confirmation again. Missing fingerprint is 400 `expected_quote_required`.
Exact idempotent replays use the original request/fingerprint even if live data
later changes; do not replace expectedQuote when retrying the same key.

Create: HTTP 201 `{amendment:Row,replayed:false}`, or 200 with `replayed:true`.
Row fields: `id,tenant_id,member_id,source_record_id,actor_id,idempotency_key,
request,quote,status,settlement_status:"not_started",entitlement_applied:false,
created_at`. One open immutable proposal per original purchase is allowed;
replacement/cancellation is not yet implemented, and a second new key returns 409.
Stored `request` includes `expectedQuote`. All collection reads use explicit
500-row pages in stable ID order, never relying on PostgREST's default row cap.

Quote fields:

- `version:1,quotedAt,effectiveDate,currency,minorUnit:2,sourceRecordId`
- `sourceAuthority:"original_purchase_commitment_snapshot"`
- `targetAuthority:"current_explicit_structure_and_band_configuration"`
- `term:{startDate,endDate,renewalDate,anchorDate,durationMonths,termKey}`:
  all original dates preserved, including original anniversary.
- `proration:{method:"actual_utc_days_remaining_over_original_term",totalDays,
  remainingDays,rounding:"nearest_minor_unit_per_net_and_vat_component"}`
- `originalFullTerm,originalRemaining,targetRemaining,delta` each contain
  `{netMinor,vatMinor,grossMinor}`. All are integer minor units; delta is signed.
- `targetFullTerm` also contains `vatRatePercent,taxAuthority`.
- `financialDirection:"none"|"charge"|"credit"|"tax_adjustment"`
- `status:"pending_application"|"pending_settlement"`,
  `settlementStatus:"not_started",entitlementApplied:false,blockers:string[]`.
- `sourceSnapshot`: full immutable source history record; `targetSnapshot`:
  `{config,band,discounts:[],vatOverrides:[],vatSetting:null|savedSettingRecord}`.

Only complete consistent paid annual upfront personal commitment snapshots with
explicit scope/tenant ownership and undiscounted full-term pricing are supported.
Currency must be a recognized ISO currency with two decimal minor units.
Target uses its selected annual flat/band net price, not the member's current
override. Conditional discounts/VAT, free-period and rollover rules block quotes.
Null/empty target tax configuration means explicitly no tax, matching existing
configuration semantics; nonempty tax requires a unique saved tenant taxType
effectiveRate. No provider fetch or tax-label inference. Source remaining net/VAT
use original paid amounts; target remaining net/VAT use target full-term amounts.
Each component is prorated and rounded independently; delta is the difference.

Errors: 400 invalid input/action/settlement choice; 401 unauthenticated; 403
admin/finance gate; 404 tenant-scoped member absent; 409 idempotency conflict,
duplicate open request or source/target changed or became ineligible during
confirmation; 503 migration unavailable. Preview eligibility problems return 200 with
`canCreate:false` and explicit blockers. No apply/settle action exists.

## Safe migration/application

Review and apply `supabase/migrations/202612310020_member_membership_amendments.sql`
through the normal approved migration process **before enabling this UI**.
Prerequisites: existing tenant/member/personal history, config/band, discount/VAT
override and system_settings tables; rolling commitments migration
`20260920_rolling_membership_commitments.sql`; Supabase roles anon/authenticated/
service_role. Migration is additive and repeatable; it backfills nothing and
changes no existing purchase or provider data. RPC execution and table reads are
service-role only; direct row writes and client-role access are revoked.

Confirmation locks the tenant/member and original purchase, checks exact source,
target/band and saved-tax snapshots, serializes retries, and stores only a
proposal. Existing current membership readers are untouched. Even zero-difference
proposals are not applied. Positive/negative delta settlement, credit-versus-refund
choice, monthly provider changes, entitlement overlays, lifecycle events and
proposal withdrawal/replacement are deferred. Future implementation must append
settlement/application evidence rather than mutate the proposal or original
purchase. There is no safe manual "mark settled/apply" instruction in this slice.
