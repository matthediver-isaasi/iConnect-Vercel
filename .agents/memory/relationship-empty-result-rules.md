---
name: Relationship empty-result rules
description: How form relationship fields represent and evaluate a confirmed zero-result lookup.
---

Treat “no relationship found” as transient conditional-logic state, separate from both an unanswered field and the respondent-selectable “not listed” answer. It must only be true after a successful lookup returns zero real related records; no parent, loading, failure, and missing configuration must not match.

**Why:** Persisting a synthetic value as the relationship answer sends a non-record ID into drafts, payment, validation, and downstream relationship lookups. It also makes request failures indistinguishable from authoritative empty results.

**How to apply:** Keep the real form value empty, track the confirmed state alongside its exact parent value, and expose a stable sentinel only to conditional evaluation. Strip it at draft boundaries and reject it at submission/payment relationship validation.