-- Task #3190: durable per-submission email send state.
-- NULL  = emails not yet attempted for this submission (claimable).
-- jsonb = { status: 'processing'|'sent'|'skipped'|'failed', trigger,
--           claimed_at/processed_at, reason, emails: [{id,to,success,skipped,reason,error,messageId}] }
-- The claim is an atomic UPDATE ... WHERE submission_email_state IS NULL,
-- giving exactly-once sending across the server-side path, the retained
-- legacy client call, and the generic entity API.
ALTER TABLE form_submission
  ADD COLUMN IF NOT EXISTS submission_email_state jsonb;
