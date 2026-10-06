---
name: Login landing verification
description: Keep contextual return tests distinct from plain login and tenant demo policy.
---

Pin an explicit non-demo tenant in isolated role-landing browser fixtures.

**Why:** This workspace's development default can activate the intentional GSF
MemberDemo override, making a correct role-resolution test appear to redirect to
the wrong page. This required separating environment policy from the regression.

**How to apply:** Keep a dedicated demo-policy case separate from ordinary
role-landing tests. Treat header sign-in, existing-session Member Area, contextual
returnTo, and in-place event completion as separate entry paths. Fixture evidence
does not establish the cause of a specific live account report.

Tenant authority in authenticated login responses must include the existing
organisation-derived tenant path, not only the member's direct CRM tenant value.

**Why:** Valid legacy members can have an assigned tenant-owned role while their
direct tenant field is null. Comparing that role solely to the direct field
breaks password and existing-session landing without improving isolation.

**How to apply:** Reuse authenticated server-side tenant resolution and require
the current organisation tenant to agree with the session for role projections;
never infer tenancy from the role being validated or from browser storage.
