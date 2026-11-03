---
name: Individual training fund terminology
description: Owner terminology for the member-owned voucher work.
---
When the owner refers to the new “individual member training funds,” they mean the individual-member voucher work, not the older organisation training-fund balance.

**Why:** The owner corrected an answer that searched only the older training-fund screens and incorrectly said the individual functionality was missing.

**How to apply:** Trace member-owned vouchers and their configurable display names when answering questions about individual funds. Verify current routes and capabilities before answering.

Member vouchers are valid for all types of membership renewal.

**Why:** The owner explicitly clarified this when variable-price monthly Direct Debit rejected a member voucher.

**How to apply:** Do not exclude renewal payment types merely because the existing implementation only supports fixed totals. Preserve the payment arrangement and implement the required credit accounting rather than converting a variable agreement to fixed pricing.

For variable monthly membership payments, spread voucher credit across the membership period.

**Why:** The owner selected this instead of reducing the next payments until the credit is used up.

**How to apply:** Distribute credit across the actual membership-period instalments, preserving variable gross prices and exact penny totals. Do not front-load the credit or silently turn the arrangement into a fixed-price plan.

Unused reserved credit is not a refund of consumed credit and must not acquire a new expiry automatically.

**Why:** Variable prices can fall below an instalment's reserved share. Restoring that unused portion must not make it refundable a second time or extend the owner's original entitlement.

**How to apply:** Keep the original reservation evidence, distinguish consumption from unused release, and include prior reservation releases when calculating remaining refundable credit.

Form renewals and emailed payment links must share payment ownership, not just voucher balances.

**Why:** Separate checkout routes can otherwise create a card/DD purchase and a credit purchase for the same renewal. Voucher discovery is not permission to create a second reservation.

**How to apply:** Bind funding to the existing server-owned renewal reservation and use the common owner/term payment guard. Keep a new route disabled until its submission, provider-return and date-finalization paths are verified together.

Renewal forms should have one payment-method selector: the large payment cards.

**Why:** The owner found a separate voucher payment dropdown confusing and requested selectable voucher cards that can be combined, with live payment-card amounts.

**How to apply:** Keep voucher selection independent of the method cards; reflect combined credit in those cards. Label previews as estimates until server-confirmed, and never allow an undiscounted charge while showing discounted amounts.

Renewal forms should have one primary action in the form footer, whether
credit is selected or not.

**Why:** The owner found an inline credit-continue button alongside the form's
Submit button confusing.

**How to apply:** Keep payment initiation and final submission in the same
footer position, showing only the applicable action. Preserve validation and
server-confirmed completion; moving the button must not bypass either.

An embedded credit checkout must return card authentication to its own payment
confirmer before navigating back to the form.

**Why:** The surrounding renewal form also consumes Stripe return parameters,
but its ordinary full-price confirmation handler does not own a voucher
PaymentIntent. Returning directly to the form can run both handlers.

**How to apply:** Complete provider confirmation on the bound fee-token route,
then refresh authenticated form status. Return URLs are navigation, never proof
of payment or completed monthly setup.

A returning renewal form must retain its original purchase identity even when
payment has already advanced the member's current term.

**Why:** Recalculating from the newest membership can hide the completed
checkout or offer a different term. Unsaved answers can also disappear during
provider authentication.

**How to apply:** Save the form before leaving, retain a non-secret checkout
reference scoped to the member/form/field, and recheck financial evidence at
submission. Never infer completion from the restored draft's status.

Composite financial tests need complete purchased snapshots and real
immutability/activation guards, not just ledger arithmetic.

**Why:** A date-only fixture can pass while completion fails on configuration,
payment-frequency or settlement protections that are reached only when the
history becomes paid.

**How to apply:** Exercise paid completion and replay under the actual guards;
keep fixture setup separate from the guarded transaction. State explicitly
when an external ledger boundary or provider is substituted.
