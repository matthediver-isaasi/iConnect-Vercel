---
name: Signed agreement PDF supersession
description: How retained signed sales-agreement PDFs may be replaced with a new presentation layout without losing evidence.
---
Completed agreement files change only through the supersede RPC, which writes an append-only history row (original path + hash) in the same transaction; the guard rejects every other change. Each layout gets its own storage path; originals are never overwritten or deleted.

**Why:** signed evidence must stay producible for disputes, while customers should download the current layout. A plain UPDATE of path/hash is blocked by design.

**How to apply:** never replace a completed agreement's file by direct update; follow docs/sales-agreement-pdf-reformat.md.
