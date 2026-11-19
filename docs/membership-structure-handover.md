# Membership structure handover

## Verified cause and limits of the evidence

Read-only destination inspection on 19 November 2026 found **three** GFI University organisation versions:

| ID | Start | End before correction | End after correction |
| --- | --- | --- | --- |
| `8a0c4c3d-05d1-4d33-9b08-66f0d772cae3` | 1 August 2025 | 31 July 2027 | **31 July 2026** |
| `696d519c-31af-43b9-983f-fa68a31ffa16` | 1 August 2026 | 18 November 2026 | unchanged |
| `e2c49e80-c08d-4d82-bd3d-9f37b874fd31` | 19 November 2026 | open-ended | unchanged |

All three belong to GFI tenant `fd82da65-aab7-4a5c-85b8-b2febeb2003d`,
organisation field `e5ac547d-edb1-4ff1-83ab-fc82c1813065`, value `University`.
All use fixed-date membership years starting 1 August.

The immediate predecessor was already correctly closed on 18 November. Its
last update at `2026-11-18T15:27:20.349Z` precedes the newest version's creation
at `2026-11-18T15:27:20.649Z`. The oldest version's last update was
`2026-06-03T12:13:03.832Z`; the middle version was created at
`2026-06-03T12:13:04.027Z`. These timestamps establish that the overlap was
older than the newest handover; they do **not** establish the original start
date or which historical request produced it. There was no pre-existing
dedicated structure schedule audit in the inspected database.

The failing path is reproducible: with two already-overlapping versions, the
old creation path capped only the first current row, leaving the older row
active. It also changed start dates without coordinating the predecessor,
ignored finite-ended future versions, omitted entity type from scope matching,
deleted pending versions and persisted child settings separately. These are
confirmed code defects, not a claim to have reconstructed the historical HTTP
request or the exact earlier deployed code.

Because the live relationship differed from the original two-version plan,
the owner was asked to clarify and explicitly approved **31 July 2026** for
the oldest version. Ending it on 18 November would have retained an overlap
with the middle version.

## Implementation contract

- A timeline is tenant + member/organisation type + scope field + normalized
  match value. Unscoped member and organisation structures are independent.
- Inclusive dates apply: predecessor ends `successor start - 1 day`.
- Creation and duplication insert a version into the ordered timeline,
  retaining all existing versions, including finite-ended scheduled versions.
  Existing overlapping boundaries within that scope are capped. Intentional
  non-overlapping gaps are not filled.
- An editable open-ended version can move its start date without crossing a
  neighbour. Its attached predecessor boundary follows that move, earlier or
  later. A same-day duplicate is rejected.
- Retained finite-ended versions remain read-only even when currently Active.
  Change scope by duplicating; the editor disables scope changes on saved
  versions rather than moving an existing historical timeline between scopes.
- `save_membership_structure` saves configuration, bands, discounts, VAT
  overrides, reminders and audit evidence in one transaction. Child insertion
  failures roll back all of them, including predecessor changes.
- A tenant-level transaction advisory lock serializes concurrent saves,
  including previously empty scopes. A matching table trigger covers legacy
  writers; a deferred constraint trigger rejects overlaps at transaction end.
- Browser roles cannot call the save RPC or access schedule audit records.
  The API still requires tenant administrator authorization.
- Lifecycle badges use inclusive effective dates, including Scheduled versions
  with finite end dates. Existing date-aware pricing resolution is unchanged.
- No membership-year calculation, saved commitment, purchase, invoice, mandate,
  collection amount or renewal rule is changed.

## Destination application and exact correction

Applied to verified destination `lvmzliemqnieeoruhkik` on 19 November 2026:

- Migration: `supabase/migrations/202701220001_membership_structure_handover.sql`
- Runner: `scripts/apply-membership-structure-handover.mjs`
- Reviewed combined SQL/runner/correction-mode SHA-256:
  `ce23c1dc57a056bc089563f69085cdad0062fdb94b78419188a108033b41a343`

The runner defaults to offline review. Live access is pinned to DEST, uses the
provider CA with certificate/hostname verification, and never falls back to
SOURCE. The exact correction was rehearsed with rollback, then committed.
Post-commit read-only verification confirmed function bodies, service-only
grants, enabled triggers and the three dates.
The actual configuration resolver was also run read-only against DEST for
31 July, 1 August, 18 November and 19 November 2026: exactly one University
version applied on each date, with the expected predecessor/successor selected.
The fixed year calculation remained 1 August 2026–31 July 2027. A post-commit
replay rehearsal reported `changed:false` and rolled back without data writes.

The correction changed **only `effective_to` on the oldest version**, not
even its `updated_at`. Before/after rows are retained in service-only
`membership_structure_schedule_audit` under operation
`gfi-university-approved-2026-07-31`. Every configuration across all tenants
was compared before commit to reject changes outside that single field.
No other tenant timeline was normalized. SOURCE was untouched.

```sh
# Offline: review the current exact hash before applying any changed runner.
node scripts/apply-membership-structure-handover.mjs --correct-gfi
# Read-only verification of the already-applied schema and correction.
node scripts/apply-membership-structure-handover.mjs --verify --correct-gfi
# A replay rehearsal must report changed:false and roll back.
node scripts/apply-membership-structure-handover.mjs --rehearse --correct-gfi --review-sha256=<reviewed-hash>
```

Changing SQL or runner content changes the hash. Rehearsal/apply require the
matching reviewed hash; neither is an implicit startup or deployment action.
Replay requires matching audit evidence and rejects identity/schedule drift.

## Verification and rollout boundary

```sh
npm run test:membership-structure-handover
npm run build
```

The focused suite covers API authorization/RPC wiring, lifecycle boundaries,
finite scheduled neighbours, duplication, earlier/later permitted date edits,
same-day rejection, tenant/entity/field/value separation, existing overlaps,
concurrent empty-scope creation and edits, direct legacy write rejection,
child-save rollback, idempotent correction, fixed-year boundaries and unchanged
synthetic financial evidence. PostgreSQL tests use disposable UNIX-socket
clusters; API tests use in-memory mocks. They never charge or send emails.

Live verification is separate: the authorized destination schedule correction
and schema are applied, but matching application code still needs normal merge
and release. No application was published during this work. The local preview
continues to report the existing `Tenant not found` error against legacy SOURCE,
so authenticated administrator UI was **not** visually verified. No auth bypass
or live test purchases were used.
