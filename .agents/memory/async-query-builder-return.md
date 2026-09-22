---
name: Async query-builder returns
description: Preserve unexecuted Supabase queries across async authorization helpers.
---

Return an object containing a Supabase query builder from async helpers, not the builder itself.

**Why:** Supabase builders are thenables. Returning one directly from an async authorization helper executes it before the caller can add pagination, counts, or further access restrictions.

**How to apply:** Wrap the builder as `{ query }` and destructure it at the caller. Tests must use a thenable query double; plain chain-only stubs miss premature execution.