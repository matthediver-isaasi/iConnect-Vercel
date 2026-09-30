-- Versioned, persisted contract for Structured Record Actions.
-- Execution idempotency intentionally uses form_submission.processing_notes,
-- so no additional processing/ledger table is required.
ALTER TABLE public.form
  ADD COLUMN IF NOT EXISTS structured_actions jsonb
  NOT NULL DEFAULT '{"version":1,"actions":[]}'::jsonb;

ALTER TABLE public.form
  DROP CONSTRAINT IF EXISTS form_structured_actions_contract_check;

ALTER TABLE public.form
  ADD CONSTRAINT form_structured_actions_contract_check
  CHECK (
    jsonb_typeof(structured_actions) = 'object'
    AND structured_actions->>'version' = '1'
    AND jsonb_typeof(structured_actions->'actions') = 'array'
  );