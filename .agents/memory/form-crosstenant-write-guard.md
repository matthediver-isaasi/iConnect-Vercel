---
name: Form cross-tenant org guard & rollback pitfalls
description: Cross-tenant org resolution/write guards in the application processor, and why "no processing notes" can mean the row was rolled back or a stale bundle served the request.
---

**Rule:** In the application processor, every org AND member UPDATE must go through the shared write-time tenant guard (hard `eq`/`is null` tenant filter + 0-rows-updated check that flushes a processing note and fails the request; legacy NULL-tenant rows are adopted by stamping the effective tenant on the allowed update). Never bypass it, and never let a blocked write fall through as a successful submission. The guard treats a row object *lacking* tenant_id as legacy (IS NULL filter) — every caller must pass a row read with its authoritative tenant_id.

**Why:** A cross-tenant name-collision incident recurred AFTER the resolution fix because an older serving bundle predated it — resolution-time checks alone can't protect prod data across deploys; the write-time filter can.

**Gotchas:**
- PostgREST `.or()` is unreliable on UPDATE — the guard deliberately uses plain `.eq()`/`.is()` filters.
- `api/public/form-submission.js` DELETES the submission row when the entity pipeline returns non-ok ("rollback") — this destroys processing_notes, so a vanished submission + silent outcome may be this rollback, not tester cleanup.
- Error-path early returns in process-application must `await flushProcessingNotes()` first or the diagnostic trail is lost.
- Cross-tenant residue detection: join organization_preference_value → field tenant vs org tenant; mismatches identify clobbered rows precisely.
