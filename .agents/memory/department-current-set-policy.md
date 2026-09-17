---
name: Department current-set policy
description: Current workforce/equipment editing policy and existing missing equipment values.
---

Department workforce and equipment maintain current sets, not annual returns. Workforce rows and Equipment Register records belong directly to a Department; the redundant Workforce Survey parent is retired. Do not introduce annual snapshots or run the separately prepared workforce import as a prerequisite.

**Why:** The user explicitly replaced the annual-return design with current-data maintenance, then requested removing the now-unnecessary survey parent. The prepared import has independent review and approval requirements.

**How to apply:** Preserve existing workforce row identity and provenance; require one Department per row. The prepared form rollout and import still assume survey parents and must be adapted and re-audited before any separately approved execution. Never restore the parent model merely to make their old preflight pass.

Existing equipment may retain previously missing serial numbers and installation years; new equipment must supply both.

**Why:** The user explicitly approved this exception because required form fields conflict with missing values in existing equipment.

**How to apply:** Bind any required-field exception to the authoritative existing record and its unchanged missing value. A submitted row identifier alone never proves eligibility for the exception.

Current-set graph writes use a configured-tenant transaction boundary, while concurrency versions remain Department-specific.

**Why:** Resolving a Department through mutable relationships before acquiring a Department-only lock leaves re-parenting and respondent-link revocation races. Briefly serializing the configured tenant is an intentional safety tradeoff; unrelated Departments must not invalidate each other's versions.

**How to apply:** Preserve coordination with ordinary Data Studio and metadata writes. Any narrower locking replacement must protect both old and new ownership, shared catalogues, and authorization changes—not only the form-save function.

Treat conditional child values separately from whole-section completeness.

**Why:** The existing form legitimately hides the optional decommissioning year while equipment is in service. Rejecting every conditional child breaks that form, but trusting a hidden submitted value can erase existing data.

**How to apply:** Review and pin supported child-visibility rules, then preserve authoritative existing hidden values inside the transaction (and omit new hidden values). Never infer section removal from hidden or missing answers.