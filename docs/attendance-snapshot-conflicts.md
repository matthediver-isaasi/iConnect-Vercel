# Attendance snapshot conflicts

## Read-only findings — 18 November 2026

Inspected the installed `replace_attendance_report_snapshot(uuid,text,text,jsonb)`
and the interval uniqueness constraint on the verified destination
`lvmzliemqnieeoruhkik`. No live writes or provider report requests were made.

The constraint is `(tenant_id, provider, attendance_target_id, participant_key,
interval_key)`. The installed function already holds a transaction advisory lock
for the tenant/provider/target before replacing intervals. Successful run replays
return without inserting facts or transitions again.

A bounded three-row sample of PostgreSQL 23505 logs identified Zoom rows with
`participant_key = provider:anonymous:<join timestamp>` and
`interval_key = anonymous:<same join timestamp>`. All three came from the interval
INSERT inside the snapshot RPC, called through PostgREST. UUIDs and emails were
redacted before displaying evidence. A last-24-hour aggregate during investigation
counted 576 errors at this RPC insertion context; the task's earlier baseline was
574 errors and 574 HTTP 409s. These are different observation windows, not a
before/after rollout comparison.

The Zoom adapter skipped deduplication for rows without an email, but generated
their keys from only the anonymous label and join timestamp. Separate people
joining in the same second consequently collided inside one transaction.
The evidence establishes normalization failure, not a serialization failure.

## Correction

- Generate interval identity before deduplication, using the provider participant
  ID when available (without treating it as a booking/registrant credential).
- Retain every occurrence when there is insufficient stable identity. A
  content-derived anonymous key plus occurrence index preserves indistinguishable
  legitimate people; reordering the same multiset keeps the same snapshot key.
- Preserve identified reconnect intervals and the existing longest-duration
  selection for repeated identified joins.
- Canonicalize exact repeated keyed intervals in the shared attendance engine
  before totals, snapshot hashing and persistence. Conflicting duration, times,
  email or provider identity for one key fail explicitly before any RPC write.
- Keep internal key bookkeeping out of the legacy Zoom ledger.

No database migration is needed: the installed uniqueness, target serialization,
atomic replacement and transition/outbox rules remain unchanged. Direct malformed
RPC calls still fail atomically rather than silently discarding conflicting rows.
No existing attendance data is deleted or rewritten by this change.

## Isolated verification

Run:

```sh
node --test api/_lib/attendanceEngine.test.mjs api/_lib/zoomAttendanceReadiness.test.mjs api/_lib/zoomAttendanceIdentity.test.mjs api/_lib/teamsAttendanceService.test.mjs scripts/attendance-snapshot-conflicts.postgres.test.mjs
```

The PostgreSQL test starts a disposable Unix-socket-only database without using
workspace database credentials. It installs the real attendance table and RPC
definitions, including the two already-installed target-conflict and service-role
repairs; unrelated historical backfills are deliberately excluded.

Coverage includes simultaneous anonymous joins, repeat identified rows, reordered
reports, duplicate input without inflated totals, sequential replay, overlapping
same/different snapshots from two connections, tenant/provider isolation, rejoins,
and rollback after interval replacement but before outcome publication.
Repeated snapshots do not duplicate outcome revisions or reward-triggering outbox
rows. No worker or external reward provider is invoked; this is not a live CPD
delivery test.

## Rollout and historical recovery — not performed

The code is prepared for merge, not deployed. Before rollout, confirm the current
production function/constraint still match the inspected contract. No SQL apply
step is required.

After an explicitly approved rollout, compare equal-duration log windows for:

1. 23505 errors at the interval insert in the snapshot RPC.
2. HTTP 409s for `/rest/v1/rpc/replace_attendance_report_snapshot`.
3. Successful snapshot runs and remaining failed target counts.

Use counts and redacted identity categories, not full participant payloads.
Zero errors without successful report traffic is not evidence of recovery.
New keys can change idempotency hashes; unchanged outcomes still must not create
new revisions or transitions. Newly recoverable snapshots can create first-time
attendance transitions and therefore trigger configured rewards.

Historical reports may require retries if scheduled collection no longer reaches
them. Inventory affected targets read-only after rollout; check whether each has a
later successful snapshot and whether awards were intentionally withheld. Obtain
separate approval for any historical report fetch/replay, data repair, or reward
issuance. Do not blindly replay previously withheld or ambiguous deliveries.
