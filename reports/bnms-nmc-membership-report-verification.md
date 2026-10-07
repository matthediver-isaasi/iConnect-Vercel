# BNMS NMC Membership Report

## Scope and data contract

Read-only BNMS report, pinned to tenant `ff2df806-b321-4254-b651-3af11fccf1db`.
It does not alter journal access, renewal enforcement, financial evidence or membership records.

The report reads member-scoped active definitions for `member_class`, `title`,
`membership_status`, `ym_date_membership_expires`, and the six `nmc_address_*`
fields. Missing/duplicate definitions fail the entire report. Missing address
values remain blank; duplicate custom values require review.
Organisation names resolve only from the member's tenant-owned organisation.
Phone is the member's mobile, otherwise landline, always stored as text.

The owner confirmed:

- Class, never role, controls print allocation. Non-NMC classes are Online-only.
- Imported Active status plus legacy custom-field expiry, without history, is
  insufficient evidence and requires review.
- Active Honorary records without history or expiry are recognised non-expiring.

Other eligible membership evidence is retained paid dated history, an active
live partially paid instalment agreement with dated history, a precisely bound
administrative recognition with dated history, or the existing narrowly reviewed
BNMS expiry-only backfill history contract. A missing start date is never invented.
Administrative recognition does not assert provider settlement.
Superseded history cannot revive a commenced cancelled/unpaid successor.
Future terms do not replace today's term.

Membership evidence is positive: DD status or retained DD history is neither
sufficient evidence nor an exclusion of independently proven membership.
Applicants, contacts without membership evidence, sample/test commitments and
anonymised/deleted members do not enter fulfilment. Other unsupported evidence
is counted for review, not inferred from login, role or absent expiry.

## Dates and output

Each request captures one UTC date. Expiry is inclusive; expiry + 90 calendar
days is included, day 91 is not. Completed months use calendar anniversaries
clamped to the last day of shorter months; active members have zero.
The workbook has exactly four sheets, each with headers even when empty.
All contact/address/name cells are explicit XLSX string cells with no formulas.
Review diagnostics are separate UI counts, not a fifth workbook sheet.
Preview and download each load current data; changes between requests can change
the counts. Historical as-of reporting is deliberately unsupported.

## Verification

`npm run test:nmc-membership-report` covers classification, expiry boundaries,
month ends/leap years, recognition binding, legacy authority, successors,
exclusions, missing/duplicate data, pagination under reduced provider caps,
1,207-member workbook round-trip, literal text and API access controls.
Both report and administrator permissions include individual member exclusions,
so an individually revoked administrator cannot preview or download the workbook.
Tenant-user administrator handling remains unchanged.
Mounted UI tests use isolated fixture identity hooks and mocked fetch; no
application authentication bypass or production session is created.
Production build passed. The development workflow starts and the running report
API returns HTTP 401 without authentication. A screenshot of the protected route
could not verify the signed-in UI: the workspace's existing legacy SOURCE
database cannot resolve the tenant and the browser has no signed-in session.
This was not worked around by changing auth or retargeting the development DB.

Read-only production DEST audit on 2026-10-07:

| Worksheet | Members |
| --- | ---: |
| Full and Full Junior | 242 |
| Associate Honorary Retired | 0 |
| Trainee and LMIC | 0 |
| Online-only | 219 |
| **Total** | **461** |

Review: 846 missing membership evidence, 8 missing class, 1 unproven membership
evidence. Excluded: 2,519 nonmember contacts, 117 deleted identities,
4 applicants, 5 sample/test records. These are date-specific aggregate
observations, not pinned future counts. No member PII was printed or exported.
The rerunnable audit is `node scripts/audit-bnms-nmc-report.mjs`.

## Database and delivery

No migrations are required or applied to any database; none are outstanding.
No database writes or production deployment were performed.
The permission is registered in the canonical role map and generated backend
hierarchy; role-management database overlay entries are not required for access.
The existing portal uses validated member sessions for its UI; standalone
tenant-user dashboard sessions have no member-role representation in that UI.
The API follows existing tenant-user admin and member-admin authorisation.
