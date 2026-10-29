---
name: Guest registration association policy
description: Explicit organisation/group selection must not reinterpret guest-entered company details or capacity rules.
---
Guest-to-member conversion may link either an Organisation or a direct Organisation Group, never Member Groups. Free-text company details are reference information, not association authority.

**Why:** The owner explicitly requested optional direct associations while preserving registration history and existing role-capacity policy.

**How to apply:** Keep group-only members organisation-less. A group cannot satisfy the organisation requirement of a capacity-limited role. Never alter historical purchaser, payment or registration organisation data when creating the member.

Event registration may offer one combined organisation/Organisation Group list,
with independent event-level custom-field filters and an Other free-text option.
For this explicit selection path the owner approved **sign-in-enabled accounts**
using the event's configured eligible role, created after successful registration.
This also covers unpaid public Invoice/PO registration without creating a payment.

**Why:** Returning known email addresses must use the authenticated booking flow.
Login-disabled contacts would leave those registrants unable to book again.

**How to apply:** Verify selection eligibility and tenant ownership server-side,
preserve paid-checkout snapshots for recovery, never adopt or reassign an existing
email, and keep Other and authenticated bookings on their existing paths.
Selecting an association does not establish paid membership or marketing consent.
