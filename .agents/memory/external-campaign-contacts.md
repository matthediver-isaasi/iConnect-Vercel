---
name: External campaign contacts
description: Cross-surface rules for list-specific non-member recipients and unsubscribe state.
---

List-specific external contacts must enter the normal audience resolver before global/category suppression, case-insensitive deduplication, preview/counting, and campaign-recipient materialization. Materialized rows explicitly carry a null member identity.

**Why:** A separate send path drifts from tracking, preference links, opt-out behavior, and deduplication. Manually added contacts also may have no form-created subscriber row, so subscriber state alone cannot represent their preferences.

**How to apply:** Treat the tenant/email unsubscribe ledger as canonical for non-member preference reads and future-send suppression. Keep list-contact audit rows intact on unsubscribe, and make suppression lookups fail closed unless the applicable audience explicitly bypasses opt-outs.