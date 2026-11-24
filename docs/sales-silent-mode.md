# Per-opportunity Silent mode

## Inventory and boundaries

The inventory traces Sales email transports and their callers, not hypothetical notifications:

| Communication | Origin | Selection / recipients / trigger |
| --- | --- | --- |
| Signed agreement copies | `salesAgreement.js`, `finalizeAndNotifySalesAgreement` | `agreement_sender` and `agreement_customer`, independently selected; frozen signatories after both signatures and final PDF retention |
| Scheduled invoice email | `salesInvoiceSchedule.js`, `deliverSalesSchedule` | `invoice`; accepted billing recipient after verified provider invoice linkage |
| Delegate registration email | `salesCustomerFulfilment.js`, `deliverCustomerFulfilment` | `customer_fulfilment`; accepted customer after sale ticket allocations create fulfilment work |
| Quote delivery | `salesQuoteDelivery.js`, authenticated quotes `send` action | Explicit manual send; unchanged |
| Colleague signature request | `salesAgreementSigningRequests.js`, authenticated signing request action | Explicit manual request; unchanged |
| Individual delegate invitation | `api/sales/allocations/[...path].js`, invite action | Explicit manual invitation, including existing no-email option; unchanged |
| Signing verification code | `salesAgreement.js`, `agreementOtp` | Required security verification; unchanged |

Sales accounting invoice creation and payment operations do not themselves send customer emails through either mail transport. Provider credit-note mail helpers are not Sales automatic invoice sends.

Retrying an existing scheduled delivery or agreement finalization still handles the same automatic occurrence: retry is not a policy override or a new manual-send facility. Existing explicit quote, colleague and delegate sends retain their behavior.

## Semantics

`silent_mode` defaults to false and `automatic_communications` defaults to an empty list. The opportunity detail editor only exposes checkboxes while enabled. Off retains saved selections. Saving has no delivery side effect. Permitted messages must still meet existing recipient, eligibility, lease, retention and invoice evidence checks.

The shared category inventory is `shared/salesCommunicationPolicy.js`. The private opportunity detail PATCH uses existing Sales capability and opportunity edit authorization, then an atomic version-checked, audited database command. Browser or public bearer input never chooses the opportunity used by the delivery policy.

`check_sales_automatic_delivery` resolves the tenant-scoped opportunity from the claimed envelope→quote or schedule/fulfilment→sale. A proven standalone quote or sale has no policy and continues normally; missing linkage, stale leases and database errors are not permission to send. Policy locks serialize the decision against an edit. The final decision immediately precedes mail dispatch; a message already dispatched cannot be recalled. Invoice delivery also checks before provider PDF retrieval, then rechecks after preparation.

Suppression commits the original occurrence's `suppressed` status, `suppressed_at` and opportunity activity together. No sent timestamp, message ID or public-link activation is fabricated. The invoice remains invoiced, the agreement remains finalized, and sale/allocations/fulfilment records remain intact. Existing claims exclude suppressed occurrences; the agreement claim explicitly treats suppression as terminal. Neither toggling the policy nor retrying can replay them.

Policy lookup failures remain ordinary retryable failures (`failed`, `rejected`, or `pending` as appropriate), not deliberate suppression. Agreement completion writes are fenced by sending status as well as attempt number, so a lost suppression response cannot rewrite the committed suppression into a retryable failure.

## Installation and verification

Migration: `supabase/migrations/202701240001_opportunity_silent_mode.sql`.

This is a new, transactional, **non-idempotent** migration; do not replay it or the historical migration directory. It depends on the existing opportunity pipeline, agreements, scheduled billing and customer fulfilment schema. Install it through an owner-approved, destination-verified migration process before deploying the matching code. Do not enable schedulers, replay deliveries, or send customer messages as an installation test. No live migration, financial operation or customer send was performed for this implementation.

Run `npm run test:sales-silent-mode`. Tests use isolated provider stubs, rendered React controls and disposable socket-only PostgreSQL. Coverage includes all category combinations, default off, retained selections, authority/version conflicts, atomic policy audits, current policy after claim, missing linkage, terminal suppression, no false sent state, public DTO privacy, and unchanged manual delivery/OTP paths.

Authenticated live opportunity UI requires a valid signed-in tenant session; the anonymous app screenshot is not evidence of that UI. Mounted component tests verify the controls without weakening authentication.
