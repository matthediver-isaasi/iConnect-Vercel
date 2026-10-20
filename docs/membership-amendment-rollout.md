# Mid-term membership amendments

## Approved outcome

Allow an authorised administrator to change the structure/tier of a current
membership. Preserve its expiry by default. Calculate a remaining-term
adjustment from immutable purchase evidence, not an editable override.
Positive differences require collection; negative differences support retained
credit or cash refund. Keep an explicit before/after history.

## Staged implementation boundary

The initial stage provides quotes and immutable pending change requests for
well-evidenced personal upfront memberships. It must not apply entitlement,
change a payment plan or claim settlement. Missing purchase evidence and
unsupported monthly agreements are explicit blockers. An administrator saving
a request is not confirming that money was collected or refunded.

## Remaining settlement stages

1. Add source-linked adjustment invoices and payment attempts. Confirm payment
   through provider reconciliation, not a browser success redirect.
2. Add credit-note orchestration for the original payer and invoice. A refund
   and a retained credit are different outcomes; never leave both available for
   the same adjustment. Limit refunds to the remaining refundable amount and
   support recorded manual refunds where provider automation is unavailable.
3. Add an effective-dated entitlement overlay shared by current membership,
   access, renewal and display readers. Apply only after the required settlement
   succeeds, or an explicitly authorised on-credit decision.
4. Amend fixed Stripe and GoCardless plans explicitly. Dynamic Direct Debit
   still needs a deliberate change to its purchased scope/pricing basis.
   Respect submitted collections, notice/consent and annual-instalment versus
   genuinely monthly obligations.
5. Add reconciliation of ambiguous outcomes and notifications. Repeated
   amendments must use the last applied commitment and cumulative adjustments,
   never repeatedly credit the original purchase.

## Release evidence

Before enabling settlement/application, demonstrate concurrent confirmation,
provider-success/local-failure recovery, no duplicate invoices or refunds,
VAT/rounding, partial refunds, outstanding debt, membership pauses and renewal
races with isolated fixtures. Controlled provider tests require explicit
test-mode verification. Never benchmark or test by mutating a real member.
