# Event CPD certificate policy handoff

The event certificate settings do **not** issue certificates. They select a
template and the activity dates independently of CPD points and badge rules.
Use the server's `resolveEventCpdCertificate(db, { tenantId, eventType, eventId,
ticketId })` from `api/_lib/eventCpdCertificateRules.js` when implementing
issuance. `eventType` is `simple` or `complex`; `ticketId` is the persisted
ticket class ID, not a display name. The resolver verifies tenant ownership of
the event and ticket, loads `event_cpd_certificate_config`, obtains the
selected tenant template and calls the pure
`resolveEventCpdCertificatePolicy` in `shared/eventCpdCertificatePolicy.js`.

## Immutable issuance boundary

At issuance, persist the resolved template ID/version, source hash, date-only
start/end, formatted values and provenance in the immutable issuance record.
Also retain an immutable copy of the PDF source and placeholder layout used
to render it: the current template source path is mutable and can be deleted
by later template edits. Never regenerate an issued certificate by rereading
current event settings or the current template. Resolve and snapshot under the
issuance transaction/concurrency strategy; this resolver does not establish
award eligibility or verify daily attendance.

## Migration and verification

`20261119_event_cpd_certificate_config.sql` was applied on 28 September 2026
to verified DEST (`lvmzliemqnieeoruhkik`) using the pinned destination runner.
SOURCE was not modified. No migration for this feature remains outstanding.
Logic, API, mounted component and disposable PostgreSQL tests cover this
configuration contract. Local full-app preview remains blocked by the legacy
SOURCE database lacking the tenant table; it is not authenticated production
verification.

The server resolver returns `available`, `reason`, `template_id`, version/name,
source hash/path, `start_date`, `end_date`, `placeholders`, and `provenance`.
`reason` may be `invalid_policy`, `no_template`, `template_unavailable`,
`template_inactive`, or `date_unavailable`. Issuance must fail closed unless
`available === true`; in particular, an archived/missing selected template
must not silently fall back to another one. An absent end date is a single
date, not a missing-data error. Dates are date-only in the event timezone; a
custom ticket date range can override event dates independently of its
template mode. Both custom date endpoints must be valid Gregorian `YYYY-MM-DD`
dates, with end >= start if present.

**Placeholder integration:** Before rendering, derive placeholder values
from the resolved result with
`certificateDatePlaceholderValues(policy)` exported by
`shared/eventCpdCertificatePolicy.js`. This includes
`cpd.activity_date` (the original single start date),
`cpd.activity_date_range` (start only for a single day, or both complete dates
separated by an en dash), and independently placeable
`cpd.activity_start_date` / `cpd.activity_end_date`. The combined range is
preformatted **text**, not a date value: do not set a date format on that
placeholder or parse the combined string. The browser's
`certificateDateRangeValues` in `client/src/lib/cpdCertificateContract.js`
delegates to the same mapping. Merge resolved placeholders with other
certificate values, but do not replace these resolved dates with raw UTC
timestamps. Designer sample/preview PDFs use illustrative field samples only.

The admin settings endpoint is `GET/PUT /api/admin/event-cpd-certificate-rules`
(`api/admin/event-cpd-certificate-rules.js`), with `event_type` and `event_id`
as GET query parameters or PUT JSON fields. PUT also requires `config`.
GET returns `{ config, templates }` including explicitly unavailable
selections; PUT returns `{ config }`. It requires an authenticated event
administrator and tenant-scopes all events, tickets, and active templates.
It rejects template IDs not active in this tenant and writes using
`replace_event_cpd_certificate_config`. The template library and PDF render
endpoint are separate; this admin endpoint does not render or issue.