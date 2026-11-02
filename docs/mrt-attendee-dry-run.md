# MRT attendee import: read-only production validation

## Scope and evidence

Snapshot: **2026-11-02 08:43:27 UTC**. This is validation only, not import approval.

- Verified DEST project: `lvmzliemqnieeoruhkik`, using the existing destination connector's REST/project and SQL host/user pins and verified TLS.
- One `BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ` transaction; `transaction_read_only=on` verified; transaction rolled back.
- SOURCE was not queried. No import runner or mutating endpoint was called. No database writes, provider calls, email sends, reminder scheduling, or application changes.
- Workbook SHA-256: `1b20eb9bc052ff2c5091c803e2932cba0f961d780b56241c2a17f279a39f449b`.
- One sheet, 46 data rows (Excel rows 2–47), 46 unique trimmed case-insensitive emails, no invalid email syntax, missing required fields, formulas or error cells.
- Full row-level reconciliation, profile differences and catalog evidence are retained locally under ignored `private/mrt-attendee-validation/`. Do not publish that directory or its contents.
- Input was absent from the Git index and no input history was found through local `git log --all`; it was already covered by a global ignore rule. Explicit project Git/deployment exclusions were added for the input and private evidence. This does not assert removal from platform upload storage, backups, or inaccessible history.

## Current event and ticket

Event `4a21aa95-0c72-4317-a8eb-638ec73c96b0`:
**BNMS MRT Webinar Series - Horizon Scanning - Clinical Trials and Radionuclide Production**.

Tenant: **BNMS**, `ff2df806-b321-4254-b651-3af11fccf1db`.
Published, online, simple event (`is_complex=false`), **3 November 2026, 18:00–19:00 Europe/London (GMT)**.
Both event-type metadata fields are null; “webinar” comes from the title, not a populated type field.
Waiting list disabled; event seats unset.

One configured class: **Standard Ticket**, `ticket-1779980487486-02ahz`, price **0**, free, default, unlimited, members and public. No release date, role restrictions or group restrictions. Guest member-record creation is false. The configured VAT label does not make this zero-price ticket a payment.

## Reconciliation

| Outcome | Matched member records | Guests | Total |
|---|---:|---:|---:|
| Proposed new registrations | 43 | 3 | 46 |
| Already-booked skips | 0 | 0 | 0 |
| Ambiguous member-email matches | 0 | 0 | 0 |
| Blocked source rows | 0 | 0 | 0 |

Current event baseline: **77 confirmed + 2 cancelled = 79 booking rows**; **0 complex_event_booking rows**. No pending or anomalous status rows. This supersedes the historical 69-booking count.

Every source row was compared with both booking tables, including cancelled rows. No source email overlaps any current booking; no matched member ID overlaps a booking either. Matching was tenant-scoped and trimmed/case-insensitive, with multiple matches prohibited. All 43 matched records have status active; that is not proof of paid membership or consent. Their stored emails exactly match the normalized source emails. No linked organisations cross tenants.

Guest rows: **6, 8, 31**. All other Excel rows **2–47** are uniquely matched member records and proposed new registrations.
If approved and unchanged, 46 inserts would produce **123 confirmed / 125 total** bookings, retaining the two cancellations.

## Field mapping and precedence

| Workbook column | Normalized import field | Proposed booking handling |
|---|---|---|
| First_Name | first_name | Guest attendee_first_name; member profile first_name otherwise |
| Last_Name | last_name | Guest attendee_last_name; member profile last_name otherwise |
| Email Address | email | Trim/lowercase for matching; existing member email for matched records |
| Organization/Institute | organization | Guest guest_organisation_name; existing organization_id for matched records |

No source job title, designation, payment, consent or attendance fields exist. Do not infer them.

All 43 matched names agree exactly. **35 organisation differences**:
- **27** have no linked organisation: rows 7, 10, 11, 13–20, 22, 24, 27, 28, 32, 34–39, 43–47.
- **8** have a differently worded existing organisation: rows 9, 12, 21, 23, 25, 29, 30, 33.
- The other **8** member organisation names agree after trim/case normalization.

Exact uploaded/existing comparisons are private. The existing endpoint ignores uploaded organisation values for members; the 27 missing links therefore remain empty, not filled from this workbook. Proposed policy: retain existing profiles and organisation links unchanged, preserve workbook evidence privately, and explicitly accept this loss of organisation detail on the new booking. Any alternative requires a separately approved mapping approach, not profile updates.

## Proposed registration semantics

Subject to separate approval:
- Insert into `booking`, not `complex_event_booking`.
- Explicit Standard Ticket ID/name, `status='confirmed'`, `ticket_price=0`, `payment_method='admin_import'`.
- Matched members retain member_id and existing organization_id; guests have null member_id/organization_id and is_guest_booking=true.
- Registration only: no paid claim, attendance/check-in, membership activation, CRM creation/update, consent changes, invoice, payment or Zoom change.
- Re-read identity, ticket, member matches, booking states, notifications and trigger configuration immediately before execution.
- Skip an existing unambiguous active registration; hold cancelled-only matches, multiple members/bookings, null/unknown statuses, cross-tenant conflicts or changed identities for review. Never reactivate a cancellation automatically.
- Use a serialized/idempotent execution plan. The live simple booking table has no event+email unique constraint; endpoint duplicate checks alone are raceable.

## Why ordinary import is not a silent operation

Reviewed `api/admin/events/[eventId]/attendees/import.js`, live booking columns/defaults, constraints, indexes and trigger definitions, plus the separate complex-event booking path:

- Confirmations default **on**. An enabled booking-confirmation template exists.
- The endpoint calls `scheduleEventFollowUps` after each insert even when confirmations are disabled. This event currently has no follow-up template, but that is mutable configuration, not a suppression guarantee.
- Enabled reminders exist for **one day before** and **one hour before** the event: nominally **2 November 18:00 GMT** and **3 November 17:00 GMT**. Confirmation-off does not authorize or suppress these independent communications. No reminder delivery or queue mutation was attempted.
- Live confirmed-insert triggers enqueue **registration badge and CPD-points outbox work**, regardless of whether a matching rule exists. Currently there are no badge rules and the only active points rule is **attendance-based, 1 point**. Registration is not attendance or an entitlement to that point.
- The booking `badge` default is true. No check-in timestamp should be supplied.
- Live member_id is nullable and admin_import is not blocked by a payment-method check constraint, despite the older JSON schema suggesting otherwise.
- The endpoint uses exact stored-email lookup and only the simple booking table for duplicates; this dry run deliberately used stronger normalized, cross-table checks.

## Decisions required before any live import

1. Approve all 46 registrations on the free Standard Ticket as confirmed admin imports, with existing member profiles authoritative and no CRM updates.
2. Accept the 35 organisation differences, including 27 blank member organisation links, or request a different booking-only mapping proposal.
3. Choose whether confirmations and the two configured reminders are authorized. “No communications” needs a separately verified suppression plan; setting send_confirmations=false alone is insufficient.
4. Explicitly address registration badge/points outbox effects in the execution plan. Do not disable global triggers or assume absent registration rules mean zero writes.
5. Approve the duplicate/changed-state policy above and a fresh pre-execution reconciliation.

**Stop here: no live import is authorized or performed.**
