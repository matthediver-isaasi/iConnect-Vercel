# Variable monthly membership voucher funding

## Migration and release status

Applied to external **DEST** (`lvmzliemqnieeoruhkik`) on 2026-10-23:

- `202610230001_membership_variable_voucher.sql`
- SHA-256: `f2f87124f53d033b477310b4f40d2905aa210ba943e3c827fdfe4a7f3be06ecb`
- Runner: `scripts/apply-membership-variable-voucher.mjs`

The runner pins the destination SQL and REST identities, verifies TLS, requires
the reviewed SQL hash, checks the installed financial function hashes, and
checks table/RPC access before committing. Default execution is offline.
`--preflight` is read-only. An exact already-applied migration is a no-write replay.

No migration was applied to SOURCE. No existing membership, voucher balance,
provider payment or accounting invoice was changed during rollout. The migration
does not backfill existing agreements.

**Application deployment remains required after merge.** Do not replace this
migration file after application; use another additive, pinned migration for
subsequent database changes.

## Financial boundary

Variable quote gross and remaining cash totals are null, not fixed liabilities.
Credit is reserved across the accepted period and its source vouchers. Each
collection resolves its actual price and tax evidence before cash is submitted.
Unused credit returns to its original voucher without extending expiry.

Cash-backed slices consume credit only after matching canonical confirmed
provider evidence. Voucher-only slices settle internally when due, with no
GoCardless payment row or invented payment ID. An internal collection can settle
when the provider's next debit date falls beyond the period; the real mandate
observation remains unchanged.

Invoices retain actual gross value, separate voucher-clearing payments and actual
cash. Provider minimums reduce credit consumed, never increase the gross fee.
Refund capacity excludes amounts already returned as unused reservation credit.
Cancellation releases uncollected credit but retains uncertain payment
reservations for reconciliation. Renewals do not inherit the previous allocation.

## Verification

210 tests passed across allocation, quoting, fixed/variable monthly accounting,
voucher SQL, dynamic collections/completion, mounted MembershipFeePage,
manual-collection guards and payment-environment regression suites.

The new disposable PostgreSQL suite checks the exact pinned live definitions
of the modified completion and shared voucher transition/refund functions before
applying the migration. It exercises internal and mixed settlement, provider
minimums, no fictional payments, completion, refunds, failed-payment cancellation,
replay, renewal isolation, anonymous/authenticated denial and service-role write
restrictions.

Xero and QuickBooks accounting tests exercise both isolated orchestration adapters
and the real invoice adapters with mocked HTTP transports. The real adapter tests
verify an authorised unpaid invoice without a Stripe intent or automatic payment.
Additional tests cover new internal-only plan creation beyond the provider debit
window and variable-funded pending-consent retry without freezing gross pricing.
No real provider
debits, refunds, invoices or voucher redemptions were used for verification.

The local server starts, but the preview reports “Tenant not found”: this
workspace uses legacy SOURCE, whose schema lacks the tenant table. The signed-in
UI was therefore not visually verified. Mounted page behaviour was tested.
