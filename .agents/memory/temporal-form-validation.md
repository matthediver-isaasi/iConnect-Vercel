---
name: Temporal form validation
description: Time-relative answer rules apply to new decisions, not previously accepted requests or unchanged history.
---

Validate future-only answers at the UTC acceptance boundary. Recover an identical accepted request before applying today's date rule; amendments validate changed answers only.

**Why:** Midnight can turn a valid answer into a past answer while payment confirmation or an idempotent retry is still pending. Revalidating accepted answers can strand an otherwise successful payment. Legacy repeatable rows may acquire IDs only when rendered, so an ID mismatch alone does not prove an answer changed.

**How to apply:** Preserve persisted answers during provider callbacks. Check retry payload equivalence both on early lookup and after unique-conflict recovery, using the same anonymous-survey redaction as persistence. For legacy row history, use one-to-one content matching rather than position alone.