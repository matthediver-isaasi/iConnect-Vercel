# Department current-set rollout

`scripts/configure-department-current-set.mjs` is the narrow, destination-pinned
configuration step for BNMS form `8b6f44d3-83f8-449e-9496-b10b1dc28e5f`.

> **Retirement notice:** This prepared rollout is superseded by the direct
> Workforce Row → Department parent model. It is not an enablement or migration
> instruction: a future reviewed rollout must first adapt its relationship
> contract to that direct parent. Preserve this prepared history; do not rewrite
> the import artifacts or migrations.

It is dry-run-first. It fully pages the relevant Department, Workforce, Equipment
records and relationship edges, verifies the saved year-only equipment questions,
the one-parent workforce invariant, respondent relationship metadata, all six
backend relationship ID/key pins (including Model→Type), and the largest
Department equipment set. It does **not** create, update, archive, or import
current-set records during a dry run.

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

Only after the reviewed migration bundle has created
`department_current_set_config`, its relationship-pin assertion, tenant lock,
and both authenticated load/reconciliation wrappers, the same unchanged
preflight report is required for the guarded configuration transaction. The
configuration transaction independently verifies those exact RPC signatures
before it can enable the form or insert config:

```sh
node scripts/configure-department-current-set.mjs \
  --apply \
  --review=reports/department-current-set-preflight.json \
  --report=reports/department-current-set-apply.json
```

The migration bundle creates the dedicated configuration table and trusted
current-set RPCs. The apply operation
backs up the full pinned form and current-set config under `.local/backups/`,
enables authenticated access for this sensitive form, raises only the Equipment
repeatable row maximum to 100, then inserts the exact config only when no config
exists. It makes those two changes in one locked PostgreSQL transaction. An
existing config must exactly match; drift fails closed. It uses destination project
`lvmzliemqnieeoruhkik` only, verifies the preflight fingerprint again, and
postchecks the saved form/configuration. Any reviewed-state drift stops the
write.

This is a staged configuration rollout, not a publish action. Deploy the
application code that invokes the authenticated current-set wrappers first; only
then apply the reviewed migration bundle and configuration. The transaction
uses the configured-tenant current-set lock (not a fragile Department-only
lock), while versions remain Department-specific. It preserves the saved draft
and publication state and never automatically publishes the form.

The configuration does not change the prepared BNMS workforce CSV import, its
source, provenance ledgers, approval commitment, or files. Since this rollout
changes related metadata, repeat that package’s required destination audit and
final review before any separately approved import execution.

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