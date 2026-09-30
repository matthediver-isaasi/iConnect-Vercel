---
name: Member/org CSV import pitfalls
description: Non-obvious data-loss traps in api/imports/execute.js (SQL fast path, aux persistence, comm-pref column, custom-field column name, email case).
---

# Member/org CSV import pitfalls

## SQL fast path: core via RPC, aux (custom/comm/notes) persisted set-based
`api/imports/execute.js` has a "fast path" for member + email imports that calls
the `process_member_import_batch` RPC, and (now) an org + name fast path calling
`process_organization_import_batch`. Each RPC persists only a FIXED set of REAL
columns. `custom:*`, `comm:*`, and `__add_note__` are NOT columns — they are
persisted separately, set-based, AFTER the RPC by `persistMemberAux` /
`persistOrgAux`, matching by lower(trim(identifier)).

**Rule:** aux persistence must run per processed slice `[sliceStart, sliceEnd)`
on BOTH the not-done and done returns, because the chunk loop is resumable —
deferring all notes to the final chunk loses every earlier chunk's data. The
entity must already exist (RPC ran first) for the email/name→id lookup to
resolve. Aux is idempotent for custom/comm (upserts), so a retried chunk is
safe; notes are insert-only (a retried chunk could double-insert notes — accepted
tradeoff vs. losing them).

**Rule:** any NEW real-column member/org field must be added to the RPC AND its
`SQL_FASTPATH_FIELDS` / `ORG_SQL_FASTPATH_FIELDS` allow-list, else the import
falls to the slow JS path. `custom:*`/`comm:*` are already allowed by the gates
because aux handles them.

## comm pref real column is `is_subscribed`, NOT `opted_in`
`member_communication_preference` stores subscription state in column
**`is_subscribed`** (onConflict `member_id,category_id`). Import code historically
upserted `opted_in` — the upsert errored and was swallowed, so EVERY imported
comm preference silently vanished. Always write `is_subscribed`.

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
