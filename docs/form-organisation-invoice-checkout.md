# Organisation-backed form invoice checkout

## Contract

Checkout automatically shows an optional PO-number input when invoice payment is
available. No separate form question or PO mapping is needed. The server trims
and validates the single-line value (maximum 255 characters), freezes it as the
invoice reference, and persists it with the accepted submission. A missing PO
becomes exactly `TBC`, never the form name. Existing mapped PO fields remain
supported; contradictory nonblank answers fail rather than silently losing one.
The submission's Checkout details show the frozen reference. A changed PO cannot
reuse the accepted order's idempotency key. Card and Direct Debit do not collect
this checkout input.

Invoice details now have two explicit sources:

- **Use organisation invoice details:** select only an Organisation Drop Down.
  Name and invoicing email come from the tenant-owned organisation record; the
  six address components come from its scoped private invoicing-address row.
  No separate name/email/address form questions are required for saving.
- **Map individual form fields:** map billing name/email and individual address
  line 1, line 2, city, region, postcode and country fields. Address line 1, city,
  postcode and country are required at checkout; line 2 and region are optional.

New configurations do not expose the retired combined-address selector or fall
back to legacy text. Existing configuration without an explicit source retains
its original contract until deliberately converted. Accepted historical
snapshots remain unchanged.

Billing details are frozen at acceptance. Xero preparation applies the explicitly
selected structured postal address to the verified contact and requires matching
provider readback before invoice issuance. It does not update the app organisation
record or Xero contact email. The canonical address components use the shared
Xero/QuickBooks mapping vocabulary; invoice checkout itself remains Xero-only.

The invoice payment setting accepts either a text billing-name field (existing
behaviour) or an Organisation Drop Down. Dropdown selection is tenant-validated
and checked against its saved eligibility and conditional filters. The canonical
organisation name comes from the server record, never editable form text.

Find exactly one active Xero contact after trimming, collapsing whitespace and
lowercasing both names. Exhaust paginated discovery before accepting uniqueness;
missing, duplicate, malformed or incomplete results fail before accepting the
order. Discovery is bounded by a deadline and page limit. The contact's email is
neither required to match the purchaser nor changed.

The immutable invoice-order snapshot contains the organisation ID, contact ID,
Xero company and connection. Preparation reads that exact contact in that
company, not another name search. Renames do not redirect accepted invoices;
missing or archived contacts stop preparation. Original line items, financial
terms and queue idempotency remain authoritative.

No schema migration is required for new orders: the existing server-owned JSON
snapshot and queue preparation handoff store this authority.

## Deployment and live form configuration

Deploy compatible checkout handlers and accounting workers together before
mapping a live payment field to an Organisation Drop Down.

The BNMS Spring Meeting Exhibitor Booking form still maps Checkout to its
pre-filled text field. This was deliberately not changed ahead of deployment.
After release, add a required Organisation Drop Down and map Checkout's Billing
name field to it. Preserve the old text field and historical answers rather than
changing their meaning in place. Verify existing answers, prefill behaviour,
conditional rules and any organisation pipeline mappings before publishing the
form change. Missing/ambiguous Xero matches must show an actionable error.

## Existing invoice recovery

The owner approved normalized unique organisation-name matching. The existing
BNMS request was recovered against the unique tenant organisation and unique
active Xero contact, without modifying its original snapshot, email or stock.
The verified contact was persisted in the queue's resolved snapshot.

Xero invoice INV-9800 was created for GBP 11,016, authorised and unpaid, reference
TBC. Readback confirmed the expected contact, amount and status. A separate
submission-linking failure was traced to an unserialized JSON compare-and-swap
filter; the filter is now serialized and the same request completed its linking
stage without another invoice or payment. No invoice email was sent by this
recovery.

## Verification

Isolated regression coverage includes normalized names, duplicates on later
pages, incomplete reads, absent/archived contacts, invalid organisation selection,
frozen-contact replay, original line totals, preserved purchaser email, and JSON
linkage. Provider fixture requests are separate from the scoped live recovery.
The local authenticated UI remains unverified because the workspace preview
has an existing tenant-resolution failure.
