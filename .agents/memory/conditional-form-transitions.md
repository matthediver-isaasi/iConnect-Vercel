---
name: Conditional form transitions
description: Security and lifecycle rules for replacing one public form with another in place.
---

Treat an in-place form transition as a persisted conditional action, never as a browser-authorized target or post-submit redirect. The server must reload the source action and rule, re-evaluate it against submitted condition values, apply only persisted compatible mappings, and independently authorize the destination.

**Why:** The browser necessarily detects the condition for responsiveness, but trusting its destination, mappings, or condition definition would allow cross-tenant/access bypasses. Source-only context such as assignment tokens and draft resume tokens also becomes invalid after the active form changes.

**How to apply:** Load the destination through the normal public form loader so its schedule, access, survey snapshot, prefill, and branding rules remain authoritative. Scope assignment tokens and draft identities to the original form, make destination-prefill cache keys include the active slug, and bound/track visited forms to stop stale responses and cycles.

When Back restores a source form, attribute the transition to explicit respondent field-change metadata, not only an answer-snapshot diff. Retain that attribution through later automatic/default/prefill updates until the transition commits; for OR rules, clear only branches that currently contribute to the match.

**Why:** React can batch several answer updates, and a user choice can be followed by an automatic update that completes an AND/OR rule. Snapshot order alone can clear an unrelated prefilled field or a nonmatching OR branch.

**How to apply:** Carry a form-scoped monotonic user-edit revision into the transition lifecycle. Prefer that field when it contributes to the matched rule, fall back to changed matching conditions, and preserve all unrelated answers and non-JSON values.