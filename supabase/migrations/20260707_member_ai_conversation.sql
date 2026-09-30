-- Task #2407: Member AI assistant — persistent chat history.
-- Conversations + messages for the Member AI assistant, scoped to
-- (tenant_id, member_id). A member only ever sees their own conversations
-- for the active tenant; there is no admin cross-member browse surface.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS member_ai_conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  -- Auto-derived from the first question (truncated); no manual naming in v1.
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- List query: this member's conversations for this tenant, most recent first.
CREATE INDEX IF NOT EXISTS member_ai_conversation_member_idx
  ON member_ai_conversation (tenant_id, member_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS member_ai_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES member_ai_conversation(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  -- Citation objects from the ask endpoint ({title,type,typeLabel,link}[]).
  sources jsonb,
  -- Explicit ordering within the conversation (0-based append position).
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_ai_message_conversation_idx
  ON member_ai_message (conversation_id, position);

-- Ordering integrity: two concurrent appends must never land on the same
-- position. The append endpoint computes max(position)+1 and relies on this
-- unique index to reject the loser of the race (23505), which it retries.
CREATE UNIQUE INDEX IF NOT EXISTS member_ai_message_conversation_position_key
  ON member_ai_message (conversation_id, position);
