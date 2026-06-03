-- Task #1222: Blog co-authors.
-- One blog post can now reference many authors via a join table. Each link row
-- points to EITHER a member (author_id) OR a guest writer (guest_writer_id) and
-- carries an explicit display_order. The existing blog_post.author_id /
-- guest_writer_id / author_name columns remain the PRIMARY author (still drive
-- the URL handle, slug, listings and follow). The full ordered author list lives
-- in blog_post_author, with the primary author backfilled as display_order 0.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS blog_post_author (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blog_post_id UUID NOT NULL REFERENCES blog_post(id) ON DELETE CASCADE,
  author_id UUID NULL REFERENCES member(id) ON DELETE CASCADE,
  guest_writer_id UUID NULL REFERENCES guest_writer(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  tenant_id UUID NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blog_post_author_one_ref CHECK (
    (author_id IS NOT NULL AND guest_writer_id IS NULL) OR
    (author_id IS NULL AND guest_writer_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_blog_post_author_post ON blog_post_author(blog_post_id);
CREATE INDEX IF NOT EXISTS idx_blog_post_author_member ON blog_post_author(author_id) WHERE author_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blog_post_author_guest ON blog_post_author(guest_writer_id) WHERE guest_writer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blog_post_author_tenant ON blog_post_author(tenant_id);

-- Prevent the same member / guest writer being linked twice to one post.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blog_post_author_member
  ON blog_post_author(blog_post_id, author_id) WHERE author_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blog_post_author_guest
  ON blog_post_author(blog_post_id, guest_writer_id) WHERE guest_writer_id IS NOT NULL;

-- Backfill: one author-link row per existing post from its current primary author
-- so no post loses its author. Only inserts when the post has no link rows yet.
INSERT INTO blog_post_author (blog_post_id, author_id, guest_writer_id, display_order, tenant_id)
SELECT
  bp.id,
  CASE WHEN bp.author_id IS NOT NULL THEN bp.author_id ELSE NULL END,
  CASE WHEN bp.author_id IS NULL AND bp.guest_writer_id IS NOT NULL THEN bp.guest_writer_id ELSE NULL END,
  0,
  bp.tenant_id
FROM blog_post bp
WHERE (bp.author_id IS NOT NULL OR bp.guest_writer_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM blog_post_author bpa WHERE bpa.blog_post_id = bp.id
  );
