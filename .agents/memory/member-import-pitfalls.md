---
name: Member/org CSV import pitfalls
description: Non-obvious data-loss traps in api/imports/execute.js (SQL fast path, custom-field column name, email case).
---

# Member/org CSV import pitfalls

## SQL fast path silently drops most fields
`api/imports/execute.js` has a "fast path" for member + email imports that calls
the `process_member_import_batch` RPC. That RPC only persists a FIXED set of
fields (email, first/last name, mobile, landline, job_title, role, org,
role_effective_from, created_on). Every other mapped field — biography, social
URLs, login flags, external_id, and ALL `custom:*` / `comm:*` fields — is
dropped with no error if the fast path runs.

**Rule:** any new mappable member field must either be added to the RPC AND its
`SQL_FASTPATH_FIELDS` allow-list, or the import must fall to the JS path. The
gate `allMappingsFastPathSafe` routes to the JS path whenever a mapping is
outside the allow-list. If you add a field to the RPC, update the allow-list in
lockstep or it will keep taking the JS path unnecessarily.

## preference_value column is `field_id`, not `preference_field_id`
`member_preference_value` and `organization_preference_value` store custom-field
values in column **`field_id`**, with a unique constraint on
`(member_id, field_id)` / `(organization_id, field_id)`. Older import code
upserted `preference_field_id` (wrong) so the upsert errored and the error was
swallowed — zero custom values were ever saved. Always use `field_id` and
`onConflict: '<entity>_id,field_id'`.

## Emails must be stored lowercased
The login resolver (`api/_lib/memberLoginResolver.js`) looks members up with
`eq('email', lower(email))`. If an import stores a mixed-case email the member
cannot be resolved and the admin detail page shows a misleading
"No Member Record" badge (reason `no_member`). Lowercase email on every write
path. `scripts/normalize-member-emails.mjs` (dry-run by default, collision-safe)
repairs existing mixed-case rows.

**Why:** these three traps each fail silently — no error surfaces, data just
vanishes or members look broken — so they are easy to reintroduce.
