# Outstanding registration-only import

## Destination and scope

Executed against pinned, verified-TLS production Supabase project
`lvmzliemqnieeoruhkik`, tenant `ff2df806-b321-4254-b651-3af11fccf1db`,
event `66050b3c-aa70-4174-8552-0a2af85e5410`. SOURCE was not used.

Workbook SHA-256:
`5fc106677f343951c341536141b7feaf13afe7a7f8cb4265e114e24c4ea68e19`.
Applied manifest SHA-256:
`5e3baed28928c5b308cfde750febdf097a27b6f97c9476bd3e8cc0ab6caf7a82`.

All nine columns, including unnamed correction notes and original row provenance,
were retained. This is not a rerun of the earlier points-awarding importer.

## Outcome

| Source disposition | Rows |
|---|---:|
| New registrations | 64 |
| Already present before import | 0 |
| Merged corrected source duplicates | 2 |
| Remove duplicate exclusions | 4 |
| Do not send exclusion | 1 |
| Unresolved UUID/email conflicts without explicit override | 3 |
| Total | 74 |

New registrations comprise 57 Both Days and 7 Thursday Only. Each has a separate
group reference and deterministic booking ID. Corrected UUIDs and explicit
UUID-over-email instructions use tenant-validated current member details, with
unique recipient-address corroboration. No member identity or role was changed.
The two corrected Friday rows merge into the corresponding corrected two-day
rows. Unresolved workbook rows 2–4 remain unimported, not guessed.

The live event now has 171 registrations: 107 prior rows plus 64 new rows.
Legacy `admin_import` zero-price fields are administrative placeholders, not
financial evidence: actual report normalization returns unavailable totals and
null price paid. No payment, attendance, or free-admission assertion was made.

## Award protection and migration

Applied `supabase/migrations/20261125_outstanding_registration_award_hold.sql`
to DEST production only. No other migration was applied; none remains pending
for this import. No frontend deployment is needed for these database guards.

Each new booking received an immutable service-only hold before its insert in
the same transaction. Both award outboxes suppress held registrations;
points/badge writers and durable artifacts, certificate delivery, and points
reprocessing enforce the hold. Normal bookings and generic survey grants remain
unaffected. Holds were not attached to existing bookings or legitimate awards.
Any future award release needs separate explicit authorization and a reviewed
implementation; this importer cannot release holds.

The rollback-only database integration test passed 27 checks as service_role,
including an unheld control booking's ordinary award. It was rerun after
migration installation and verified rollback of its fixtures.

## Verification and limitations

- Exact new booking rows, 64 holds, independent groups, and no cohort outboxes,
  points, badges, attempts, certificate deliveries, or survey artifacts verified.
- Real `getTargetRecipients` against DEST selected all 64 imported members.
  Its verification fetches allowed only GET/HEAD; no send was invoked.
- All historical fields of 107 prior bookings were preserved, with complete
  rows also checked against the final pre-apply manifest.
- A concurrent schema change added `survey_invitation_revision`; its explicit
  initial value is validated, not inferred as permission to send invitations.
- Fresh dry-run manifest proposes 0 ready, 64 already present, 2 merged,
  5 excluded and 3 unresolved.
- Twenty-nine independent table snapshots remained exactly unchanged, including
  points, badges, award queues/attempts, certificate deliveries, attendance,
  payment/provider evidence, invoice linkage, transactional email and survey
  delivery records.
- Broader live snapshots showed concurrent changes in member, form submission,
  campaign, campaign recipient, and global link-click data; survey entitlement
  differed only by the newly added revision column. These are disclosed in the
  private workbook and are not falsely attributed to or claimed unchanged by
  this import. The reconciliation's explicit concurrent-drift acknowledgment
  cannot waive core booking, award, financial, attendance, or cohort checks.
- Verification establishes production data and actual recipient selection,
  not authenticated browser rendering of the report.

## Private evidence

Ignored `private/annual-meeting/` contains the original baseline, final manifest,
apply result, verification, zero-write dry run, and `outstanding-reconciliation.xlsx`.
The workbook has all 74 rows across 11 sheets, with source values, identities,
recipient decisions, booking IDs, exclusions, unresolved rows, and verification
drift. ExcelJS output was independently read back cell-by-cell, not desktop-tested
in Microsoft Excel.

The source is ignored and absent from the current Git index, but already exists
in inherited history/checkpoints. That history has not been purged.

Operator scripts: `outstanding-registration-import.mjs`,
`outstanding-registration-hold.integration.mjs`,
`verify-outstanding-registrations.mjs`,
`outstanding-registration-reconciliation.mjs` under `scripts/`.