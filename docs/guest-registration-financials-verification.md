# Guest registration financials verification

## Read-only production evidence — 2026-09-25

The reads used the configured DEST Supabase REST connection, with a hostname
assertion against `lvmzliemqnieeoruhkik.supabase.co`. No database writes,
provider requests, charges, invoices, refunds or migrations were performed.
SOURCE was not queried or changed.

Tenant- and event-scoped exact first/last-name searches identified one matching
row in `booking` and no matching row in `complex_event_booking`. The similarly
named follow-on event was excluded. Personal names, tenant/event/booking IDs,
references and contact details are deliberately excluded from this repository
document; the authorized task conversation contains the investigation context.

| Stored field | Value |
| --- | --- |
| Status | confirmed |
| member_id | null |
| is_guest_booking | true |
| payment_method | admin_import |
| booking_reference | IMP-prefixed import reference (redacted) |
| booking_group_reference | IMPG-prefixed import batch reference (redacted) |
| ticket_price / total_cost | 0 / 0 |
| discount_code_amount / voucher_amount / training_fund_amount / account_amount | 0 / 0 / 0 / 0 |
| discount_code_id | null |
| stripe_payment_intent_id | null |
| xero_invoice_id / xero_invoice_number | null / null |
| purchase_order_number / purchaser_context | null / null |
| po_to_follow | false |
| created_at | null |

A separate tenant/event/group-scoped read returned only this booking.
The import handler explicitly writes `admin_import`, zero ticket price, and
IMP/IMPG references. The observed record matches that provenance. Its zero
amounts are import placeholders, not evidence of a free checkout, a discount,
or settlement. There is no linked Stripe/invoice identifier to inspect.
Absence of those links does not prove that no external payment ever happened.
The actual historical purchase value and payment history remain unknown.
No repair is justified from this evidence alone.

## Reporting correction

Previously the badge called any unrecognized method “Free” when the projected
total was zero. The corrected report labels explicit methods, including
Imported, without inferring a method from an amount. Import placeholder prices
and unsupported derived totals are unavailable in rows, CSV and affected
aggregate totals. Genuine recorded free bookings retain zero values.
Independent stored financial evidence remains distinct from settlement.
No current catalogue price or membership has been used to reconstruct history.

## Verification boundary

The production records above were actually read. Unit/API and browser
regressions use isolated fixtures; they are not authenticated production
report verification. No authenticated deployed tenant session is available in
this workspace. The supplied screenshot description is consistent with the
old badge code and stored row. The supplied screenshot was inspected and shows
the attendee as Guest, confirmed, Free, with £0.00 ticket/total/price paid. The
deployed report payload was not independently captured here.

The development host has no matching tenant and cannot establish a live tenant
report result. Normal deployment and an authenticated GFI report/CSV check
remain required to prove rollout. No deployment was performed by this task.

Targeted isolated unit/API tests passed: 39/39. The mocked report browser suite
passed: 14/14, including CSV and imported/free/paid/unknown/Invoice-PO cases.
Fixture screenshots are in `screenshots/task4789-mocked-registration-report.png`
and `screenshots/task4789-mocked-payment-badges.png`. A broader client test
run also found five existing unrelated failing suites; it is not a clean
project-wide test result.

## Migration status

No schema migration is required, applied to DEST or SOURCE, or outstanding for
this correction. No historical records were changed.

## In-app usage versus historical payment

Voucher, training-fund and account amounts report recorded in-app allocations,
not independently verified external payment history. Stored zeros in those
fields remain zero for the inspected import; they do not establish a free
purchase. Ticket price, discount, net value and price paid remain unavailable
where the import supplies no historical checkout evidence.