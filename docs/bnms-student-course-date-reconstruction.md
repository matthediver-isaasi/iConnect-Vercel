# BNMS Student course-date reconstruction

Applied to verified external DEST on 11 November 2026 with owner approval.

## Outcome

- Created 44 no-charge terms and repaired four uncommitted legacy histories.
- Retained three records requiring dates; excluded 16 deleted records.
- Start: saved Member since, date portion. Inclusive end: saved Student course end date.
- Renewal boundary: the following day; existing 90-day renewal window and grace settings retained.
- Active successor: `8d483acf-1da3-5c5b-a1cd-b8bb030e2c0c`, named `2026-2027 Student`.
- Original `57ba60c8-3703-4b2c-83ae-0cf7f0884cf8` renamed `2026-2027 Student (legacy annual)` and made unavailable for new selection. Its issued membership and immutable snapshot were unchanged.
- Student join, Student join for existing member, and Student renew now reference the successor through `date_membership_config_id`. Their other saved settings, questions, mappings and approval requirements were verified unchanged.

## Database compatibility and safeguards

Applied migrations:

- `202701220001_member_date_rolling_compatibility.sql`: adds a separate no-charge date-term branch to the existing completeness check; exempts validated date-term inserts from requiring fixed-month rolling evidence; retains all other guards; freezes renewal policy and grants the new column to the existing service write path.
- `202701220002_bnms_student_reconstruction_audit.sql`: allows only exact owner-reviewed before/after repairs for the four legacy rows. Runtime credentials cannot write audit authority.

No triggers were disabled. No invoices, provider charges, billing agreements, emails, profile fields or roles were changed. The no-charge terms have zero amounts, settled obligation status and a manual recording method; this is not evidence of a cash payment.

## Verification and operational evidence

Runner: `scripts/reconstruct-bnms-student-terms.mjs`.
Modes: `inspect`, `rehearse` (rolled back), `apply` (requires unchanged rehearsal fingerprint), `verify` (read only).

Private ignored evidence is in `generated-artifacts/bnms-student-reconstruction/`.
`applied.json` retains the reviewed plan and before-state; the four corrections additionally have exact database audit evidence.

Verification covered every reconstructed record, saved dates and prices, unchanged held/issued records, unchanged members/preferences/agreements, portal renewal eligibility at the course-end boundary, and form renewal evidence.
19 automated tests and 28 disposable PostgreSQL checks passed. The live rehearsal additionally rejected price changes, unaudited extensions, evidence clearing, overlapping terms, audit writes by the service role, and changes to the existing annual commitment.

Signed-in portal UI and a real renewal checkout were not exercised. These are database/configuration changes already applied to DEST, not dependent on a frontend deployment. Do not reapply the old reconstruction: use `verify` for the completed cohort and prepare a new reviewed plan if missing dates are later supplied.
