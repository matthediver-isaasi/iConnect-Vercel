# BNMS approved unexpired membership repair

Owner approved administrator-confirmed paid status for 72 reviewed Full/Full Junior members with retained 2027 expiries. This approval excludes the 25 expired members and six DD-evidence cases.

## Production application
- Destination: external Supabase `lvmzliemqnieeoruhkik` (DEST).
- Exact cohort SHA-256: `866ea4e514044eb59174d3d3560d7514c9f6fd62a844170311a59fbf16fc25b2`.
- 72 inserted: 58 Full, 14 Full Junior.
- Dates preserved; unknown starts, amounts and invoice links remain null.
- History year display: `Legacy membership (start unknown)`, rather than an invented annual interval.
- Transactional dry-run performed actual inserts and rolled them back.
- Committed application preserved every pre-existing BNMS history row.
- Exact replay: zero inserts, 72 verified existing records.
- No provider API calls, collections, invoices, billing agreements, renewal policy assignments or schema migrations.

## Report verification and release
Updated report projection against production data returns Full and Full Junior 315 (previously 243), Online-only 220 unchanged. The report change is separate from the fixed-cycle expiry-only renewal authority: it must not broaden renewal or collection permissions.

16 focused tests passed, including unchanged report boundaries and new attestation rejection cases.

The report code requires deployment; database records are already applied. No schema migrations remain for this repair.
