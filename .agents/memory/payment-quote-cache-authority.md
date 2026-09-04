---
name: Payment quote cache authority
description: Why payment quote identities include inputs used by authoritative submission validation.
---

Payment quote cache keys must include answers that can change authoritative server validation, even when those answers do not change the fee arithmetic. Keep genuinely unrelated answers out of the key.

**Why:** Relationship renderers can normalize dependent values after a parent changes. If the key includes only fee-mapped answers, an error quoted from the transient stale payload remains cached after the payload becomes valid. Required not-listed text has the same recovery requirement.

**How to apply:** When adding validation ahead of payment quoting or creation, classify its answer dependencies and add them to the quote fingerprint. Preserve the same authoritative validator on quote and create paths; the broader key is for refresh behavior, not a substitute for enforcement.