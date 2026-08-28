---
name: Conditional form-filter authority
description: Security and compatibility rules for answer-dependent selectable form options.
---

Conditional option filters must be resolved from the persisted form definition on the server. Browser requests may provide only the target field identity and the minimum referenced source answers; they must never supply trusted filter definitions or place answer values in URLs or cache keys.

Validate explicit filter modes before interpreting an empty selected-values list as “no restriction.” Absence and a valid empty filter may intentionally be unrestricted; a malformed mode or shape must never collapse to absence.

**Why:** Client-only filtering permits forged or stale values, while sending full answers through GET/query keys leaks unrelated form data. Client/server normalization drift also causes the UI and submission validator to select different rules. Checking emptiness before validity turns malformed persisted policy into an accidental allow-all.

**How to apply:** Intersect the matched rule with every existing static restriction, use identical field-aware normalization for scalar, multi-value, boolean, country, score, keyed-object, and dynamically loaded entity answers, validate shape and mode before empty-list shortcuts, make malformed/unmatched states fail closed, and revalidate before every submission side effect.