---
name: Catalogue event references
description: Rules for event-linked commercial products and reusable bundle composition.
---

Event-linked catalogue products must derive delegate capacity from the current ticket definition at read time, including a group ticket's group size. Never persist a copied capacity as the authoritative value, and revalidate the event/ticket link before restoring an archived product.

**Why:** Event and ticket definitions can be retired independently while catalogue records remain for history. A stale copied capacity or unchecked restore can make an invalid product newly sellable.

**How to apply:** Quote/catalogue consumers should exclude inactive records by default and fail closed when an event reference is unavailable. Replace ordered bundle items in one database transaction so a failed edit preserves the previous composition.

Proposal ticket fulfilment must support simple and complex events, event-specific ticket selection, and an automatic customer email after acceptance with a tokenised link for registering colleagues.

**Why:** The user explicitly described the required purchase-to-registration flow and asked for an audit before implementation.

**How to apply:** Registrations must enter ordinary event registration records, with the agreed proposal amount attributed per ticket: four tickets sold for £400 means £100 per ticket. Keep attributed sales value separate from any additional amount payable during registration so the customer is not charged twice.

Preserve the distinction between proposal-attributed ticket value and cash collected during registration. Never infer historical allocations' negotiated value from today's catalogue, or assign an entire mixed bundle's price only to its ticket components.

**Why:** A prepaid registration owes zero at checkout without being a zero-value sale. Mixed bundles include non-ticket benefits; assigning their entire price to tickets overstates event revenue.

**How to apply:** Freeze accepted commercial evidence for new allocations, apportion exact pennies using frozen component weights, and leave historical records unchanged. Ambiguous old ticket snapshots require an amended proposal rather than silently using live ticket capacity.

Unpriced package components must not block acceptance solely because ticket-value weights are missing or all zero. Accept with ticket attribution pending, not zero, and allow a separately audited admin assignment after acceptance.

**Why:** The owner approved this for package-priced sponsorship bundles whose ticket and non-ticket benefits have no individual prices.

**How to apply:** Preserve the accepted bundle price and original snapshots. Do not create an invoice/payment when assigning reporting value. Bound combined ticket values by the accepted line; unknown values stay explicit until assigned. This does not waive missing ticket identity/capacity validation.