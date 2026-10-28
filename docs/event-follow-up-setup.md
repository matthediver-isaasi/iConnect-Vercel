# Post-event email follow-ups

## Release and database report

Required migration: `supabase/migrations/202612310060_event_email_follow_ups.sql`.
Prerequisites:
- `20260420_add_scheduled_email_session_id.sql`
- `20260508_add_event_email_custom_datetime.sql`
- `202612310039_training_reminder_target_snapshot.sql`

The new migration adds follow-up configuration, a stable event/day/session
identity and a snapshot to the existing queue. Legacy rows and delivery history
are retained. Legacy deduplication remains enforced by a partial index; follow-ups
have a separate unique target index. No permissions are broadened.

**Applied:** only to disposable, isolated local PostgreSQL fixtures for testing.
**Pending:** all live application databases. No SOURCE, DEST, tenant configuration,
backfill, requeue, mail send or deployment was performed for this change.
Before an authorized release, independently verify the intended **DEST** project
identity and its prerequisite migrations. Never apply to legacy SOURCE or assume
the development runtime points at DEST. Obtain owner approval before live
migration/deployment. Run the migration in its transaction before enabling
follow-ups. A source merge alone does not establish public rollout.

## Tenant setup

1. Open an event's email settings, during creation or editing, and choose
   **Follow-up**. Create as many independent follow-ups as needed.
2. Select **After event**, **After each programme day**, or **After each session**. After event is
   available for every event type. Day/session options are for programmes.
3. Set the delay and unit. Zero means at the selected end; days mean elapsed
   24-hour periods. Each follow-up has its own template and enabled switch.
4. Supply explicit programme end times and an overall event end. After event
   waits for the later of the declared end and the final complete programme end.
   After day waits for the final programme session of a relevant event-local
   start day, including sessions the recipient cannot access.
5. Overnight sessions belong to their start day and wait until their actual end.
   A continuous date range remains one after-session target. For after-day
   messages, split ranges into separately timed daily entries; no daily
   timetable is inferred. An explicitly timed overnight entry ending the next
   morning remains one start-day target.
6. Save the event first to enable **Preview**. Preview uses the current email
   draft and labelled sample attendee details. For complex day/session messages,
   choose a sample ticket class, then select the target. Check the displayed
   event timezone, intended send time and validation warnings.
7. Save the email configuration. **Saving does not queue or send anything.**
   New bookings schedule future targets automatically. Use **Re-queue reminders
   and follow-ups** explicitly for existing bookings, and inspect the results.
   A delayed follow-up can still be scheduled after its event/session ended,
   provided its intended send time is still in the future.

Recipients are confirmed attendee bookings, not all contacts or bookers.
No check-in/attendance filter is applied. Complex day/session sends require a
valid ticket entitlement; overall-event sends cover confirmed event bookings
even if they joined only part of the programme.

Use `{{follow_up_target}}`, `{{follow_up_end}}` and `{{follow_up_scope}}` for
target-specific content. Event placeholders keep overall-event context.
`{{agenda_schedule}}` and `{{session_schedule}}` remain labelled full schedules,
not a substitute for the selected target. Follow-ups append no confirmation
QR codes or calendar attachments. Existing survey template behavior is retained.

Missed times are not newly queued. Delivery checks the current booking,
configuration, entitlement and target before sending. Changed or removed targets
are suppressed; explicitly schedule again after correcting them. Previously
sent, claimed or unknown-outcome rows are never reset by scheduling. Investigate
delivery history before authorizing any replacement for an unknown outcome.

## Isolated verification

Backend and existing reminder regressions:
```
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/eventFollowUps.test.mjs api/_lib/eventFollowUpBookingPaths.test.mjs api/_lib/eventFollowUps.postgres.test.mjs api/_lib/trainingReminders.test.mjs api/_lib/complexEventReminders.test.mjs api/_lib/complexEventReminders.scheduling.test.mjs api/_lib/scheduleReminders.complexPerDay.test.mjs shared/trainingAgendaBounds.test.mjs
```
Editor tests:
```
node scripts/run-isolated-tests.mjs node --test client/src/components/events/EventEmailSettingsEditor.followUp.mounted.test.mjs
node node_modules/@playwright/test/cli.js test --config=client/src/components/events/event-follow-ups.browser.config.mjs
```
Browser tests intercept all network requests and mount actual email cards and
handlers. They do not authorize a live mail send or tenant write. Signed-in full
event pages and received-email rendering in real mail clients remain release
environment checks, not claims made by the isolated fixtures.
