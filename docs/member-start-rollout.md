# Individual membership Start / Renew

## Member-selected payment method

The admin payment dropdown now also supports **Allow member to choose**.
Explicit selections retain their existing single-method behavior. Choice mode
offers only the selected structure/band's available self-service methods:
upfront Stripe, monthly Stripe and Direct Debit. Invoice and zero-value
membership remain explicit administrative options, not public checkout choices.

Each offered method has its own saved quote, including monthly collection and
activation policy. The member link first shows these offers, then asks the member
to confirm one before opening that method's existing provider setup/payment flow.
The selection is persisted before provider setup; it does not itself authorize
collection, prove settlement or activate membership. A different confirmed method
requires administrator review rather than creating competing payment arrangements.
The link is still shared manually using **Copy member authorization link**.

This extension requires
`supabase/migrations/202612310024_member_start_member_choice.sql` before use,
after the already-deployed `202612310022` and `202612310023` migrations.
Applied with owner approval on 2026-10-21 to verified live DEST
(`lvmzliemqnieeoruhkik`).
SHA256: `c7f3f4801b2b1fc4c50b748f8942e85e323bea8f9047faa732f2a0fba5ea6800`.
Verified capability version 2 with `memberChoice: true`, selection-table RLS,
service-only selection RPC access, and no browser table reads or direct
service-role inserts. The selection table is empty after migration. No live
memberships, provider objects or payments were changed; SOURCE was untouched.
No further migration is pending for this extension. Deploy the matching API and
client together; existing explicitly selected payment requests remain unchanged.

The service-only readiness RPC must return version 2 and `memberChoice: true`.
Until then, the new option is visibly unavailable; existing explicit modes remain
available under their original guards. The migration stores the original offers
immutably and binds a selected quote transactionally with token/history updates.
It rejects concurrent different-method selection and supports same-method retries.
It aborts rather than overriding unexpected changes to existing database guards.

## Provider-payment extension — database applied, application deployment required

The extension in `202612310023_member_start_payment_authority.sql` was applied
on 2026-10-21 to verified DEST (`lvmzliemqnieeoruhkik`).
SHA256: `d3658d753c83593d295f610f0d9bcc1629876a2c47bb3984a676115da1a5c0ad`.
The capability RPC, attachment RLS and service-only attachment permission were
verified. Earlier attempts rolled back atomically before the schema-parity fixes.
No live memberships, provider objects, payments, emails or integration settings
were changed. Workspace SOURCE was not changed. No further migration is pending
for this extension; deploy the matching API and client together.

Deploy this migration and the matching API/public fee UI together. The service
queries the service-only `member_start_payment_capabilities()` RPC: until its
version-1 authority is present, provider modes are explicitly unavailable.
Existing invoice/free creation remains available subject to its existing gates.
Read-only DEST inspection found no deployed DD manual-approval RPC at any
signature. The migration therefore includes the unchanged, reviewed
`20260902_atomic_manual_dd_activation.sql` function definition as a conditional
prerequisite, then applies the same guarded Start approval-marker extension.
It does not skip manual DD support, replace an existing approval implementation,
or require a provider-integration migration. Its canonical service-only signature
is `(uuid, uuid, text)`; unknown overload-only installations fail review checks.

### Admin API contract

`GET /api/membership/member-start?memberId=<uuid>` returns:

- `structures[].paymentOptions`: `{ mode, available, reason }` entries;
  `paymentModes` contains only available mode strings. Each band has the same
  fields; its amount is authoritative and never falls back to a flat price.
  Structure-level options aggregate band availability, not a promise that every
  band supports every mode.
- Modes: `stripe_upfront`, `stripe_monthly`, `direct_debit`, `invoice`, `free`.
  Structure flags (`online_card_payment`, `card_monthly_enabled`, `dd_enabled`),
  selected-band monthly prices, credentials and accounting availability are
  server-validated. Unsupported pricing/incentive policy is explained, never
  approximated.
- `requests[]` has `paymentMode`, `paymentUrl`, `status`, `payment_status` and
  immutable quote evidence. Create/resume returns these on `result.request`,
  plus a top-level `paymentUrl`.
