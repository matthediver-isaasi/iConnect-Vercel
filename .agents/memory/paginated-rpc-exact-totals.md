---
name: Paginated RPC exact totals
description: Preserving authoritative totals when a requested database page is empty or beyond the last row.
---

A paginated selector must return its exact filtered total independently of whether the requested page contains rows. A window count attached only to result rows is insufficient.

**Why:** `count(*) over()` disappears when `OFFSET` produces no rows, so consumers can incorrectly report total zero and reset pagination even though matching records exist.

**How to apply:** Return a response envelope with page rows plus total, or emit a typed count sentinel only when the page is empty. Consumers must remove a sentinel before loading record IDs while retaining its count. Test both a truly empty result and an offset beyond a non-empty result.