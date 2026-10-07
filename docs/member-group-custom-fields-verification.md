# Member Group custom fields

## Migration / release status

Required: `supabase/migrations/202612080001_member_group_custom_fields.sql`.
It adds the JSONB values column, singleton setting identity, service-only definition
save RPC, restrictive definition policy and serialized value-write trigger.

**Not applied to any live database.** SOURCE and DEST remain untouched.
The migration was applied twice and exercised on a disposable local PostgreSQL
fixture only. Deployment requires explicit approval to apply it to verified DEST
(`lvmzliemqnieeoruhkik`).

Until that migration is available, schema detection disables custom-field controls
and definition writes. Legacy group creates/edits omit the new column and remain
functional. Nonempty custom values are rejected explicitly; ordinary database
errors fail closed instead of being mistaken for an unmigrated schema.

The runner never falls back to SOURCE or DATABASE_URL:

```
node scripts/apply-member-group-custom-fields.mjs
node scripts/apply-member-group-custom-fields.mjs --preflight
node scripts/apply-member-group-custom-fields.mjs --apply --review-sha256=<reviewed-hash>
```

Default invocation is offline hash review, not an application. Apply verifies
REST/SQL destination pins and TLS, runs transactionally and checks column,
singleton and function grants. Run only after approval.

## Behavior

Definitions use server-generated UUIDs; confirmed deletion atomically erases values
from this tenant's groups and never reassigns them.
Saved types are fixed and dropdown choices append-only, preventing reinterpretation
of retained values. The administrator must create a new field for a different type
or choice vocabulary. Replacement value objects clear omitted keys; omission of the
entire property leaves values untouched. Group-admin content permissions are unchanged.

Generic settings CRUD (including key renames) cannot write the protected setting.
Public group-card endpoints retain their existing explicit column lists. Generic
group reads project only published, populated detail values for non-administrators;
private definition rows are excluded from generic and public settings reads.

## Verification

- Focused Node/React/disposable PostgreSQL checks cover all types, zero/false,
  clearing, rename/delete, tenant and authorization boundaries, private projection,
  revision conflicts, migration replay/grants, concurrent deletion/value saves,
  draft retention, tenant-scoped query behavior, atomic erasure and pre-migration compatibility.
- Production `npm run build` passed (existing large-bundle warnings).
- Browser fixtures cover actual detail-page positioning, About-empty rendering,
  matching font size, line breaks and width at 390px and 1280px; management modal
  hydration, save, reopen and duplication are exercised separately.
- Existing `MemberGroupManagement.assignments.test.mjs` passes.
- Existing `MemberGroupDetail.relationship-labels.test.mjs` has a pre-existing
  source assertion expecting `formatRelationshipDisplayValue`; HEAD already uses
  `formatRelationshipAnswerDisplayValue`. It is not changed by this work.

Browser tests mock API responses and block unexpected mutations; they are not
evidence of live database persistence or deployed tenant behavior. The unauthenticated
app screenshot reached the existing loading/auth boundary, not the signed-in pages.
The signed-in live UI and migration application remain unverified.

Commands:

```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test shared/memberGroupCustomFields.test.mjs api/member-groups/custom-fields.test.mjs supabase/migrations/memberGroupCustomFields.test.mjs api/public/member-groups.test.mjs client/src/lib/memberGroupCustomFields.test.mjs client/src/pages/MemberGroupCustomFields.test.mjs client/src/pages/MemberGroupManagement.assignments.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test client/src/components/member-groups/CustomFieldsDisplay.test.jsx client/src/hooks/useMemberGroupCustomFields.test.jsx
npx playwright test --config=tests/member-group-custom-fields.config.mjs
```
