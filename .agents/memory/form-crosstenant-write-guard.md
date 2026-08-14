---
name: Form cross-tenant org guard & rollback pitfalls
description: Cross-tenant org resolution/write guards in the application processor, and why "no processing notes" can mean the row was rolled back or a stale bundle served the request.
---

**Rule:** Organisation resolution in the application processor goes through `api/_lib/formOrgResolution.js` (tenant-scoped chain + rejectCrossTenant), and the org UPDATE is wrapped in `applyOrgWriteTenantGuard` (`.eq('tenant_id', effective)` for tenanted rows, `.is('tenant_id', null)` for legacy adoption) with a 0-rows-updated check → 409 CROSS_TENANT_ORG_WRITE. Don't bypass either when touching org writes there.

**Why:** A cross-tenant name-collision incident recurred AFTER the resolution fix because an older serving bundle predated it — resolution-time checks alone can't protect prod data across deploys; the write-time filter can.

**Gotchas:**
- PostgREST `.or()` is unreliable on UPDATE — the guard deliberately uses plain `.eq()`/`.is()` filters.
- `api/public/form-submission.js` DELETES the submission row when the entity pipeline returns non-ok ("rollback") — this destroys processing_notes, so a vanished submission + silent outcome may be this rollback, not tester cleanup.
- Error-path early returns in process-application must `await flushProcessingNotes()` first or the diagnostic trail is lost.
- Cross-tenant residue detection: join organization_preference_value → field tenant vs org tenant; mismatches identify clobbered rows precisely.
