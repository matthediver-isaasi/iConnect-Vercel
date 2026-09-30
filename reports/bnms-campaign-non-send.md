# BNMS campaign “test”: read-only incident diagnosis

## Production evidence

Checked on 22 September 2026 using bounded GET-only Supabase REST queries pinned to DEST project `lvmzliemqnieeoruhkik`. No application campaign GET endpoint was used: those endpoints can persist enriched counters.

- Tenant: BNMS (`ff2df806-b321-4254-b651-3af11fccf1db`).
- Exact name search returned one campaign: `32880462-3d95-47fd-a4eb-f226d376a2b6`.
- Created: `2026-09-22T04:29:01.668926Z`.
- Send timestamp: `2026-09-22T04:29:22.779Z`.
- Recipient created: `2026-09-22T04:29:24.291744Z`.
- Campaign last updated: `2026-09-22T04:29:27.780Z`.
- Persisted campaign: status `sent`, total recipients 1, sent 0, delivered 0.
- Sole recipient `a9c8883a-1794-49a1-8528-c0592c9a3995`: `failed`, error `400: Bad Request`, no sent timestamp, no Mailgun message ID.
- No stored email events for this campaign.
- `scheduled_at` is null, `is_test_mode` false, category review not required.
- Stored sender email is `test`; sender name is also `test`. Subject is present, HTML is 244 characters, reply-to is empty.

These records show a real campaign attempt, not merely the separate Test Email action. They support an immediate-send path; historical request logs were unavailable, so the precise browser action cannot be independently proved. Preparation and recipient persistence completed; the recorded failure occurred during provider submission, not during delayed delivery-statistics synchronization.

## Outcome and cause

**Application-recorded outcome: unsent, one failed submission, zero provider acceptances recorded.** There is no evidence of partial sending or delivery. This is not a queued campaign: its one recipient is terminally failed.

The malformed sender is a confirmed input-validation defect and consistent with the recorded HTTP 400. The exact provider-side rejection explanation is **unverified**, because only the generic error was stored. A second confirmed defect marked the exhausted batch `sent` even though every recipient failed, and the UI could substitute intended recipients for zero successful sends.

## Provider and deployment evidence limits

- Tenant configuration identifies `bnms.iconn.app` as verified and active.
- Read-only EU Mailgun Events queries covered `04:28–04:32 UTC`. The configured workspace credential received HTTP 401 for the tenant domain. Its account access therefore cannot verify this domain's events or be assumed identical to production credentials.
- The fallback domain `mail.iconn.app` returned HTTP 200 and zero events in that window. This is only evidence for that queried domain/account/window, not proof of tenant-domain absence.
- A read-only Vercel deployment lookup using an existing project deployment reference returned HTTP 403. Historical runtime logs, the incident's deployed revision, and production cron configuration could not be verified. Current source configures the campaign processor, but source configuration alone does not prove production cron execution.
- No Mailgun send, event sync, requeue, resend, configuration change, or database mutation was performed.

## Code changes and recovery

Sender validation now stops malformed senders before preparation/provider submission in send, schedule and test-send paths; the editor displays the error. Completed all-failed attempts now return failure status and actual counts/errors. The UI separates provider acceptance from delivery and exposes failed campaign statistics without inventing successful counts.

Do not blindly resume this record: there are no pending recipients, and changing the sender does not make failed rows pending. After the fixes are deployed, an authorized operator should review the original recipient, obtain tenant-domain provider evidence if possible, and approve a corrected new attempt (for example a duplicate with a valid sender) separately. This preserves the original evidence and explicitly considers duplicate-send risk. This investigation does not authorize that send.

Focused tests are isolated; they do not prove a live deployment or provider delivery. No migration is required, none was applied to DEST or SOURCE, and none is pending.

Verification: all 25 focused tests passed, including mocked invalid-resume and invalid-batch gates and feedback dispatch across the editor and group campaign manager. The development workflow starts, but browser verification stops at “Tenant not found”: the existing workspace runtime targets legacy SOURCE, whose schema lacks the tenant table. No runtime credentials were changed to bypass that boundary. Authenticated campaign-screen and deployed verification remain unperformed.