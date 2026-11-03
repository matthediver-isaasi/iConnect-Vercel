# Attendance snapshot storage repair

Two narrow, sequential migrations repair shared provider-neutral attendance:

- `202612110001_attendance_snapshot_target_conflict.sql`: replace the ambiguous
  `ON CONFLICT (...target_id)` inference with the installed named unique
  constraint. Preserve the function's public return fields and installed body,
  including workflow transition publication.
- `202612110002_attendance_snapshot_service_claims.sql`: use `auth.role()` so
  modern PostgREST JSON claims and legacy individual claims both work. Keep
  anon/authenticated execution revoked and service-role execution granted.

Both were applied to verified DEST on 3 November 2026 with owner approval.
No source database changes or application deployment were needed for these
database-only fixes. Never re-run the old foundational migrations as a repair:
that could overwrite later transition behavior.

## Verification

`node scripts/apply-attendance-snapshot-target-conflict.mjs`

This runs both migrations twice, executes the real RPC as service_role using
modern and legacy claims, checks public-role permissions, verifies duplicate
report reuse and unchanged-outcome revision/transition deduplication, then rolls
back all DDL and diagnostic data. It requires the retained approved event fixture
to still exist. `--apply` commits only the DDL before running rollback-only tests.
Real provider recovery must use the normal Zoom/Teams service, not the diagnostic
snapshot.

The approved Zoom event recovery succeeded through the normal application service.
The resulting 132 booking outcomes were 39 attended, 1 below threshold, 90 absent,
and 2 unmatched, using the configured 20-minute threshold. Participant records and
rejoins are not unique-attendee counts. Existing scheduled workflow/CPD processing
remains responsible for downstream actions; a successful sync does not prove
email or certificate delivery.

Application regressions:

`node --test api/_lib/attendanceEngine.test.mjs api/_lib/zoomAttendanceReadiness.test.mjs api/_lib/attendanceTransitionMigration.test.mjs`
