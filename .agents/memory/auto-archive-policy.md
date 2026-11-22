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

**How to apply:** Keep archival and minimisation as separate actions and permissions. Minimisation review timing still needs agreement; this choice does not authorise live processing.

Archived former members become eligible for manual deletion review after a tenant-configurable retention period.

**Why:** The owner explicitly selected review after configurable retention rather than indefinite retention or permanent ineligibility.

**How to apply:** Review eligibility must never itself delete or minimise data. Preserve financial and other retention blockers. For BNMS, the owner selected one year after archiving before entry into deletion review; other tenants can configure their own period.

BNMS qualifying retention activity includes recorded event attendance, earned CPD activity and member portal logins. Event-only CPD Guests retain the brief's attendance-only exception.

**Why:** The owner explicitly selected all three activity types, including portal logins, when clarifying the retention policy.

**How to apply:** Use actual activity dates rather than entry/import dates; administrator edits do not reset retention. Do not apply the earlier recommendation to exclude portal logins. This selection does not resolve missing-history handling or authorise archived-account logins.

Uncertain historical membership or missing reliable activity dates must hold the record for administrator review rather than trigger an assumed lifecycle transition.

**Why:** The owner explicitly selected “Hold for review” for uncertain history.

**How to apply:** Leave the record unchanged by automatic lifecycle processing while uncertainty remains. Do not infer “never a member” from missing membership rows or infer inactivity from missing dates. This is an evidence-review hold, not approval for deletion.

Permanent deletion requires one authorised administrator, not a two-person request/approval workflow.

**Why:** The owner explicitly selected “One authorised administrator” during approval-policy clarification.

**How to apply:** Require the dedicated permission through existing Role Management plus explicit confirmation. This does not bypass retention, billing or evidence-review blockers, and scheduled processing must never delete.

After approved minimisation, keep the internal member ID, lifecycle dates and audit references. Preserve separately protected historical and financial records under their applicable retention rules. Remove names and contact/profile information from the member record unless a documented retention requirement applies.

**Why:** The owner explicitly accepted this retained-information baseline, having been informed that ordinary duplicate matching by the former email address would not be preserved.

**How to apply:** Translate this baseline into an explicit field-by-field policy before destructive implementation. It applies to authorised minimisation, not ordinary archiving, and does not establish legal retention durations or authorise erasing protected related records.

Lifecycle transitions must use dynamically configured existing tenant roles. Never hardcode role names or role IDs, including the BNMS examples “Former Member” and “CPD Guest”.

**Why:** The owner selected configured existing destination roles and explicitly reiterated that every tenant will have its own roles and the feature must be dynamic.

**How to apply:** Treat lifecycle states and tenant role mappings as separate concepts. Resolve configured role IDs within the record's tenant; do not select by a hardcoded name, create standard roles implicitly, or use a different tenant's role. Preserve purchased membership history and separate team-administrator access.

Lifecycle evidence versions alone are not enough to authorise a destructive write.

**Why:** A source writer can start before validation and commit afterwards; a schema change can also introduce personal data without a row-write event. The initial safety choice is coarse source-generation/schema stamps plus short, non-waiting final relation locks.

**How to apply:** Preserve the shared concurrency boundary when improving throughput. Busy sources must cause a retry, not an unlocked fallback. Do not claim historical login coverage merely because the schema is installed; all serving login producers must be deployed and historical gaps reviewed.

The latest purchased membership cycle governs former-member retention, even if an older lifecycle state still says guest.

**Why:** Renewing a previously downgraded guest must not let an old inactivity clock bypass the new term's grace and retention period. Similarly, a confirmed past booking or a queued invoice is not settlement evidence.

**How to apply:** Reconcile classification against current roles and latest entitlement dates before inactivity rules. Require payment/refund evidence for chargeable booking history; hold when that evidence is absent rather than treating an old event as financially complete.
