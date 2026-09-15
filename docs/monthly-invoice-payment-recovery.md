# Monthly invoice payment identity recovery

## Verified incident

Read-only verification on 2026-09-15 of the member supplied with the report
confirmed a destination-database monthly Stripe agreement in `per_instalment`
mode, £5.08 per month for 12 months. One collection was counted. Its instalment
accounting ledger was `failed`, with no accounting invoice linkage, and error
`stripePaymentIntentId must be a full PaymentIntent identifier`.

Tenant-scoped Stripe **test-mode** GET requests confirmed the stored invoice
was paid for 508 GBP minor units, with one succeeded PaymentIntent for the same
amount/currency/customer and the subscription matching the local plan.
The configured accounting provider was Xero. No accounting-provider mutation,
replacement charge, subscription change, or database repair was performed.
Restricted identifiers and detailed evidence are in the task's local read-only
verification record; they are intentionally not duplicated here.

The connected Vercel deployment was ready, but its deployed server source
could not be inspected. This fix is not verified deployed.

## Approval-gated recovery

1. Verify the corrected server release is deployed. Obtain explicit finance
   approval for the single reported accounting replay, even though the Stripe
   evidence is test-mode: the accounting connection can still be real.
2. Re-read the exact tenant/agreement/plan/ledger. Stop if identity, amount,
   status, mode, or linkage differs from the inspected record.
3. Use the tenant-scoped Stripe connection to re-read the invoice and its
   PaymentIntent. Require a paid invoice and one succeeded PaymentIntent with
   matching customer, subscription, amount, and currency. Incomplete or
   ambiguous evidence must remain a visible recoverable failure.
4. Use the shared instalment poster for that exact existing collection, not
   the broad cron or generic annual-invoice retry. Preserve the original
   invoice-based ledger identity and `mii-stripe-<invoice-id>` / `-pay` keys.
   Keep the immutable Checkout address snapshot.
5. If accounting linkage already exists, do not create an invoice: retry only
   payment application. Re-read accounting evidence before approving any
   ambiguous historic provider-side result.
6. Re-read the ledger and provider result after the approved replay. Only
   confirmed invoice-plus-payment may become `posted`. A linked invoice with
   no confirmed payment stays `invoice_unpaid`; other failures stay visible.
   Verify the invoice action in membership history after recovery.

No Stripe charge or subscription creation is part of this procedure.

## Historical QuickBooks keys

QuickBooks operation identifiers longer than 50 characters cannot safely be
truncated: historical arrears keys can collide across periods and operations.
They now fail closed before provider writes. Do not replace their historical
identities with newly hashed keys and blindly replay. Finance-led inspection
of existing QuickBooks invoices/payments is required before a separately
approved repair. Ordinary supported-length keys remain unchanged.

## Verification

The targeted monthly invoicing, Stripe event, arrears, provider settlement,
admin retry and reconciliation suites passed 179 tests. The app server starts.
Local visual verification remains blocked by the workspace tenant lookup
(`Tenant not found`); it is not evidence of a successful member-history view
on the deployed tenant.