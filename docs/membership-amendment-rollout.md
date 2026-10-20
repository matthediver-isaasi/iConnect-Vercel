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

### Connected settlement implementation

The upfront implementation now includes Xero adjustment invoices and online
collection links, retained credit notes, and credit notes awaiting a separately
recorded manual refund. Refund verification requires exact-reference,
bank-reconciled payment evidence consuming the credit; the application does not
transfer cash automatically. Original payer, invoice, payment, currency and tax
ownership are checked before settlement. Unsupported accounting providers and
ambiguous source evidence remain blocked.

Provider operations are durably reserved before submission. Uncertain outcomes
are reconciled by reads, not retried money calls. Application and notifications
have separate evidence. The additive settlement migration must precede
deployment of these actions; do not enable application without the operational
membership-reader integration and its regression checks.

The audited operational scope is personal twelve-month upfront rolling
membership, with both original and target structures using immediate-start
annual terms. Fixed-date, organisation and provider-linked scopes remain
blocked before settlement and application. Current displays, rolling renewal,
reminders and history consume applied entitlement while retaining original
purchase/invoice economics. This is a scope-specific release, not permission to
apply amendments to every membership.

Monthly Stripe/fixed-DD adapters exist but are not an enabled amendment
workflow. Immutable monthly authority, operation claims and collection holds
are still required. Dynamic DD additionally needs effective-dated pricing
revisions pinned atomically into collection reservations. Do not call these
adapters directly to bypass the missing orchestration.

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
