# Profile affiliation form — staged rollout

## Agreed behaviour

The owner replaced the proposed all-changes manual Due Diligence gate with
automatic reconciliation. Unknown Organisation Groups, primary organisations
and overseas organisations use the existing September Zombie Organisation.
Unknown names remain in ordinary submissions; no shared records are created.
Existing renewal forms keep their Not-listed review behaviour.

Routing is tenant-scoped, default-off, ordered exact matching against member
core/custom values, with an explicit fallback (or an unavailable message).
Forms use authenticated-owner access, not caller-supplied member identifiers.

## Source evidence and adaptation

`docs/profile-affiliation-form-staging.json` contains the read-only DEST
extraction manifest, source digest, verified relationship endpoints, remapped
field identifiers, draft form, and private reconciliation bindings.

The verified Group field is **Organisation Group**, not Member Group.
The standalone page retains the country, group, site, primary department and
repeatable additional-site selectors. Registration member-class, region and
creation-copy fields are excluded, as are all record-creation pipelines,
role/login/consent/payment actions and set-value rules.

One registration visibility rule depended on the NMC journal answer on a
different page. The adaptation removes that rule and retains the existing
country-only overseas branch instead. Other unresolved cross-page conditions
stop extraction rather than being silently discarded.

`node scripts/stage-profile-affiliation-form.mjs` only reads DEST and prepares
the local manifest. It does not create or publish anything in the tenant.

## Installation boundary

The new SQL migration and draft installation require an approved pilot step.
No production submission tests, publication, or tenant cutover are authorized.

1. Run isolated regression and PostgreSQL tests.
2. Apply `20261105_profile_affiliation_forms.sql` to verified DEST only through
   the project's reviewed migration process.
3. Run `node scripts/install-profile-affiliation-draft.mjs` for read-only
   preflight. Its apply mode requires both `--apply` and the exact
   `--manifest-sha256=...` printed by preflight.
4. The installer creates only an unpublished standalone form and its private
   bindings. It does not modify the source join form, renewal form, old profile
   settings, or enable tenant routing.
5. Inspect the standalone form in Form Builder, verify its permitted member
   experience in the approved deployed environment, and explicitly publish and
   enable routing only after owner approval.

Legacy settings remain available when form mode is off. A failed bound profile
submission prevents a direct legacy save from bypassing recovery.

## Verification

Use the isolated test runner; do not point fixture tests at DEST:

```sh
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/profileAffiliationForms.test.mjs \
  api/_lib/formMemberAffiliations.test.mjs \
  api/_lib/formMemberAffiliationAnswers.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  supabase/migrations/20261102_form_member_relationship_current_set.test.mjs \
  scripts/profile-affiliations.postgres.test.mjs
```

Local fixture results are not real authenticated deployed verification. The
workspace's legacy database is not the destination used by the published app.

## Installation record — 2026-11-05

Following explicit owner approval, the migration was installed on pinned DEST
and the standalone draft was created:
`0df340f5-d3bc-5d43-8cb2-c7b6d1f21315` (`update-my-affiliations`).
The draft is inactive; tenant routing was not enabled. No live member submission
was made. Publication and tenant cutover still require separate approval.

The first draft insert rolled back because the database requires a non-null
structured-actions document. The adaptation now supplies the schema's empty
`{version: 1, actions: []}` document, covered by a regression test.
