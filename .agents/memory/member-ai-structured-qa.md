---
name: Member AI structured Q&A
description: How the member AI answers count/breakdown questions from live DB records via a whitelisted query spec, and the visibility gotchas discovered building it.
---

# Member AI structured data Q&A

The member AI assistant (`api/member-ai/ask.js`) routes count/aggregate/breakdown questions to a structured path in `api/_lib/memberAiStructured.js`: regex pre-gate → LLM planner fills a constrained whitelisted query spec (never SQL) → `validateQuerySpec` → tenant-scoped executor with member visibility baked in → LLM synthesis (numbers come only from the executor; deterministic template fallback). Content questions and any planner failure fall through to RAG, so structured routing can never break RAG.

## Durable gotchas

- **Two directory systems coexist.** `dynamic_directory` rows are rare (most tenants have none) — tenants without any use the legacy `OrganisationDirectory`/`MemberDirectory` pages, which show all rows subject to base predicates + feature gate. So "no dynamic_directory rows" must mean *unrestricted*, not *refuse*; only refuse when directories exist but are all inactive.
  **Why:** hard-failing on missing dynamic_directory rows made org/member counts unusable for nearly every tenant (incl. GSF, the reference tenant).
- **`organization` has no `city`/`country` columns.** Geography lives in preference fields ("Countries of operation", "HQ location") or free-text `address`. Don't whitelist columns without checking the live table.
- **Preference-field member visibility is NOT `is_filterable`.** The directory pages expose fields via `directory_visibility` JSON (includes `'main'`) with fallback flags `show_in_directory_card` (org) / `show_in_member_directory` (member). GSF has all fields `is_filterable=false` yet fully directory-visible.
- Booking counts are aggregate-only, `status='confirmed'` (mirrors checkinService), and only on events the member can see.
- PostgREST 1000-row cap: the executor always paginates (`fetchAllRows`, hard cap 25k rows) — never count a single page.

**How to apply:** any new entity or field added to the structured catalog must mirror an existing member-facing browse surface's visibility, be verified against live DEST columns, and get pure-predicate tests in `memberAiStructured.test.mjs`.
