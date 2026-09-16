---
name: Hidden form answer boundary
description: Why client visibility must not prune the answer universe sent to payment and submission endpoints.
---

Hiding a page excludes its fields from client rendering and validation, but must not pre-delete their raw answers from quote or submission requests.

**Why:** Retained or rule-assigned answers can drive other visibility conditions, role selection and membership pricing. Deleting them before server evaluation changes the condition inputs and can disagree with server-owned mapping visibility. Page hiding is not equivalent to deleting an answer.

**How to apply:** Preserve local answers for hide/show restoration and send the established raw-answer payload. Let server visibility/mapping enforcement decide which answers may produce side effects. Check embedded and standalone forms together when changing this boundary.