- Provider links use the existing canonical `/membership-fees/<token>` route.
  They are created atomically with the purchase, survive admin reload, and are
  returned again by list/resume. Admin confirmation does **not** start a
  provider payment, Checkout, mandate or subscription. The member authorizes it.
- Statuses include `awaiting_member_authorization`, `pending_payment`,
  `completed`, and the existing invoice/accounting/reconciliation statuses.
  A monthly partial payment or mandate is not labelled fully paid.
  Expired/cancelled unpaid links return `reconciliation_required` and
  `paymentLinkExpired` rather than silently minting replacement payment authority.

Preview/create retain the existing explicit `configId`, `bandId`, `startDate`,
`reason`, `paymentMode`, `expectedQuote` and stable `idempotencyKey` contract.
For monthly rails, `quote.paymentOffer` contains `monthlyAmount`,
`monthlyAmountMinor`, `instalmentCount`, `planTotal`, `currency`,
`activationRule`, timing and saved collection-policy terms. Activation rules
retain the existing configured `mandate`, `first_payment`, or `manual` semantics
(including card's established checkout-complete equivalent of mandate).
Preview rejects known schedules outside the saved term.

Dynamic Direct Debit is supported: `collectionPolicy.pricing_policy=dynamic`,
`planTotal=null`, and the term's `finalCost`, `vatAmount`, `totalWithVat` are
unknown (`null`), not zero or a fabricated fixed total. Immutable
`initialQuotedAmounts`, selected band/config, initial monthly price and explicit
policy remain evidence. Existing mandate-only, per-instalment dynamic collection,
notice-window, pricing reservation and completion machinery owns later amounts.
No dynamic term is rematched on opening its fee link; later collection repricing
is only the separately consented existing dynamic policy.

### Existing public fee API and processing

Public GET includes `memberStart: { requestId, recordId, paymentMode, termStart,
termEnd }` (null for ordinary links). It exposes only the selected rail's existing
`stripeEnabled`, `cardMonthlyEnabled/cardMonthly`, or `ddEnabled/ddOffer` controls.
Monthly offer fields include `activationRule`; competing rails and PO are disabled.
Every public POST enforces the chosen rail even if a caller bypasses the UI.

Version-1 Start envelopes contain version-2 purchase quotes. Dedicated checked
reconstruction works for rolling **and fixed-date** purchases across GET,
provider start, confirmation and Stripe recovery; invalid/unknown snapshots
fail closed, never fall back to live matching. Missing Start history requires
reconciliation, not creation of another financial purchase.

Upfront browser confirmation and webhook/reconciliation use the same existing
recorder and durable invoice journal. Saved invoice identity, purchaser details,
address and nominal code are reused even if live data changes. Monthly payment,
activation, invoicing, reconciliation and completion remain in the existing
Stripe/GoCardless processors. Start card Checkout uses the existing finite
Subscription Schedule processor, not unsupported Checkout `cancel_at`.

### Database review boundaries

The migration preserves the existing member row lock, immutable Start ledger,
purchase economics, ordinary creator fences and rolling-commitment guards.
Its separate service-only attachment authority owns exactly one token, one
agreement and one plan. Only null-to-that-owned-agreement history linkage is
allowed; invoice/free linkage remains immutable. All owner changes (including
null and cross-tenant reparenting), alternate attachments, altered consent/price
and deletion of attached evidence are rejected even after settlement/term end.
Unrelated or overlapping purchases do not gain an exemption.

The fixed-date completeness extension is limited to the explicit versioned
Start monthly-card commitment. Fixed upfront histories retain their established
non-rolling representation and saved date authority. Manual activation remains
the existing checked/audited finance RPC, with its approval marker and activation
in the same transaction. No existing activation rule is bypassed.

### Isolated extension verification

No live provider or remote database is used by these tests:

```sh
node scripts/run-isolated-tests.mjs node --test api/_lib/memberStartQuote.test.mjs api/_lib/memberStartPayment.test.mjs api/membership/member-start.test.mjs api/public/membership-fees/memberStart.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/memberStart.postgres.test.mjs
node scripts/run-isolated-tests.mjs node --test api/_lib/rollingFeeCommitment.test.mjs api/_lib/membershipPaymentReconciliation.rolling.test.mjs api/_lib/stripeMonthlyCard.test.mjs api/_lib/gocardlessDirectDebit.test.mjs api/_lib/gocardlessDynamicCollections.test.mjs api/_lib/gocardlessDynamicCompletion.test.mjs
node scripts/run-isolated-tests.mjs node --test api/public/membership-fees/renewalQuote.test.mjs api/_lib/gocardlessCollectionPolicy.test.mjs api/_lib/membershipReminders.paymentLinks.test.mjs
```

Tests invoke the real public handler with controlled provider doubles, real
upfront confirmation/accounting, real Stripe invoice callback/replay and real
GoCardless mandate callback/replay. Disposable PostgreSQL exercises the reviewed
new migration together with the real existing rolling guard, invoice/free and
eight rolling/fixed provider-policy cases, plus truly ended/paid attachment
mutation/deletion and service-role authorization checks. Existing adjacent rail
and dynamic-processing suites remain part of the regression check.
Reviewed extension results: 33 focused tests, two disposable-PostgreSQL integration
variants (many SQL assertions, with DD approval initially absent/present),
191 adjacent rail/dynamic tests, and 46 additional
renewal/consent/reminder regressions pass. No blocked-network attempts occurred.

## Deployment

`supabase/migrations/202612310022_member_membership_start.sql` was applied on
2026-10-21 to verified DEST (`lvmzliemqnieeoruhkik`).
SHA256: `9d2cdc7a8701beb6a7a7921491a8e281bd87b6ef761ad859a2d68bfc7fd92870`.
RLS and service-only creation permission were verified. SOURCE was not changed.
No memberships, invoices, emails or provider payments were created by deployment.

Deploy the matching API/UI together. For invoiced purchases, the deployed
environment must have:

- `ACCOUNTING_REQUEST_QUEUE_ENABLED=true`
- `ACCOUNTING_REQUEST_QUEUE_SOURCES` containing `member_membership_history`
  (preserve any other enabled sources).
- The existing accounting-request queue migrations, connected Xero/QuickBooks
  account and scheduled accounting/invoice-payment reconciliation workers.

The prerequisite queue table exists in DEST. Production environment flags were
not changed or verified during this implementation. Do not enable a broader
legacy accounting rollout without reviewing its own rollout requirements.
The UI explicitly disables invoicing when its queue flag is unavailable.

## Supported scope

Tenant administrators with membership finance permission can select an annual
individual structure, tier (where relevant), today/future commencement and reason.
The preview freezes the selected term, price and tax evidence.

- Invoice: saves an unpaid purchase and submits the existing durable accounting
  queue. Payment reconciliation activates/schedules the purchased term.
- Free: permitted only for an authoritative zero total.
- Recovery: saved requests remain discoverable after reload; resume uses the
  saved authority, not a newly calculated quote.

The original invoice/free deployment did not collect card or Direct Debit consent.
The reviewed extension above adds new purchase-owned links on the existing public
fee page; it never adopts an unrelated old recalculating fee link.
Current memberships belong in the existing amendment/renewal flows. Unresolved
history, existing payment obligations, overrides and unsupported complex pricing
show blockers rather than inventing dates, payments or approximate prices.
Imported member class/status/expiry fields are not rewritten.

## Verification

55 feature, UI and adjacent reconciliation tests passed across two runs.
PostgreSQL tests use a disposable local database with
`node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/memberStart.postgres.test.mjs`.
Other focused tests:

```
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/memberStartQuote.test.mjs \
  api/membership/member-start.test.mjs \
  api/_lib/membershipPaymentReconciliation.rolling.test.mjs \
  client/src/components/MemberMembershipStart.mounted.test.mjs
```

The app starts. The preview's existing default-tenant lookup returns Tenant not
found; the signed-in production screen and live provider invoice delivery were
not exercised.
