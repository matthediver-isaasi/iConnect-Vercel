# Member amendment first-slice API

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
