---
name: Conditional form transitions
description: Security and lifecycle rules for replacing one public form with another in place.
---

Treat an in-place form transition as a persisted conditional action, never as a browser-authorized target or post-submit redirect. The server must reload the source action and rule, re-evaluate it against submitted condition values, apply only persisted compatible mappings, and independently authorize the destination.

**Why:** The browser necessarily detects the condition for responsiveness, but trusting its destination, mappings, or condition definition would allow cross-tenant/access bypasses. Source-only context such as assignment tokens and draft resume tokens also becomes invalid after the active form changes.

**How to apply:** Load the destination through the normal public form loader so its schedule, access, survey snapshot, prefill, and branding rules remain authoritative. Scope assignment tokens and draft identities to the original form, make destination-prefill cache keys include the active slug, and bound/track visited forms to stop stale responses and cycles.