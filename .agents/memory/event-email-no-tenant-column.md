---
name: event_email has no tenant_id
description: Live event_email table lacks tenant_id; harness fixtures that add it hide runtime 42703 failures in funnel delivery.
---
Rule: production `event_email` has NO `tenant_id` column. Scope templates via the event (tenant-owned) and `is_complex_event`, never `event_email.tenant_id`.

**Why:** funnel reminder planning, confirmation planning and cancellation suppression all filtered on it; postgres harness fixtures created the table WITH tenant_id, so tests passed while every live confirmed funnel order retried forever (no confirmation emails). PL/pgSQL only fails such references at execution time.

**How to apply:** when writing SQL or supabase-js against event_email (or other legacy tables), check live columns via information_schema first, and keep harness fixtures matching the real schema. The final inventory harness scenario drops the fixture column to guard this.

Related: Xero invoice customers that are organisations may have no email; v2 funnel invoicing looks them up by unique Xero name only (individuals still require email).
