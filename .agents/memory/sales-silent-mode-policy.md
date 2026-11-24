---
name: Opportunity automatic communication policy
description: Per-opportunity scope, exclusions and non-replay contract for Silent mode.
---
Silent mode is per opportunity, never tenant-wide. Checked automatic communications are permitted only at their normal trigger, not sent immediately. Off preserves ordinary behavior and saved selections; suppressed occurrences never catch up afterward.

**Why:** The owner explicitly scoped this as optional automatic delivery control, not a change to acceptance, invoicing, payments, allocation, manual delivery or required signing verification.

**How to apply:** Inventory actual automatic Sales send origins before adding categories. Preserve independent signatory selections and fail retryably when current authoritative policy cannot be resolved. Retrying the same automatic occurrence must not bypass policy. Do not use live customer sends, scheduler activation or historical rewrites to verify this feature.
