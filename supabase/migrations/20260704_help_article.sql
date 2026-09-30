-- Task #2199: Help Center pilot — GLOBAL-scoped editable docs.
-- Creates the help_article table. Content is GLOBAL (shared across all tenants);
-- chrome is per-tenant. Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS help_article (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  title text NOT NULL,
  category text,
  summary text,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enforce the draft/published enum without a hard-to-migrate CHECK type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'help_article_status_check'
  ) THEN
    ALTER TABLE help_article
      ADD CONSTRAINT help_article_status_check
      CHECK (status IN ('draft', 'published'));
  END IF;
END $$;

-- Slugs are the public identifier for /help/:slug and must be globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS help_article_slug_key ON help_article (slug);

-- Portal reads filter on status and order by sort_order.
CREATE INDEX IF NOT EXISTS help_article_status_sort_idx
  ON help_article (status, sort_order);
