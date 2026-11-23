---
name: PostgreSQL test adapter semantics
description: Preserve production JSON result types when exercising real SQL through local adapters.
---

Local database adapters must preserve the result types returned by the
production API, not merely execute the same SQL.

**Why:** A native PostgreSQL composite result can reach Node as a string. A
worker may then treat a successfully committed claim as an empty result,
leaving work leased without executing it. That is a harness failure, not proof
that the production claim or lease rules are wrong.

**How to apply:** Normalize composite results to JSON at the SQL boundary in
disposable adapters. Before weakening a failing workflow guard, check both
committed database state and the value received by the worker.
