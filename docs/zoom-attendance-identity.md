# Zoom attendance identity

The attendance adapter now reads the complete approved registration list before
publishing a successful report. Registration lookup errors or pagination
truncation fail closed rather than publishing partial attendance or false absences.
Meetings explicitly reporting registration disabled retain ordinary email matching.

Matching order:

1. An explicit report `registrant_id` must resolve within this meeting's approved
   registrations. Prefer the booking's persisted Zoom registrant ID; otherwise use
   the registration's email, rejecting conflicting persisted booking IDs.
2. Without a report registrant ID, reconcile its email against the registration
   list, then use that registration's ID/email to resolve the booking.
3. If no registration matches that email, retain exact booking-email matching.

Never interpret Zoom account `id`, `user_id` or `participant_user_id` as registrant
IDs. Never infer identity from names. Duplicate registration emails, duplicate
booking identities and conflicting evidence remain unresolved/ambiguous.

Only unambiguous matches are aggregated to one booking identity across rejoins;
ambiguous registrants are not merged into another attendee's duration. Internal
matching objects and join links are not written to the legacy attendance ledger.
Provider-neutral intervals retain the identity source and provider registrant ID
where available. The existing atomic snapshot and outcome-fingerprint guards
prevent unchanged attendance from awarding again.

## Recovery evidence

The approved BNMS event reconciliation on 3 November 2026 found 132 approved
Zoom registrations and 132 confirmed bookings. The Zoom report supplied 43
distinct email identities and no explicit registrant IDs. The improved matcher
did not establish any additional attendee matches: 39 qualifying, 1 below threshold,
90 with no matched report identity and 2 ambiguous booking rows remain.
The two ambiguous bookings share the same attendee email; two other Zoom
identities have no matched booking. Do not cancel a duplicate or assign those
identities based on names without separate approval.

The live reprocessing changed no outcome fingerprints or revisions. This does
not prove that all 90 unlinked bookings represent non-attendance; Zoom's report
does not expose personalised-link identity in every case.

Tests:

`node --test api/_lib/zoomAttendanceIdentity.test.mjs api/_lib/zoomAttendanceReadiness.test.mjs api/_lib/attendanceMatching.test.mjs api/_lib/attendanceEngine.test.mjs`

No schema migration is required. Deploy the matching application code for future
scheduled syncs; live reprocessing with workspace code is not a production rollout.
