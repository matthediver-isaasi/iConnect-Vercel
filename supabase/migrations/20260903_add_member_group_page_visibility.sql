-- Group directory visibility is independent from whether members may self-join.
-- Existing and new groups remain visible unless an administrator hides them.
ALTER TABLE member_group
  ADD COLUMN IF NOT EXISTS hide_on_group_page BOOLEAN NOT NULL DEFAULT false;