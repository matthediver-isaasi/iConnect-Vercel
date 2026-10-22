# Organisation Region report verification

## Implementation

Linked Organisation report columns use an explicit `preference_field_id`
reference. Metadata discovery and projection enforce tenant ownership,
organisation scope, active status and the existing administrator-only core
report access policy. Core fields retain their existing references and report
versions are not upgraded implicitly. Preview and CSV export use the same
batched projection and organisation value formatting.

## Destination evidence

Read-only verification on 2026-10-22 used the pinned destination project
`lvmzliemqnieeoruhkik`, tenant `ff2df806-b321-4254-b651-3af11fccf1db`.

- Current report: `r_mv134nau_j0a4dp`, “Department member count with survey responder”, version 7.
- Organisation Region: active dropdown `91e58f93-f78f-465e-948b-c4808aecd89c`.
- Current report includes two filters not present in its historical fixture.
  Both are preserved along with all other existing settings.
- Candidate version 8 inserts Organisation Region immediately after the existing
  linked Organisation Name column, using its unchanged traversal.
- All 253 rows retained their identities, order and existing column values,
  including member counts, responder designation and aligned responder identity.
- 246 rows have a region; seven remain blank. Region values agree with an
  independent destination SQL projection.
- Before-settings snapshot is in the ignored, private generated-artifacts
  directory; no personal report results were written into repository files.

## Checks

- Backend service/route suites: 193 tests passed.
- Client report helper/filter/mounted suites: 47 tests passed.
- Served local real-component browser fixture: Region discovery, selection,
  saving and reopening passed. API/schema/save storage are isolated fixtures,
  not authenticated live verification.
- Normal local route screenshot shows the workspace's existing tenant-resolution
  error, so it does not verify signed-in BNMS UI.

## Implementation handoff and pending activation

The owner approved handing off the implementation for merge/build separately
from live report activation. Implementation is complete; the live configuration
change and authenticated verification below remain separate follow-up work.

The BNMS served CustomObjectsAdmin bundle inspected on 2026-10-22 does not
contain organisation preference discovery or projection references. Changing
the saved report before the corresponding code is served would make the
existing report unavailable. The guarded application attempt refused to write;
the saved report remains version 7. No deployment was performed.

After the implementation is merged and available on the BNMS site, run:

```sh
node scripts/add-bnms-organisation-region-report.mjs
node scripts/add-bnms-organisation-region-report.mjs --apply --expected-sha256=<fresh-read-only-output-sha256>
```

The runner independently checks the served builder, re-reads the current
definition, verifies Region authority and unchanged report results, and uses
an exact current-settings compare-and-swap. Concurrent changes abort rather
than overwrite other reports. Do not reuse a historical snapshot or digest.
The runner's bundle check is a necessary safety gate, not proof of authenticated
preview/export operation; final signed-in BNMS preview and CSV checks remain
required after activation.

## Database migrations

No schema migration is needed or was applied to any database. The pending
change is one destination tenant's saved report setting, not a migration.
