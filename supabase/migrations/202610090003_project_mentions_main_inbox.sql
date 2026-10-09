BEGIN;

ALTER TABLE public.project_mention_inbox
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_favourite boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.member_inbox_folder(id) ON DELETE SET NULL;

-- One authoritative row for both inboxes. This read-only projection excludes
-- revoked membership, archived boards/cards and cards moved off the board.
CREATE OR REPLACE VIEW public.project_mention_inbox_visible
WITH (security_invoker = true) AS
SELECT m.*, b.tenant_id, b.name AS board_name, c.title AS card_title
FROM public.project_mention_inbox m
JOIN public.project_board b ON b.id = m.board_id AND b.is_archived = false
JOIN public.project_card c ON c.id = m.card_id AND c.board_id = m.board_id AND c.is_archived = false
JOIN public.project_board_member bm ON bm.board_id = m.board_id AND bm.identity_id = m.recipient_id;

REVOKE ALL ON public.project_mention_inbox_visible FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_mention_inbox_visible TO service_role;
CREATE INDEX IF NOT EXISTS project_mention_inbox_recipient_created
  ON public.project_mention_inbox(recipient_id, created_at DESC, id DESC);

NOTIFY pgrst, 'reload schema';
COMMIT;
