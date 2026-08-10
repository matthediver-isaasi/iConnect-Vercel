-- Task #3483: generic Payment field for the form builder.
-- Payment lifecycle columns on form_submission. A row is created BEFORE the
-- provider payment starts with payment_status='pending' and is finalised to
-- 'paid' by the confirm endpoint / reconciliation. Pending rows are excluded
-- from normal admin listings and never run post-submission side effects.
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS payment_status text;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS payment_provider text;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS payment_amount numeric;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS payment_currency text;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS payment_reference text;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS payment_meta jsonb;
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS payment_paid_at timestamptz;

-- Reconciliation sweep: find pending-payment rows fast.
CREATE INDEX IF NOT EXISTS idx_form_submission_payment_pending
  ON form_submission (created_date)
  WHERE payment_status = 'pending';
