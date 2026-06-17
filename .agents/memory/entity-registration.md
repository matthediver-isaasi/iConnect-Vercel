---
name: Adding a new entity to the generic API
description: The set of places a new entity must be registered to be readable/writable via the base44 entity API.
---

Adding a new DB table that you want to read/write through the generic entity API
(`base44.entities.<Name>`) requires registration in THREE places, plus a schema
file. Missing any one causes silent scope/tenant failures rather than obvious
errors.

1. `api/_lib/tenantContext.js` — add `'<Name>': TENANT_SCOPE.<LEVEL>` to the
   ENTITY scope map. Determines tenant isolation. Without it the entity may not
   be tenant-scoped correctly.
2. `api/entities/[entity]/index.js` — add `'<Name>': '<table_name>'` to the
   entityToTable map. `getTableName` auto-derives snake_case as a fallback, but
   register explicitly so the mapping is unambiguous (there is no allowlist that
   rejects unmapped entities; the fallback just guesses the table name).
3. `client/src/api/base44Client.js` — add a getter
   `get <Name>() { return this._getEntity('<Name>'); }`.
4. `schema/<Name>.json` — entity definition (properties + required).

**Gotcha — TENANT-scoped tables with no `organization_id` column:** the POST
handler in `api/entities/[entity]/index.js` force-sets `organization_id =
tenantCtx.organizationId` for any TENANT entity that is NOT in its
`entitiesWithoutOrgId` allowlist. If your new table only has `tenant_id` (no
`organization_id`), you MUST add the entity to that list or every insert fails
("column organization_id does not exist"). `tenant_id` itself is auto-set from
the session, so never send it from the client.

**Forcing a per-member owner on write:** TENANT scope does NOT force `member_id`
(only MEMBER scope does, but MEMBER scope also restricts reads to the owner). For
"personal" rows under a tenant-readable table (e.g. an application a member files
that admins must also read), keep TENANT scope and add a `entityNorm === '<x>'`
special-case in the POST handler that sets `sanitizedBody.member_id =
tenantCtx.memberId` (and do duplicate/uniqueness checks there). See the
`formsubmissionsavedview` / `vacancyapplication` blocks.

**Why:** these maps are the source of truth for tenant scoping and table
resolution; they are not auto-generated from the DB.

**How to apply:** whenever you create a table that the React client lists/filters
via the entity API. For write endpoints with custom logic (e.g. sending email
then recording a row), still register for the client *read* path even if writes
go through a bespoke `/api/...` endpoint.

Reference implementation: `form_submission_email` / `FormSubmissionEmail`.
