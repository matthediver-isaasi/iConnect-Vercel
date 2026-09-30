---
name: Public form submission idempotency
description: How duplicate public form submissions are prevented and how to test the public endpoint from this workspace
---

Duplicate guard covers BOTH submission paths: the public endpoint AND the authenticated entity-API create (canvas/iEdit block, logged-in members) — the entity POST handler accepts the same `idempotency_key`, pre-checks (form_id, key, tenant) and returns the original row as a 201 on duplicate/23505, so client success flows never see an error.

Duplicate guard on the public form-submission endpoint has three layers:
1. Client sends an `idempotency_key` (one UUID per fill session, rotated after success).
2. Server pre-check + unique partial index on (form_id, idempotency_key); 23505 handler returns the winner's original success payload (200, `duplicate: true`) — never an error, so retrying clients behave.
3. Keyless backstop: 10s window matching same form + same organisation or lowercased email; fail-open, never blocks anonymous no-email submissions.

**Why:** users double-click / retry on slow networks; automated bursts created up to 8 identical submissions in 1 second. Returning the original row's payload (not 409) keeps client success flows working.

**How to apply / test:** local dev DB is the legacy pre-tenant snapshot, so the public endpoint can't be exercised via localhost. Test by importing the handler in-process from a workspace-resident script with `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` overridden to DEST, a real tenant host header, and a throwaway `form` row (needs a non-null `slug`); always delete test form + submissions after. Cleanup script for historic duplicates: `scripts/dedupe-initial-enquiry-submissions.mjs` (dry-run default).
