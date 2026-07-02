---
name: Admin CSV exports stream page-by-page
description: How members/organisations CSV exports avoid serverless timeout/OOM, and the mid-stream error contract.
---
Members and organisations CSV export endpoints (`api/admin/members/export-csv.js`, `api/admin/organisations/export-csv.js`) stream the response instead of buffering the whole CSV.

Shape:
- Fetch `preference_field` defs + the FIRST entity page BEFORE writing any headers, so a query failure still returns a real HTTP 500. Everything after `res.flushHeaders()` can only abort, not re-status.
- Then loop pages of 1000 entities; for each page fetch its preference values (batched by ~200 ids), build that page's rows, `res.write(chunk)`, and `await new Promise(r => setImmediate(r))` so the chunk actually flushes to the network.
- Memory stays bounded to one page; no giant in-memory array or single `res.send(csv)`.

**Why:** tenants with tens of thousands of members timed out / OOM'd — every page and every 50-id preference batch round-tripped sequentially and the whole CSV was held in memory before sending.

**Mid-stream error contract:** once streaming has started we CANNOT send a 500. On a mid-stream DB error we `res.destroy(err)` to abort the connection so the client sees a failed download rather than a silently truncated CSV. The outer catch also checks `res.headersSent` and destroys instead of `res.status(500).json`.

**How to apply:** if you add columns or change filtering, keep the "first page before headers" ordering and the per-page pref fetch. Org custom-field filters are applied per-row inside the page loop (not a pre-filter over all rows). Picklist labels need the RAW pref value, so the org loader keeps both a normalised map and a raw map.

The task also allowed an async background-job + email-link path for >5000 rows (mirroring the existing `form_submission_export_job` polling pattern); streaming was chosen as the lower-risk option that needs no migration or frontend change.
