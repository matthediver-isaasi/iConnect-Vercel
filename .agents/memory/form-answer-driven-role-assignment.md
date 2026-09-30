---
name: Form answer-driven role assignment
description: Security and lifecycle rules for assigning newly created member roles from submitted form answers.
---

An answer-driven member role must resolve through a persisted answer-to-role mapping. Never interpret the submitted answer itself as a role ID. Validate mapped and fallback roles against the form tenant when saving and again before member creation.

**Why:** Tenant scoping alone does not prevent same-tenant privilege escalation. A user who can edit an ordinary form must not be able to configure it to create administrators unless they also have Member Role Assignment authority.

**How to apply:** Gate answer-driven role configuration at every Form write boundary, use authoritative persisted form/submission data at processing time, reject non-scalar answers, and apply the resolved role only to newly created members. Existing-member updates keep their current role while this mode is active.