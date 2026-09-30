-- Task #2208: RBAC-aware Help Center content.
-- Adds an optional RBAC feature key that an article requires. When set, the
-- article is hidden on the Help index and cannot be opened by members who lack
-- that feature (presentation-only gating, mirroring portal navigation).
-- Empty/NULL means the article is visible to everyone. Idempotent; safe to re-run.

ALTER TABLE help_article ADD COLUMN IF NOT EXISTS required_feature text;
