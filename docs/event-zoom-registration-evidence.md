# Event Zoom registration evidence

Read-only verification on 2026-10-27, approximately 07:09–07:12 UTC.

## Production evidence

- Event: `4a21aa95-0c72-4317-a8eb-638ec73c96b0`
- Title: BNMS MRT Webinar Series - Horizon Scanning - Clinical Trials and Radionuclide Production
- Verified destination: Supabase project `lvmzliemqnieeoruhkik`. SQL used a pinned destination connection with verified TLS and `BEGIN READ ONLY`, rolled back afterwards. The workspace SOURCE database was not used.
- Linked local meeting: `527955a4-6e36-492b-9b49-10f62145d2b4`; tenant-scoped join verified.
- Numeric Zoom meeting ID: **95205454839**.
- Live Zoom topic matches the event title.
- Live schedule: **2026-11-03 18:00 Europe/London**, scheduled meeting type 2.
- Cached registration setting: **false**.
- Live Zoom `settings.approval_type`: **2 (registration disabled)**.
- Confirmed bookings: **69**. Eligible email-bearing bookings: **69**; distinct normalized emails: **69**; missing email: **0**.
- Approved, pending, denied, and missing Zoom registrations: **unavailable**, not zero. Each status-specific registrants request returned HTTP 400. No first page was available, so pagination and attendee matching could not be completed.
- Stored change history at `2026-10-27T07:03:57.477Z` claimed registered 0, emailed 0, cancelled 0, errors 0. These are historical application claims, not provider evidence.

The Supabase integration SQL call was permission-denied; the independently configured, pinned destination read-only SQL connection succeeded. Provider reads used the same tenant's credentials from DEST, with destination selected before importing application modules. No credentials, attendee identities or personalised URLs were printed.

## Recovery boundary

No live Zoom setting changes, registrations, cancellations, database writes or emails were performed. Enabling registration may change how previously shared links work. Previously sent emails are not updated; Zoom itself may send registration notifications. Recovery requires explicit administrator confirmation, with application email sends separately confirmed.

## Implementation and verification

The event flow now verifies live settings before attendee actions, exposes meeting identity and safe attendee links, and offers current-target reconciliation in 25-booking batches. Existing approved/pending/denied registrations are retained. For a different target with more than 25 bookings, attachment without attendee actions is required first, followed by reconciliation; automatic bulk cancellation is deliberately refused. The same batch limit and cursor-based current-target reconciliation apply to complex-event sessions. The shared dialog can select the current target even when it is absent from the upcoming list. Attaching Zoom also persists the Zoom provider and updates the editor's provider selection, preventing a subsequent save from clearing the link because of a previous Teams selection.

Checks passed:

- Five provider/helper regressions.
- Six event/session handler and editor regressions covering authorization, disabled registration, failed booking lookup, same-target retention, pending-email suppression, bounded session reconciliation and provider synchronization.
- Five existing session-picker regressions.
- Two isolated browser regressions covering explicit enable consent, paginated reconciliation, default-off emails, draft retention in the dialog host, provider failure and shared-session selection.
- JavaScript syntax checks, editor dependency bundle compilation and whitespace checks.

Browser fixtures are not live-provider tests. The authenticated production editor was not browser-tested. The local app starts, but its existing SOURCE tenant lookup fails and the unauthenticated screenshot remained on the loading screen. The dialog was tested independently with intercepted APIs; no authentication bypass was added.

## Database and rollout

No database migrations were needed, created or applied. Neither DEST nor SOURCE data was changed. The historical registration-column migration and creation defaults were left unchanged. Nothing was deployed.
