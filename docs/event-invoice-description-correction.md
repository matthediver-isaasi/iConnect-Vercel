# Event invoice description correction

Future Xero event invoices use a normal `Booking reference:` line instead of an
internal `[Event invoice recovery: …]` hash. Invoice numbering and the purchaser's
PO Reference remain unchanged. Existing hash-labelled invoices remain readable
by recovery, including when a provider response or local invoice-ID write was
lost. Known provider invoice/payment IDs continue to take priority over searches.
Incomplete searches, multiple candidates, financial/purchaser mismatches and
ambiguous writes continue to stop further creation.

## Authorised live correction

On 2026-10-26, the owner authorised replacing the technical label on BNMS invoice
INV-9382. The destination-pinned repair script updated the existing Xero invoice
in place, replacing only the exact first-description suffix with its ordinary
booking reference. It did not recreate the invoice or send an email.

Provider reads before and after the update verified the invoice number, contact,
line IDs, tax, amounts, payments, status and all other fields were unchanged
(apart from the provider update timestamp and authorised description). Xero
showed £200 total, £0 paid and £200 due. A provider history note records the
description correction. No booking or recovery rows were changed; routine OAuth
authentication uses the application's existing helper.

No database migration was needed or applied. The live invoice correction is
already applied; future-generation code requires merging into the main app and
the normal release process. No deployment was performed here.

## Verification

```
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/eventInvoiceRecovery.test.mjs \
  api/_lib/eventInvoiceRecoveryXero.legacy.test.mjs \
  api/_lib/eventInvoiceFutureTax.test.mjs \
  scripts/repair-bnms-invoice-9382.test.mjs
```

66 tests passed. Coverage includes lost responses and local journal writes,
old markers, altered PO/invoice numbers, multiple candidates, changed finances
or purchaser, and the description-only repair invariants. Tests are isolated
fixtures; live correction verification used separate reads of the exact invoice.

The repair script is pinned to one approved invoice and defaults to capture.
Its private evidence files live outside the repository in `/tmp`; it refuses
to overwrite them. Do not rerun an apply after an uncertain response: inspect
the retained audit and read the exact provider invoice first. It cannot create
invoices, make payments or change contacts.
