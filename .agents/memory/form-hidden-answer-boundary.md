---
name: Hidden form answer boundary
description: Why client visibility must not prune the answer universe sent to payment and submission endpoints.
---

Hiding a page excludes its fields from client rendering and validation, but must not pre-delete their raw answers from quote or submission requests.

**Why:** Retained or rule-assigned answers can drive other visibility conditions, role selection and membership pricing. Deleting them before server evaluation changes the condition inputs and can disagree with server-owned mapping visibility. Page hiding is not equivalent to deleting an answer.

**How to apply:** Preserve local answers for hide/show restoration and send the established raw-answer payload. Let server visibility/mapping enforcement decide which answers may produce side effects. Check embedded and standalone forms together when changing this boundary.

Row-local visibility must also be evaluated against retained raw rows before projecting hidden cells out of a side-effect view. That projection is not safe to re-evaluate.

**Why:** A hidden dropdown can retain the answer that reveals another field in the same row. Evaluating a second time after removing the source changes the result, and pruning client payloads loses both restoration and server authority.

**How to apply:** Keep raw rows for storage, rule evaluation and validation; use a separate effective view for mappings and emails. Never add a row-hidden child to the form-wide hidden-ID set. Audit specialized validators as well as the general repeatable validator.