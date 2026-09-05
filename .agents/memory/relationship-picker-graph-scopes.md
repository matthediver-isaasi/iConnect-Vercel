---
name: Relationship picker graph scopes
description: Durable rules for restricting direct relationship choices through other linked records.
---

A reusable picker restriction compares two bounded paths: one starting from the direct relationship’s source endpoint and one from its target endpoint. Each hop stores the immutable relationship-definition ID and the side traversed; the terminal record sets must intersect.

**Why:** Domain labels and built-in core fields cannot represent reusable eligibility rules such as secondary affiliations. Path identity must survive label/key changes, and forged or stale selections must be rejected by the same rule as the picker.

**How to apply:** Traverse only tenant-owned active definitions, active edges, and live endpoints; cap depth, scanned edges, and intermediate results; batch ID reads; filter before exact search/count/pagination; revalidate on every write. Empty or malformed paths fail closed. Preserve legacy picker scopes until explicitly converted.