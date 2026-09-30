-- Add confirmation_email_template_id column to meeting_template table
-- This allows meeting types to have a confirmation email sent to the attendee after booking

ALTER TABLE meeting_template
ADD COLUMN IF NOT EXISTS confirmation_email_template_id UUID REFERENCES email_template(id) ON DELETE SET NULL;

COMMENT ON COLUMN meeting_template.confirmation_email_template_id IS 'Email template sent as booking confirmation to the attendee';
