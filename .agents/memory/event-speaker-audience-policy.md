---
name: Event speaker audience policy
description: Recipient authority and consent for speaker audience segments.
---

Linked speakers use the current tenant member email, not the separately editable speaker contact email. Unlinked speakers remain external even if their email matches a CRM member. Missing linked members fail closed; inactive speakers are excluded.

**Why:** Linking establishes a stable member consent identity; silently falling back to an ad-hoc address could bypass that identity. Speaker targeting must not require a booking or infer membership from an email match.

**How to apply:** Keep preview and durable preparation on the same recipient policy, with ordinary member suppression and the canonical tenant/email unsubscribe ledger. An explicit opt-out override changes suppression, not speaker eligibility or email validity.
