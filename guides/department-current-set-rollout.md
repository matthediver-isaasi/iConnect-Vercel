# Department current-set rollout

`scripts/configure-department-current-set.mjs` is the narrow, destination-pinned
configuration step for BNMS form `8b6f44d3-83f8-449e-9496-b10b1dc28e5f`.

This rollout is for the direct **Workforce Row → Department** model. It uses
the pinned `a422da51-6005-4831-a69e-bf284ff6f124`
`workforce_survey_row_department` relationship; it does not reintroduce a
Workforce Survey parent or a `row_name` requirement. Historical migrations and
the separately prepared import artifacts remain historical evidence, not
execution authority.

It is dry-run-first. It fully pages the relevant Department, Workforce, Equipment
records and relationship edges, verifies the saved year-only equipment questions,
the direct one-Department-per-workforce-row invariant, respondent relationship
metadata, canonical object-dropdown versus form-option compatibility, and the
largest Department Workforce and Equipment sets. It also verifies the pinned
direct-import source fingerprint and that existing plus planned workforce rows
will fit within 100 rows for every Department. It does **not** create, update,
archive, or import current-set records during a dry run.

For the two Workforce selects only, the reviewed candidate repairs an exact
form/object option mismatch by storing the active canonical object values.
It preserves the existing form ordering and visible labels for every
unambiguous existing option, including labels that intentionally omit a
canonical trailing space. Missing canonical Grade options are appended in their
canonical order. The dry-run report emits the complete `before_options` and
`after_options` arrays plus each canonicalized value; duplicate, unmatched, or
otherwise ambiguous options stop the rollout. It never trims or case-folds
canonical persisted values, and it does not edit object options or record data.

The preflight reports the saved `min_rows`, `first_row_required`, container
`required`, and required child headers for both repeatable sections. It refuses
to change a form whose container constraints would prevent deliberately clearing
either Workforce or Equipment: that needs an explicit current-set-scoped
override, not a silent change to user-owned validation.

```sh
node scripts/configure-department-current-set.mjs \
  --report=reports/department-current-set-preflight.json
```

Review the generated fingerprint and blockers. After the separately reviewed
current-set migration bundle SHA is recorded, its dry-run-first installer is:

```sh
node scripts/apply-department-current-set-migration.mjs
node scripts/apply-department-current-set-migration.mjs \
  --apply --review-sha256=<exact SHA printed by dry run>
```

The migration installer includes the two historical migrations, the
direct-workforce config-v2 migration
`20261103_department_current_set_direct_workforce.sql`, and the required
Department→Organisation authorization migration
`20261104_department_current_set_department_organisation_auth.sql`. Only
after the reviewed schema-only bundle has created
`department_current_set_config`, its relationship-pin assertion, tenant lock,
both authenticated load/reconciliation wrappers, and the Department Organisation
authorization fence, a newly generated and reviewed post-publish preflight
report is required for the guarded configuration transaction. The
configuration transaction independently verifies those exact RPC signatures
and the Department→Organisation authorization function before it can require
authentication or insert config:

```sh
node scripts/configure-department-current-set.mjs \
  --apply --application-published \
  --review=reports/department-current-set-preflight.json \
  --report=reports/department-current-set-apply.json
```

The migration bundle creates the dedicated configuration table and trusted
current-set RPCs. The apply operation
backs up the full pinned form and current-set config under `.local/backups/`,
changes this currently public form to require sign-in, raises both Workforce and
Equipment repeatable row maxima to 100, then inserts the exact config only when
no config exists. The report discloses the authentication change and records
whether every Department has exactly one active `survey_respondent` assignment;
the rollout never changes those assignments. It makes the form/config changes in
one locked PostgreSQL transaction. An existing config must exactly match; drift
fails closed. It uses destination project
`lvmzliemqnieeoruhkik` only, verifies the preflight fingerprint again, and
postchecks the saved form/configuration. Any reviewed-state drift stops the
write.

This is a staged configuration rollout, not a publish action. The reviewed
migration installer is a **schema-only** step and must not be treated as form
activation. Publish and verify the new API/client Department picker and
authentication-reset changes after the final SQL tests, then run a new
read-only preflight. Only then may an operator run the configuration command
with its explicit `--application-published` acknowledgement. The transaction
uses the configured-tenant current-set lock (not a fragile Department-only
lock), while versions remain Department-specific. It preserves the saved draft
and publication state and never automatically publishes the form.

The preflight reports, but does not repair, the live respondent assignment
shortfall (currently 142 Departments with no assigned respondent and 7 with
multiple respondent assignments). It also reports the new SQL-aligned
Organisation fence: exactly one active required `organisation` parent
definition, exactly one real tenant-local Organisation parent per Department,
and exactly one respondent in that same Organisation. These counts are review
evidence only; respondent and Department→Organisation assignments remain
untouched.

The configuration does not change the prepared BNMS workforce CSV import, its
source, provenance ledgers, approval commitment, or files. Since this rollout
changes related metadata, repeat that package’s required destination audit and
final review before any separately approved import execution.

## Exact reviewed commands

Run the migration review only after the backend agent has supplied the direct
config-v2 migration under `supabase/migrations/`:

```sh
node scripts/apply-department-current-set-migration.mjs
node scripts/apply-department-current-set-migration.mjs \
  --apply --review-sha256=<exact-SHA-printed-by-the-preceding-command>

node scripts/configure-department-current-set.mjs \
  --report=reports/department-current-set-preflight-v2.json
node scripts/configure-department-current-set.mjs --apply --application-published \
  --review=reports/department-current-set-preflight-v2.json \
  --report=reports/department-current-set-apply-v2.json
```

The second and fourth commands are writes. Do not run the separately prepared
workforce import from this rollout procedure.

## Verification and safety checks

The `department-current-set` validation workflow runs the focused service,
submission, draft, configuration, routing, and disposable PostgreSQL tests.
The database suite creates a local temporary cluster; it never tests mutations
against the destination database.

With the application workflow running, run the isolated browser fixtures with:

```sh
npx playwright test --config=tests/department-current-set.config.mjs
```

These fixtures intercept API traffic and block unexpected writes. They do not
replace the post-deployment check with a real authorized respondent.

The reviewed form contract rejects incompatible mapped-field changes and
oversized current sets before prefill can be treated as complete. The existing
conditional decommissioning-year question remains conditional: when it is
hidden, existing values are preserved and new hidden answers are ignored.
Whole-section removal still requires complete loaded arrays and explicit review;
a hidden section or failed load cannot authorize archival.