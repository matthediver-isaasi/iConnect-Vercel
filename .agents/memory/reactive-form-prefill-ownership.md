---
name: Reactive form prefill ownership
description: Precedence rules for dropdown-driven form prefill when defaults, drafts, transitions, and respondent edits coexist.
---

Dropdown-driven prefill may replace a configured field default only while the answer still equals the initial value captured when reactive prefill becomes ready. A resolved auto-fill remains replaceable by later source selections. Draft, transition, and respondent-owned answers are authoritative.

**Why:** Treating every non-empty value as respondent-owned blocks valid first-time prefill, while treating every configured-default field as replaceable can overwrite a manual edit or restored answer during an asynchronous response.

**How to apply:** When adding a form surface or changing initialization order, identify protected draft/transition fields, wait for asynchronous restoration to settle, and preserve value-based ownership checks for responses that arrive after respondent edits.