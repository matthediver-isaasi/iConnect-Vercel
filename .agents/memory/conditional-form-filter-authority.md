---
name: Conditional form-filter authority
description: Security and compatibility rules for answer-dependent selectable form options.
---

Conditional option filters must be resolved from the persisted form definition on the server. Browser requests may provide only the target field identity and the minimum referenced source answers; they must never supply trusted filter definitions or place answer values in URLs or cache keys.

**Why:** Client-only filtering permits forged or stale values, while sending full answers through GET/query keys leaks unrelated form data. Client/server normalization drift also causes the UI and submission validator to select different rules.

**How to apply:** Intersect the matched rule with every existing static restriction, use identical field-aware normalization for scalar, multi-value, boolean, country, score, and keyed-object answers, make malformed/unmatched states fail closed, and revalidate before every submission side effect.