---
name: PostgREST metadata compare-and-swap
description: Large JSON equality filters can fail at the HTTP layer and masquerade as concurrent processing.
---

Send large JSON compare-and-swap operands in a server-only RPC request body, never as PostgREST URL equality filters. Preserve the atomic comparison and ownership checks; removing the comparison is not a safe size fix.

**Why:** Form processing expanded payment metadata to about 21 KB. Its encoded equality filter exceeded 30 KB and a read-only reproduction returned HTTP 400 Bad Request. Code that treated every database error as a zero-row update incorrectly reported a competing lease owner, leaving both initial finalisation and stale recovery blocked indefinitely.

**How to apply:** For JSON-backed claims and state transitions, test realistic post-processing payload sizes, preserve unrelated metadata, distinguish transport/database errors from genuine lost races, and exercise owner fencing in database tests. A stable old claim despite repeated “concurrent caller” messages is reason to inspect the actual request error, not assume overlapping workers.

Database fixtures must match the actual column types referenced by an RPC, including columns in branches that the tested call does not take.

**Why:** A corrective RPC passed installation and tests against a text notes column, but the deployed column was JSONB. PostgreSQL rejected a mixed text/JSONB CASE on invocation even with note-writing disabled, so every lease update still failed.

**How to apply:** Inspect the target schema before constructing isolated fixtures. Invoke the RPC against matching types and test both sides of optional updates; successful function creation alone does not validate deferred PL/pgSQL statements.