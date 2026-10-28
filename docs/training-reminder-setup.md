# Post-event follow-ups

For independent end-based event/day/session messages, see
[Post-event email follow-up setup](event-follow-up-setup.md).
The before-start reminder rules below are unchanged.

# Training reminders

## Tenant setup

1. Open the training event's email settings. Add a **Reminder**, set its timing and switch it to **Enabled**.
2. Write the subject and body. In reminders, `{{event_date}}` and `{{event_time}}` show the targeted agenda entry; `{{zoom_link}}` uses that entry's meeting link. `{{agenda_line_date}}` shows the entry's dates and times. `{{agenda_schedule}}` always shows the **full schedule**, not just the reminder's entry.
3. Click **Preview**. **Training agenda entry** defaults to the next entry with a future reminder time. Select another entry to inspect it. Check **Intended send time** and **Timezone**. This is an unsaved draft with sample attendee details; it does not send or queue anything.
4. Click **Save Email Settings**. Saving changes templates only.
5. For existing bookings, click **Re-queue reminders**. This explicitly schedules eligible future reminders using the saved settings. The result reports queued reminders and bookings, preserved sent/claimed reminders, obsolete cancellations and any failures. Resolve failures before relying on the queue.

New bookings automatically receive the same eligible future reminders. Elapsed send times are never caught up. Repeating **Re-queue reminders** does not resend sent or claimed training reminders.

Each relative reminder applies **once per dated agenda entry**. Two separate entries on the same day get separate reminders. A date-range entry anchors to its start, not every day in the range. A specific date/time reminder remains once per booking.

Day offsets mean elapsed 24-hour periods, which can differ from local calendar-day subtraction across clock changes. Entries with a start time use that time in the event timezone. Legacy date-only entries use the event's start clock time on their own date, or 09:00 when the event has no start. Ambiguous/nonexistent clock-change times must be corrected before they can be scheduled.

If Preview reports no eligible future reminder, check the agenda and timing; it will not substitute an expired session. After changing agenda details or reminder timing, save and explicitly re-queue. Disabled reminders, cancelled bookings, changed/removed targets and reminders for sessions that have already started are suppressed at delivery.

To retire a reminder with scheduling history, switch it to **Disabled** rather than delete it. Its history is retained. A failed or claimed delivery is not automatically retried; check delivery history before arranging any replacement.

Confirmation emails keep the overall event context.

## Release and verification

- Not deployed. No GFI settings, live queue entries or attendee deliveries changed.
- Required migration: `supabase/migrations/202612310039_training_reminder_target_snapshot.sql`.
- Applied: **none**, to any database.
- Pending: apply this migration to **verified DEST**, with approval, before deployment. Do not apply to the legacy SOURCE runtime target.
- The shared cron query does not require the new column. If it is missing, training delivery fails closed with a migration-check message; unrelated event reminders can still be processed.
- The migration adds a nullable target fingerprint only; it does not schedule or send. Existing training rows without a fingerprint are suppressed until an administrator explicitly re-queues eligible future targets.
- Delivery uses an atomic pending-to-failed claim with an explicit unknown-outcome message, compatible with the existing status constraint. A crash or unknown provider response remains non-retryable; no success is inferred.
- Isolated fixture checks freeze time at 27 October / 2 November 2026 and use the October Moodle plus November 09:15 agenda shape. They cover scheduling, pagination, concurrent attempts, history, rendering, target changes, expiry, DST, and render-only browser interaction. These are not live GFI checks.

Run:

```sh
node scripts/run-isolated-tests.mjs node --test api/_lib/trainingReminders.test.mjs api/_lib/trainingAgenda.test.mjs api/_lib/scheduleReminders.complexPerDay.test.mjs
node node_modules/@playwright/test/cli.js test --config=tests/training-reminders.config.mjs
```

The browser fixture blocks external requests and handles its preview endpoint in memory. It mounts the real editor; backend rendering and stubbed delivery are exercised separately by the Node suite.
