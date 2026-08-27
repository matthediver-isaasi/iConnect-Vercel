---
name: Advisory locks through transaction poolers
description: How to safely serialize a long-running process when the PostgreSQL URL uses transaction pooling.
---

When a process uses a transaction-pooler database URL, hold an explicit transaction open and acquire the lock with `pg_try_advisory_xact_lock` or `pg_advisory_xact_lock`. Keep that transaction alive until the protected work ends, then commit or roll back in a `finally` block.

**Why:** A session-level advisory lock is attached to a physical PostgreSQL backend. Transaction poolers may assign later statements from the same logical client to another backend, leaking the lock or making unlock unreliable. An open transaction pins the backend, and a transaction-scoped lock releases automatically with the transaction.

**How to apply:** Use this whenever a script must serialize work that may span API calls or multiple database connections while connected through a transaction pooler. Acquire the lock before the authoritative re-read and planning step, not after a stale plan has already been built.