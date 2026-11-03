---
name: Post-grace membership renewal
description: Approved late-renewal commencement and retention of prior membership class.
---

Members must be able to renew after grace expires; the new term starts when they pay rather than being backdated to the prior expiry. Treat allowing the resulting gap as a tenant policy decision.

**Why:** On 2026-11-02 the owner explicitly accepted the potential benefit of a member using the grace period before paying for another year, rather than blocking late renewals.

**How to apply:** Preserve the existing contiguous renewal rule within grace. After grace, use payment-confirmed commencement and keep historical terms unchanged. Preserve prior membership class separately from the access role so assignment to Former does not lose renewal identity. This records the requested policy, not a claim that late renewal is implemented.

When resolving provisional dates, preserve the purchase's original correlation identity and financial/consent evidence; do not treat changing service dates as permission to rename the purchase.

**Why:** Provider notifications and existing checkout recovery correlate using the originally issued membership-year identifier. Changing that identifier with the service dates can disconnect a successful payment from its existing purchase and undermine duplicate protection.

**How to apply:** Keep correlation keys stable, resolve service dates separately, and retain an exact audit of the before/after records. A non-adjacent restart's historical predecessor belongs to its election/evidence; do not fabricate an adjacent rolling-term relationship.

Post-grace renewal is not complete merely because date helpers, storage or an isolated transaction test passes.

**Why:** The owner repeatedly requested the working member journey, without stopping at preparatory layers that still leave expired members unable to pay.

**How to apply:** Completion must include authorized checkout, provider confirmation and recovery, monthly collection behavior, member access and the portal/FormBuilder entry points. Keep rollout disabled until that connected path has been verified; report incomplete delivery explicitly.

Use the first successful collection's service date, not notification arrival order.

**Why:** Stripe success events and bank collection notifications can arrive late or out of order. Direct Debit's collection date becomes usable only once the payment is confirmed or paid out; creating a mandate is not payment.

**How to apply:** Stripe uses the recorded successful-payment time; Direct Debit uses the successful payment's bank collection date. Keep provider cadence and purchase identifiers unchanged while aligning all service-date mirrors, including those used by later plan creation.
