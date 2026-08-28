---
name: Form validation across payment paths
description: Ensures new saved-form submission constraints cannot be bypassed through paid form entry points.
---

Any new server-side form-answer constraint must run on both the ordinary submission path and all paid-form paths before quote calculation, payment creation, or pending-submission persistence.

**Why:** Paid forms use a separate validation boundary. Securing only the ordinary submission endpoint leaves a data-integrity and payment-side bypass even when the public option endpoint is fail-closed.

**How to apply:** When adding answer validation, enumerate normal submission, quote, one-off payment creation, and recurring/monthly payment creation. Add a direct regression test showing forged answers are rejected before any payment or submission write.