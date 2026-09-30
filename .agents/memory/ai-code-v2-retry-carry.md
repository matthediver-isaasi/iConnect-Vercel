---
name: AI V2 retry carry-forward
description: Rules for carrying a passing HTML/CSS side between AI page-generation retries without trapping loops.
---

Page_body code retries carry forward the side (HTML or CSS) that passed, embedding it verbatim in the retry prompt ("reuse exactly, fix the other side only"). Rules that keep this safe:

- **A side counts as PASSED only against FULL gate truth**, not the size/structure heuristics. Classify every actual gate error to a side (html/css/both); carry HTML only if all errors are css-side, and vice versa. Unclassifiable errors block carry.
  **Why:** carrying a side that still fails other gates ("REUSE IT EXACTLY") traps retries in non-convergent loops — the opposite of the goal.
- Pipeline/sanitiser rejections clear both verdicts (never carry from them).
- Carried output still runs the full sanitise pipeline + gates (no gate weakening).
- Clear the carried payload from job state on success — it's large.
- Mechanical fixes (missing data-ai-id injection) are done pre-pipeline as bookkeeping, page_body only, with the gate kept as backstop.

**How to apply:** any retry loop that preserves partial output must gate eligibility on the real rejection reasons and keep the prompt's "this passed" claims exactly aligned with those reasons (see ai-quality-gate-prompt-pairing).
