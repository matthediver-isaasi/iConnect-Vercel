-- Track the storage path and file size of each uploaded brief draft version so
-- deleting a version can decrement the tenant storage-usage counter (mirrors
-- article_brief_case_study_upload, which already has these columns). Without
-- them the tenant storage meter on /admin/plan-usage drifts upward whenever a
-- version is deleted. Idempotent: ADD COLUMN IF NOT EXISTS is a no-op on re-run.
ALTER TABLE article_brief_version
  ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE article_brief_version
  ADD COLUMN IF NOT EXISTS file_size BIGINT;
