---
name: PostgreSQL function-body comparison
description: Whitespace normalization when comparing live function bodies with reviewed migration text.
---
Normalize leading and trailing spaces, tabs and newlines consistently before comparing PostgreSQL `prosrc` with JavaScript-trimmed migration bodies.

**Why:** PostgreSQL's default `trim` removes spaces only, while JavaScript `trim()` also removes newlines. This can falsely report drift in an unchanged live writer and stop a guarded import.

**How to apply:** Use an explicit whitespace set for SQL `btrim` or perform both comparisons in the same runtime. Do not weaken comparisons inside the body or bypass a genuine mismatch.
