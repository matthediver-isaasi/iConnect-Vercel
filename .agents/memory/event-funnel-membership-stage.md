---
name: Event funnel membership stage decisions
description: Owner-confirmed behaviour for complimentary membership offered inside Event Funnels.
---
The funnel +Membership stage is an optional **offer** the purchaser may decline.
Checkout grants **eligibility for one free period** of the exact tier (same model
as proposal/bundle coverage), never immediate membership activation. Both
organisation and individual structures must be supported. For individual tiers,
the recipient (purchaser only vs each named attendee) is an **admin option on the
stage**. Cancelling the originating booking withdraws an unconsumed benefit;
consumed benefits are not reversed.

**Why:** Owner decisions on 2026-11-25 when requesting the feature. The existing
proposal coverage was organisation-only.

**How to apply:** Generalise the entitlement and consumption rules to member
recipients instead of building a separate waiver path. Keep proposal behaviour
unchanged.

Implementation decisions (2026-11-25): a benefit reserved by a membership
checkout (payment quote, form submission or fee link) is never withdrawn by a
booking cancellation; it is reported as `reserved` for admin review. An admin
membership Start can only apply the benefit through No charge; payable Start
modes are refused while an unused benefit for that tier exists.
**Why:** withdrawing under an in-flight add-on payment would make the paid
history insert fail; individual tiers have no add-ons, so a payable Start would
charge a covered base fee.
