-- Fix email_unsubscribe upsert ON CONFLICT (42P10) for NULL communication_category_id rows.
--
-- The original unique index `idx_email_unsubscribe_unique` is partial and only
-- covers rows where `communication_category_id IS NOT NULL`. All
-- "unsubscribe from all" code paths insert rows with a NULL
-- communication_category_id, so PostgREST/Postgres can't infer a matching
-- conflict target and rejects the upsert with error 42P10.
--
-- This migration adds a second partial unique index covering the NULL
-- category rows on (tenant_id, email, unsubscribe_type). Existing duplicate
-- NULL-category rows are deduped first (keeping the most recent row per
-- tenant_id, email, unsubscribe_type) so the new index can be created.

-- Dedupe existing NULL-category rows that would violate the new index.
-- Keep the most recently created row per (tenant_id, email, unsubscribe_type).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, email, unsubscribe_type
      ORDER BY COALESCE(unsubscribed_at, created_at) DESC, created_at DESC, id DESC
    ) AS rn
  FROM email_unsubscribe
  WHERE communication_category_id IS NULL
)
DELETE FROM email_unsubscribe
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- New partial unique index covering the "unsubscribe from all" / NULL-category rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_unsubscribe_unique_null_category
  ON email_unsubscribe (tenant_id, email, unsubscribe_type)
  WHERE communication_category_id IS NULL;
