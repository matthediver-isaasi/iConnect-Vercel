---
name: Form processor tenant scoping
description: The application processor's body tenant_id is client-controlled; effective tenant must be resolved from persisted form/submission before ANY tenant-scoped query.
---

The rule: in `api/forms/process-application.js`, every existing-entity lookup (prefill ids, name/email matches) and every tenant stamp on created records must use the tenant resolved by `api/_lib/formTenantScope.js` (`resolveEffectiveEntityTenant`): form.tenant_id → form_submission.tenant_id → body tenant_id (fallback only). A supplied body tenant that mismatches the authoritative one is rejected 403 (`TENANT_MISMATCH`). Cross-tenant rows found by id/name are treated as "not found" (NULL-tenant legacy rows stay matchable).

**Why:** the unscoped case-insensitive org name match once linked a submission to a same-named org in a DIFFERENT tenant, which also suppressed org creation on a create-action form. A completion review additionally rejected trusting `req.body.tenant_id` ahead of the persisted tenant, and required the resolution to run BEFORE the server-side uniqueness block (ordering is guarded by `api/forms/processApplicationTenantOrder.test.mjs`).

**How to apply:** when adding any new lookup or insert in the processor, scope it with `effectiveEntityTenantId` / `rejectCrossTenant`, never raw `tenant_id`. Repairing bad links: `scripts/repair-cross-tenant-form-orgs.mjs` (DEST, dry-run default, only create/upsert org actions, skips unsupported mapping semantics).
