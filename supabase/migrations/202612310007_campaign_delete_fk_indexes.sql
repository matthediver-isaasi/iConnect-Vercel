-- Restore indexes missing on DEST. Recipient FK actions otherwise scan the
-- entire history table once per deleted recipient. No lifecycle/grant changes.
-- Apply with the hash-pinned DEST runner after approval.
BEGIN;
CREATE INDEX IF NOT EXISTS idx_email_event_recipient ON public.email_event(recipient_id);
CREATE INDEX IF NOT EXISTS idx_email_link_click_recipient ON public.email_link_click(recipient_id);
COMMIT;
