---
name: Event funnel discount codes
description: Owner rule and safety design for discount codes in the event funnel checkout.
---
Rule: a funnel discount code applies ONLY to the source (entry) event purchase — never add-ons, extra events or memberships. One code, no stacking.
**Why:** owner decision — "the source event is likely to always be the highest price purchase given the principal nature of funnels".

**How to apply:**
- The discount is applied before training fund and vouchers; the server quote is the only authority (client preview is display-only).
- Simple-event registrations store pre-discount total_cost plus discount_code_amount; complex ticket_price is already discounted (matches normal checkout and reports).
- Usage is counted once, on order confirmation (redemption table keyed by order), never at prepare; a limit reached after payment still counts rather than failing a paid order.
- Fail-closed rollout: the app hides the field unless the DB readiness RPC returns true, and the older prepare-order function rejects any non-empty discounts array, so nothing is discounted until the migration is installed.
