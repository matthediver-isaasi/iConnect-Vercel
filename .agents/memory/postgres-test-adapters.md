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

## Service-role visibility in disposable clusters

Model the production service role's RLS bypass and schema/reference-table
permissions when testing invoker-rights triggers under that role.

**Why:** A plain `CREATE ROLE service_role` in a local fixture does not reproduce
Supabase's service-role authority. Trigger reads can see no referenced row
through RLS and report a missing tenant/stage even when the row exists.

**How to apply:** Configure bypass and grants only inside the disposable test
cluster. Do not weaken production guards, disable production RLS, or grant
broader live permissions to work around a fixture visibility failure.
