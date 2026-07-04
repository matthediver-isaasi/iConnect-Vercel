-- Task #2219: Member Inbox favourites
--
-- Adds an is_favourite boolean to member_inbox_message_state so members can
-- flag a delivered campaign message as a favourite. Independent of is_pinned
-- and is_archived. A missing state row means not favourited (default false).
--
-- Idempotent: safe to run multiple times.

ALTER TABLE member_inbox_message_state
  ADD COLUMN IF NOT EXISTS is_favourite BOOLEAN NOT NULL DEFAULT false;

-- Ask PostgREST to reload its schema cache so the new column is queryable.
NOTIFY pgrst, 'reload schema';
