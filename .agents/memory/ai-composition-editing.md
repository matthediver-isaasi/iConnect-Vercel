---
name: AI Composition prompt-led editing
description: Prompt-led edit pipeline invariants — proposal storage, protected values, link record-IDs, breakpoint isolation.
---

# AI Composition prompt-led editing (Design Studio)

- **Never trust the client with a document.** Proposals are stored server-side (`ai_composition_conversation.proposal` = ops or full document); `accept` re-applies the stored ops against the CURRENT version. If the composition moved on, apply fails → 409 "ask again", never a silent merge.
- **Why:** the preview document the client holds may be stale or tampered; the ops-against-current re-apply is the integrity boundary.
- **Redesigns are alternatives.** `composition_redesign` inserts a version with `is_alternative=true` and does NOT switch `current_version_id`; the user switches via version history/restore.
- **Protected values** (prices, dates, names, statistics — `PROTECTED_VALUE_KINDS` in the schema lib) diff before/after; any hit becomes a warning that blocks accept until `confirmProtected` is sent.
- **Links are record IDs, never AI-invented URLs.** LLM emits `link_request` with a search phrase; endpoint returns tenant-scoped candidates; the chosen destination is applied deterministically (`buildDestinationLinkOp`, no second LLM call). Page/form links carry a `slug` snapshot so the client renderer can build hrefs without extra fetches — slug must pass the identifier regex or it's dropped.
- **Breakpoint scoping is enforced twice:** in the edit pipeline retry loop AND `checkBreakpointIsolation` at the endpoint boundary (defense in depth — a leak outside the chosen breakpoint 422s).
- **How to apply:** any new edit op or link kind must be added to the patch lib's op validation, `LINK_ID_FIELDS` (broken-link check tables), and the destination searchers together, or accepts pass while broken-link checks / disambiguation silently miss the new kind.
