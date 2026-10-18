---
name: Catalogue event references
description: Rules for event-linked commercial products and reusable bundle composition.
---

Event-linked catalogue products must derive delegate capacity from the current ticket definition at read time, including a group ticket's group size. Never persist a copied capacity as the authoritative value, and revalidate the event/ticket link before restoring an archived product.

**Why:** Event and ticket definitions can be retired independently while catalogue records remain for history. A stale copied capacity or unchecked restore can make an invalid product newly sellable.

**How to apply:** Quote/catalogue consumers should exclude inactive records by default and fail closed when an event reference is unavailable. Replace ordered bundle items in one database transaction so a failed edit preserves the previous composition.

Proposal ticket fulfilment must support simple and complex events, event-specific ticket selection, and an automatic customer email after acceptance with a tokenised link for registering colleagues.

**Why:** The user explicitly described the required purchase-to-registration flow and asked for an audit before implementation.

**How to apply:** Registrations must enter ordinary event registration records, with the agreed proposal amount attributed per ticket: four tickets sold for £400 means £100 per ticket. Keep attributed sales value separate from any additional amount payable during registration so the customer is not charged twice. This requirement does not by itself prove the complete flow is implemented.