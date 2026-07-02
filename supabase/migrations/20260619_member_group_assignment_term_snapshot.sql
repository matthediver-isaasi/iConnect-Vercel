-- Task #1626: Term snapshot columns on member_group_assignment.
--
-- When a member is AWARDED a vacancy or ACCEPTS a direct role invite, their
-- group assignment captures a FIXED snapshot of the role's term at that moment.
-- Later edits to the role's term definition must NOT retroactively change an
-- already-awarded member's recorded term, so these are plain columns rather
-- than a live join back to member_group.role_term_definitions.
--
--   term_length_value / term_length_unit — the snapshotted term length.
--   max_terms                            — snapshotted maximum terms.
--   term_start_date                      — when this term began (award/accept).
--   term_end_date                        — projected end (start + term length).
--   term_number                          — which term the member is serving for
--                                          this role (e.g. 1 of max_terms).
--
-- These are tracked separately from the existing expires_at admin-flag expiry
-- and must not be conflated with it. Idempotent; safe to re-run.

ALTER TABLE member_group_assignment
  ADD COLUMN IF NOT EXISTS term_length_value INTEGER,
  ADD COLUMN IF NOT EXISTS term_length_unit TEXT,
  ADD COLUMN IF NOT EXISTS max_terms INTEGER,
  ADD COLUMN IF NOT EXISTS term_start_date DATE,
  ADD COLUMN IF NOT EXISTS term_end_date DATE,
  ADD COLUMN IF NOT EXISTS term_number INTEGER;
