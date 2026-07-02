-- Task #1414: Personal saved filter views on the Form Submissions page.
--
-- Admins on the Form Submissions page can save the current filter set (search
-- query, selected form, selected status, date-from, date-to, All/Owned tab)
-- under a name, then re-apply it later with one click. Views are PERSONAL to
-- the member that created them and isolated per tenant.
--
--   form_submission_saved_view.tenant_id : owning tenant (isolation).
--   form_submission_saved_view.member_id : owning member (personal scope).
--   form_submission_saved_view.name      : user-chosen label for the view.
--   form_submission_saved_view.filters   : JSONB snapshot of the filter set
--                                           ({ q, form, status, dateFrom,
--                                             dateTo, tab }).
--
-- Tenant-scoped (tenant_id) so the generic entity API can list it; the API
-- additionally restricts reads/writes to the requesting member. Idempotent;
-- safe to re-run on any environment.

BEGIN;

CREATE TABLE IF NOT EXISTS form_submission_saved_view (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id UUID NOT NULL,
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Idempotently ensure the FK exists even on databases where the table was
-- created by an earlier version of this migration (CREATE TABLE IF NOT EXISTS
-- would otherwise skip the inline REFERENCES above).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'form_submission_saved_view_tenant_id_fkey'
  ) THEN
    ALTER TABLE form_submission_saved_view
      ADD CONSTRAINT form_submission_saved_view_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_form_submission_saved_view_tenant
  ON form_submission_saved_view(tenant_id);
CREATE INDEX IF NOT EXISTS idx_form_submission_saved_view_member
  ON form_submission_saved_view(tenant_id, member_id);

COMMENT ON TABLE form_submission_saved_view IS
  'Personal saved filter views for the Form Submissions page. One row per saved view, owned by member_id within tenant_id (Task #1414).';

COMMIT;

NOTIFY pgrst, 'reload schema';
