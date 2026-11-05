# Cross-event registration search verification

## Confirmed failure

Read-only verification on 2026-11-05, for the reported site
`https://bnms.dev.iconn.app/EventRegistrationReport`:

- Vercel project metadata identified the preview deployment and its `dev.iconn.app`
  aliases. The shared preview `SUPABASE_URL` resolves to `vault.iconn.app`.
- Workspace runtime `SUPABASE_URL` matches SOURCE, not DEST. No settings were
  changed; SOURCE was not used to validate the fix.
- DEST is pinned to `lvmzliemqnieeoruhkik.supabase.co`. The deployed database
  hostname accepted the existing DEST credential for the read-only replay.
- The new booker/member projections and tenant filters succeeded against DEST.
- Baseline handler replay against `vault.iconn.app` failed in
  `attendance_current_outcome`: HTTP 400, request URL length 32,496.
  The gateway did not supply a structured provider code. The ordinary report
  catch returned HTTP 500 for both Sarah and a deliberately unmatched name.

The failure happens before name matching. It is not caused by substring semantics
or missing identity columns.

## Change

Attendance outcome and participant-match reads now batch booking IDs and
intersect selected target IDs locally. This avoids sending both complete ID
lists in a URL. All batches page until empty with unique ordering, including the
composite outcome key (that table has no `id` column).

Target discovery, labels, sync state and intervals also use bounded, paged reads.
Required lookup failures remain explicit. Diagnostics retain the query stage,
allowlisted provider code and HTTP status, not provider messages, identities,
query values, raw URLs or credentials.

## Verification

- 23 focused Node tests passed:
  `node scripts/run-isolated-tests.mjs node --test api/reports/public-invoice-po.test.mjs api/reports/event-registration-columns.test.mjs shared/eventRegistrationSearch.test.mjs`
- The new large-ID Sarah regression was executed against the baseline handler
  from Git: it failed with `500 !== 200`. It passes with the fix, including a
  match and attendance outcome beyond the first 100 bookings and beyond the
  fixture's two-row server page cap.
- Existing tests cover guest, separate booker, member and recorded purchaser
  matching, standard/complex events, combined filters, full-group summaries,
  tenant isolation, literal characters, and separate public Invoice/PO behavior.
- Read-only replay of the fixed actual handler against the deployed database
  hostname returned HTTP 200, 9 groups / 9 bookings for Sarah, and HTTP 200 with
  zero groups / bookings for the no-match probe.
- Replay uses actual check-in and enrichment helpers. It refuses non-GET/HEAD
  database requests and prints counts and safe diagnostics only:
  `node scripts/verify-registration-search-readonly.mjs --bnms-read-only --deployed-db-host`
  Add `--baseline` to replay the current Git HEAD handler instead of the worktree.
- Both baseline and fixed runs reported the existing optional
  `teams_attendance_binding` absence (`PGRST205`). It is not the fatal operation;
  no schema change was made.

## Boundaries

The replay supplies a fixed authorized BNMS context inside the diagnostic
process; it does **not** forge a live session, change runtime auth, or exercise
the signed-in HTTP boundary. No app deployment, database writes, environment
changes, schema changes, payment operations or emails were performed.

The existing Playwright fixture suite was attempted. Its full run timed out
after several UI assertion failures. A focused person-filter run reached
“Page 1 of 2” and verified the name/email request, then timed out waiting for
`button-next-page`; CSV/pagination browser verification therefore did not pass.
The Node isolation runner cannot run browser processes, so the fixture-only
browser run used its own network-interception harness.

The local unauthenticated screenshot remained in the loading/access-resolution
state with legacy workspace tenant errors; it is not evidence of the signed-in
report. The changed report code is ready for merge, but the deployed signed-in
UI has not been verified and this branch has not been deployed.
