---
name: Auto Archive policy boundaries
description: Product constraints from the Auto Archive brief and the owner's RBAC reuse requirement.
---

Auto Archive must be tenant-configurable rather than hardcoded for BNMS. Permanent deletion must remain manual and require administrator approval; scheduled processing must never perform it.

**Why:** These are explicit constraints in the owner's Auto Archive brief, not inferred permissions to dispose of existing records.

**How to apply:** Reuse established membership evidence and Role Management controls. Treat lifecycle transitions, access revocation, personal-data minimisation and deletion as distinct operations. The brief review did not authorise implementation, live processing or a particular retention/legal policy.

Reuse as much existing RBAC control as possible rather than introducing a separate archive permission system.

**Why:** The owner explicitly requested RBAC reuse when asking for the pre-build review.

**How to apply:** Integrate any necessary new capabilities into the existing role hierarchy and server enforcement, with deliberate default exclusions for sensitive actions.

Archive first; require a later authorised review before irreversible personal-data minimisation. Do not minimise personal data automatically at the point of archiving.

**Why:** The owner explicitly selected “Archive, then review minimisation” during policy clarification.

**How to apply:** Keep archival and minimisation as separate actions and permissions. Review timing, retained fields and deletion eligibility still need agreement; this choice does not authorise live processing.

Archived former members become eligible for manual deletion review after a tenant-configurable retention period.

**Why:** The owner explicitly selected review after configurable retention rather than indefinite retention or permanent ineligibility.

**How to apply:** Review eligibility must never itself delete or minimise data. Preserve financial and other retention blockers. The initial BNMS duration and retention clock require separate agreement.
