-- Allow the 'version_deleted' activity action so deleting an uploaded draft
-- version can be recorded in the brief activity log. Idempotent: re-applying
-- simply re-creates the constraint with the same definition.
ALTER TABLE article_brief_activity
  DROP CONSTRAINT IF EXISTS article_brief_activity_action_check;

ALTER TABLE article_brief_activity
  ADD CONSTRAINT article_brief_activity_action_check
  CHECK (action IN (
    'brief_created',
    'writer_assigned',
    'status_changed',
    'version_uploaded',
    'version_deleted',
    'comment_added',
    'comment_actioned',
    'comment_closed',
    'approved',
    'rejected',
    'case_study_upload_added',
    'case_study_upload_deleted'
  ));
