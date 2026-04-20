-- Properly fix email_unsubscribe upsert ON CONFLICT (42P10).
--
-- The previous fix (20260420_fix_email_unsubscribe_null_category_unique.sql)
-- added a second partial unique index for NULL-category rows. That doesn't
-- actually work for PostgREST upserts: ON CONFLICT inference will only
-- consider a partial unique index when the client also supplies a matching
-- arbiter predicate, which PostgREST never does. So 42P10 errors continued
-- on every "unsubscribe from all" upsert.
--
-- The correct fix is a single non-partial unique index that treats NULLs as
-- equal (NULLS NOT DISTINCT, supported by Postgres 15+). All upsert call
-- sites are updated to specify
-- (tenant_id, email, unsubscribe_type, communication_category_id) as the
-- conflict target so PostgREST infers this index for both per-category and
-- "unsubscribe from all" code paths.

-- Dedupe existing rows that would violate the new non-partial unique index.
-- Treat NULL communication_category_id as a single bucket (NULL IS NOT
-- DISTINCT FROM NULL); keep the most recently unsubscribed row per group.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, email, unsubscribe_type, communication_category_id
      ORDER BY COALESCE(unsubscribed_at, created_at) DESC, created_at DESC, id DESC
    ) AS rn
  FROM email_unsubscribe
)
DELETE FROM email_unsubscribe
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Drop the old partial indexes (superseded by the NULLS NOT DISTINCT index).
DROP INDEX IF EXISTS idx_email_unsubscribe_unique;
DROP INDEX IF EXISTS idx_email_unsubscribe_unique_null_category;

-- Single non-partial unique index covering both per-category and
-- "unsubscribe from all" rows. NULLS NOT DISTINCT makes NULL
-- communication_category_id values collide with each other, which is what
-- PostgREST needs to infer this index on upsert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_unsubscribe_unique
  ON email_unsubscribe (tenant_id, email, unsubscribe_type, communication_category_id)
  NULLS NOT DISTINCT;
