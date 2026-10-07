# Training agenda timezone correction

## Implementation

Create/Edit Event now use `shared/trainingAgendaBounds.js` for both read-only
overall date previews and submitted timestamps. Agenda dates/times remain local
clock entries; only the derived parent bounds become UTC ISO timestamps. Each
endpoint uses the offset applicable on its own date. Timezone changes recalculate
the bounds. Invalid dates, times, timezone names, DST gaps and repeated minutes
block scheduled training-event saves with an explicit error.

Existing date-only derivation defaults remain 00:00 / 23:59. Existing editor
required-time validation is unchanged. TBC/Immediate suppression, ordinary event
timing, agenda sorting and compensation behavior remain unchanged. Registration
deadline checks use the derived end for training events.

## Authorized live repair — 2026-10-07

- Database: DEST Supabase project `lvmzliemqnieeoruhkik`, verified pooler identity
  and CA-verified TLS. SOURCE was not accessed or changed.
- Tenant: Graduate Futures Institute (`gfi`).
- Event: `2e5ab247-a646-43da-bbb6-4d7a392c5182`.
- Before: `2027-06-10T09:15:00Z` through `2027-07-02T16:15:00Z`.
- After: `2027-06-10T08:15:00Z` through `2027-07-02T15:15:00Z`.
- Timezone: `Europe/London`.
- Reviewed non-bound event/complete-agenda snapshot SHA-256:
  `eb7d4997dce2006ffaae018049a18bd1db9ab417b3db53844917dc802ca547b7`.
- Runner: `scripts/repair-gfi-training-agenda-timezone.mjs`; no args is read-only.
  Apply requires `--apply --review=<snapshot hash>`.
- The serializable transaction changed one event, verified all five complete
  agenda rows unchanged, and compared unrelated event values. A second application
  committed with zero rows changed.
- Only the two bound columns were explicitly updated. No application save
  pipeline, meeting provider, booking, attendance or email API was invoked.
  Existing database content-index invalidation triggers were left enabled.

## Verification

`node scripts/run-isolated-tests.mjs node --test shared/trainingAgendaBounds.test.mjs client/src/lib/eventAgendaPersistence.test.mjs`

13 isolated tests passed, including summer/winter, cross-DST, UTC, Kathmandu,
three runtime timezones, date-only defaults, invalid inputs, save/reopen
derivation, executed editor memo/save assignments and agenda rollback. Both
modified pages also passed JSX compilation. These are not signed-in browser
tests; the signed-in editor UI was not verified.

Separately, live GETs of the public event and agenda endpoints confirmed corrected
UTC timestamps and the unchanged five clock ranges:

| Date | Start | End |
| --- | --- | --- |
| 2027-06-10 | 09:15 | 11:15 |
| 2027-06-28 | 09:15 | 16:15 |
| 2027-06-29 | 09:30 | 16:15 |
| 2027-07-01 | 09:30 | 16:15 |
| 2027-07-02 | 09:30 | 16:15 |

The live page screenshot at
https://gfi.dev.iconn.app/events/employability-and-career-education-strategy-and-inclusive-design-0627
showed June 10–July 2, 2027, **09:15–16:15 (GMT+1)**, equivalent to BST.

No schema migration is needed or was applied. No migrations remain outstanding
for this correction. The data repair is live; the code correction is not deployed
and requires separate deployment approval. Until rollout, the old deployed editor
can still overwrite corrected bounds if this event is saved there.
