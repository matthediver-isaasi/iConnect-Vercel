# Email Campaign Sending Safety Audit Report

**Date:** 26 March 2026  
**Scope:** Tasks #121 (Audience Targeting Fix), #122 (Emergency Stop), #123 (Test Mode Toggle)  
**Purpose:** Verify that all safeguards are correctly implemented to prevent incorrect mass email sends.

---

## Executive Summary

A comprehensive audit of the campaign sending pipeline confirms that all three safety features are correctly implemented with layered defences. No critical issues were identified that could cause an incorrect mass send. The system includes multiple independent guardrails at the audience targeting, sending, and cancellation layers.

---

## 1. Audience Targeting Fix — 3-Layer Defence (Task #121)

**Status: Correctly Implemented**

The recipient resolution pipeline applies three independent layers of filtering before any email is sent:

### Layer 1 — Global Member Opt-Out
Members with `communications_opted_out_all = true` are excluded from all campaign sends regardless of targeting.

### Layer 2 — Global Email Unsubscribe
The `email_unsubscribe` table is checked for any email address with `unsubscribe_type = 'all'` for the tenant. These addresses are excluded from all sends.

### Layer 3 — Category-Specific Opt-Out
If the campaign has a `communication_category_id`, members who have opted out of that specific category (via `member_communication_preference` with `is_subscribed = false`) are excluded.

### Hard Block on "All Members" Targeting
- `validateCampaignTargeting()` explicitly rejects `all_members` as a segment type.
- This validation runs in both `sendCampaign()` and `scheduleCampaign()`, blocking the operation with a logged error: `BLOCKED SEND: Campaign ... - Campaigns cannot target all members.`
- The API endpoints (`index.js` and `[id].js`) also reject `all_members` in request bodies before data reaches the service layer — a second line of defence.

---

## 2. Emergency Stop (Task #122)

**Status: Correctly Implemented with Race Condition Guards**

### Campaign-Level Atomic Status Change
The `cancelCampaign()` function uses a conditional database update (`WHERE status IN ('sending', 'scheduled')`) to atomically transition the campaign to `cancelled`. This prevents concurrent cancel-vs-complete transitions from conflicting.

### Batch-Level Cancellation Check
After claiming a batch of recipients but **before** sending any emails, `sendBatch()` re-checks the campaign status from the database. If the campaign has been cancelled, the entire batch is aborted and all claimed recipients are reverted to `cancelled` status.

### Recipient-Level Guard
`sendToRecipient()` only updates a recipient to `sent` if its current status is still `processing`. A recipient that has been marked `cancelled` by the emergency stop cannot be accidentally overwritten to `sent`.

### Stale Lock Recovery
If recipients get stuck in `processing` for over 5 minutes (e.g. due to a worker crash), `processSendingCampaigns()` automatically resets them to `pending` for retry or cancellation.

### Audit Trail
The `cancelled_at` and `cancelled_by` fields record exactly when and who initiated the emergency stop.

---

## 3. Test Mode Toggle — Mailgun o:testmode (Task #123)

**Status: Correctly Implemented Across All Send Paths**

### Coverage of All Send Paths
The `is_test_mode` flag is carried through every path that sends campaign emails:
- **Manual sends** — triggered via the Send button
- **Scheduled sends** — triggered by the cron job via `processScheduledCampaigns()`
- **Background batch processing** — triggered by `processSendingCampaigns()`

All paths converge on `sendToRecipient() → sendEmail()`, where `testMode: !!campaign.is_test_mode` is passed and the Mailgun `o:testmode: 'yes'` header is set.

### Fallback Domain Safety
The `o:testmode` flag is set on the `messageData` object **before** any send attempt. If the tenant domain fails and the system falls back to the default domain (`mail.iconn.app`), the same `messageData` (including `o:testmode`) is reused. Test mode is preserved regardless of which domain sends the email.

### Individual Test Emails
The "Send Test Email" button (single-recipient test) correctly does **not** use `o:testmode`. This is by design — you need to actually receive the test email in your inbox to preview it.

---

## Recommended Safe Send Procedure

For the first real campaign after these changes, the recommended procedure is:

1. Create the campaign with test mode **enabled**
2. Send it — the full pipeline runs but Mailgun does not deliver any emails
3. Review the campaign stats to verify recipient counts and statuses look correct
4. Duplicate the campaign (which preserves test mode and all settings)
5. On the duplicate, disable test mode
6. Send the duplicate for real delivery

This gives you a complete dry run with real data before any emails are delivered.

---

## Emergency SQL — Nuke All Running Campaigns

If all safeguards fail and campaigns are sending incorrectly, run these SQL statements directly against the database **in order**. These statements target all currently running campaigns — no campaign ID is needed.

### Step 1 — Cancel all sending and scheduled campaigns

```sql
UPDATE email_campaign
SET status = 'cancelled',
    cancelled_at = NOW()
WHERE status IN ('sending', 'scheduled');
```

### Step 2 — Cancel all unsent recipients across all campaigns

```sql
-- This is the most critical step — prevents sendBatch from claiming more recipients
UPDATE email_campaign_recipient
SET status = 'cancelled'
WHERE status IN ('pending', 'processing');
```

### Step 3 — Verify the cancellation

```sql
-- Confirm no campaigns are still sending
SELECT id, name, status, cancelled_at, sent_count, total_recipients
FROM email_campaign
WHERE status IN ('sending', 'scheduled')
ORDER BY sent_at DESC;

-- Should return zero rows. If it does, all campaigns are stopped.

-- Check recipient status breakdown across all recently cancelled campaigns
SELECT ec.name, ecr.status, COUNT(*)
FROM email_campaign_recipient ecr
JOIN email_campaign ec ON ec.id = ecr.campaign_id
WHERE ec.cancelled_at > NOW() - INTERVAL '1 hour'
GROUP BY ec.name, ecr.status
ORDER BY ec.name, ecr.status;
```

### Important Notes

- **Steps 1 and 2 should be run as quickly as possible** — the pipeline processes recipients in batches of 100, so every second counts.
- **Step 2 is the most critical** — even if Step 1 fails for some reason, cancelling all pending/processing recipients directly prevents `sendBatch()` from claiming them.
- **Recipients already in `sent` status** have been delivered to Mailgun and cannot be recalled. The SQL above only prevents future sends.
- These SQL statements can be run via the Supabase dashboard SQL editor, or via a Node.js script using the `pg` client with `DEST_DATABASE_URL`.

---

## Observations (Non-Critical)

1. **Cache timing on tenant email config** — 5-minute cache on tenant email domain configuration. This only affects which domain sends the email, not who receives it. Not a mass-send risk.
2. **Workflow-triggered emails** — Automated workflow emails do not support test mode. This is expected since workflows send individual transactional emails, not bulk campaigns.
