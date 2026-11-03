# Stripe payout reconciliation: evidence and verification boundaries

This is a read-only report at `/StripePayoutReport`. Permission:
`commerce.stripe-payout-report`, under Commerce. The API also requires an
authenticated tenant finance administrator; tenant-dashboard administrators
retain the application's existing full-administrator convention.

## Exact-link coverage

| Source | Payment identity | Invoice evidence |
| --- | --- | --- |
| Standard and complex event bookings | Full `stripe_payment_intent_id` | Provider-specific accounting invoice fields, or explicit legacy Xero fields |
| Member and organisation membership history | Full `stripe_payment_intent_id` | Same provider-aware invoice fields |
| Training-fund purchases | Full `stripe_payment_intent_id` | Same provider-aware invoice fields |
| Form submissions | Stripe `payment_reference` | Membership progress history table + history ID, only where the same full payment ID also appears on that tenant-owned history row |
| Card instalment invoices | Stripe invoice `external_payment_id`, with provider Stripe | Stored accounting invoice identity; requires that exact invoice identity on the retrieved charge |

Generic form products without a supported invoice link remain visible as
missing/unmatched. Annual recurring collections and newer Stripe representations
without an invoice ID on the charge remain unmatched unless direct supported
payment evidence is stored. No subscription-only inference is made. Refunds
resolve their original charge; linked invoices are explicitly original invoices,
not proof of credit notes. Platform subscriptions and other unsupported products
are not inferred from names, amounts, emails, metadata or descriptions.

Provider-aware fields take precedence. Conflicting legacy/generic identities or
invoice numbers are flagged and links withheld. Other providers are identified
as such, never labelled Xero. Xero URLs are staff invoice links requiring the
staff member's own Xero access. The report reads exact Xero sales invoices to
display their `Contact.Name`, never a member/organisation name or ledger account.
Each signed, tenant-scoped evidence page deduplicates valid invoice UUIDs and
reads at most 20 invoices, two at a time, with two-second HTTP timeouts and a
seven-second enrichment budget. Normal credential refresh is permitted; no
accounting records are written. Names are ephemeral and kept beside their own
invoice in the screen and CSV, including original invoices for refunds.
Missing connections, invalid/conflicting evidence and failed lookups display
unavailable names without changing matching, financial totals or completeness.
Conflicts discovered across later evidence pages suppress names at reconciliation.

## Retrieval and financial boundaries

Stripe credentials are loaded from the session tenant's existing integration,
using explicit Live/Test selection, never per-feature payment modes. No Connect
account override is accepted. Payout ownership is established by retrieving
the payout using those credentials; returned live/test mode must agree.

Each request reads at most 50 payout summaries or 10 balance transactions.
Refund charge enrichment runs in groups of two, with 2.5-second provider
timeouts and no implicit retries. The serverless endpoint has a 30-second
budget. Each linkage request reads one tenant-scoped, exact-ID source page,
with an eight-second database timeout. Pagination continues through an empty
page so a lower PostgREST cap does not silently truncate results.

Linkage requests require a short-lived HMAC page capability bound to the
tenant, selected mode and current credential. Only payment IDs returned from
that payout page may be queried. Credentials never leave the server.
All requests re-check authorization. Tokens are not authentication substitutes.

The browser follows provider and database cursors; all data is ephemeral, not
persisted in local storage or the database. Errors discard the candidate
report and disable export; Retry restarts retrieval. No partial report is
labelled complete. A payout that changes between pages must be reloaded.
Manual/instant payouts and Stripe reconciliation still in progress cannot
produce a complete export.

One balance transaction is one financial row. Group bookings and multiple
invoices never duplicate totals. All gross/fee/net arithmetic uses safe integer
minor units, with separate currency totals. Variance is transaction net minus
payout amount. Balanced totals do not establish invoice matching or bank receipt.
CSV uses the same completed projection, includes minor-unit totals and mode,
and quotes/escapes all cells with formula protection.

## Verification

- `node scripts/run-isolated-tests.mjs node --test api/_lib/stripePayoutReport.test.mjs api/_lib/stripePayoutInvoiceLookup.test.mjs api/_lib/stripePayoutContacts.test.mjs`
- `npx playwright test --config tests/stripe-payout-report.config.mjs`
- `npx vite build`

Browser tests intercept all API and external traffic using synthetic examples.
They exercise the actual page, invoice links, CSV download, unsupported payout,
mode switching, contact-name CSV parity, multiple invoices, unavailable names,
non-Xero invoices, conflicts, narrow screens and failed retrieval. Their screenshot is not a live BNMS
account screenshot. No customer financial exports are committed.

BNMS production matching completeness has **not** been sampled or guaranteed.
Historical availability depends on the selected Stripe account's retained
history and stored full payment links. No database migration, backfill,
metadata repair, payment action, invoice update or ledger posting is included.
Source merge and production release remain separate.

## BNMS user guide

Generate the safe example screenshot with the browser test, then run
`python scripts/generate-stripe-payout-guide.py` (PyMuPDF required).
The downloadable PDF and rendered inspection pages are written under ignored
`generated-artifacts/stripe-payout/`. The guide deliberately contains no real
customer or payment data.
