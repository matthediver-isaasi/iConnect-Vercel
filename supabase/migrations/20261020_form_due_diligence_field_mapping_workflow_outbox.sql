-- Task #4375: field mappings are durable before their action checkpoint, but
-- their workflow fanout also needs the original values on a retry. This outbox
-- persists that payload and never replays an interrupted delivery.
CREATE TABLE IF NOT EXISTS public.form_due_diligence_field_mapping_workflow_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_submission_due_diligence_id UUID NOT NULL
    REFERENCES public.form_submission_due_diligence(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('core', 'preference')),
  organization_id UUID NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'requires_attention')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (form_submission_due_diligence_id, event_key)
);

CREATE INDEX IF NOT EXISTS form_dd_field_mapping_workflow_outbox_pending_idx
  ON public.form_due_diligence_field_mapping_workflow_outbox
    (form_submission_due_diligence_id, tenant_id, created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.form_due_diligence_field_mapping_workflow_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.form_due_diligence_field_mapping_workflow_outbox
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.form_due_diligence_field_mapping_workflow_outbox TO service_role;