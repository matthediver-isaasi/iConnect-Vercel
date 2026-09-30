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
2. entityToTable map — add `'<Name>': '<table_name>'`. This map is DUPLICATED in
   BOTH `api/entities/[entity]/index.js` (list/create) AND
   `api/entities/[entity]/[id].js` (by-id get/update/delete). Register in both or
   by-id operations resolve the wrong/guessed table. `getTableName` auto-derives
   snake_case as a fallback, but register explicitly so the mapping is
   unambiguous (there is no allowlist that rejects unmapped entities; the fallback
   just guesses the table name). Note: an entity in the IEdit page family
   (`IEditPage`/`IEditPageElement`/etc.) also appears in a draft-visibility gate
   allowlist in `[id].js` — mirror it there if the new entity is part of that family.
3. `client/src/api/base44Client.js` — add a getter
   `get <Name>() { return this._getEntity('<Name>'); }`.
4. `schema/<Name>.json` — entity definition (properties + required).

**Gotcha — TENANT-scoped tables with no `organization_id` column:** the generic
entity API force-sets `organization_id = tenantCtx.organizationId` for any TENANT
entity NOT in an `entitiesWithoutOrgId` allowlist. If your table only has
`tenant_id` (no `organization_id` column), you MUST add the entity to EVERY copy
of that allowlist or create/update/list/delete fails with PGRST204 "Could not
find the 'organization_id' column". The list is duplicated across SIX sites:
2 in `api/entities/[entity]/index.js` (GET org-id fallback + POST inject) and
4 in `api/entities/[entity]/[id].js` (by-id GET, before-update, update,
delete/verify). They drift independently — grep all of them. `tenant_id` is
auto-set from the session, so never send it from the client.

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
