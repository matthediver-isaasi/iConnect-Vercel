---
name: Awards and judging policy
description: Owner-approved competition policy and initial release scope.
---

The owner approved the complete proposed contract in `docs/awards-judging-integration-contract.md` without changes on 2026-11-13. Its scoring, visibility, conflict, retention and release rules govern implementation.

**Why:** These choices affect fairness, confidential decisions and personal-data retention; they must not be silently changed as implementation shortcuts.

**How to apply:** Keep mandatory moderation, multiple rounds and event integration within the initial release. Blind judging hides peer assessments, not applicant identities automatically. Optional scoring policy must be selected explicitly; no missing answer becomes zero. Keep approval, publication and delivery as separate authorities. Tenant retention rules must be specified before live intake. Preserve existing engagement awards.

Review files require retained immutable bytes and assignment-authorised proxy downloads, not ordinary tenant file links.

**Why:** Tenant membership and possession of a storage URL do not prove a current judging assignment. Source uploads may also disappear or change after submission.

**How to apply:** Keep attachment evidence independent of mutable source uploads. Any later storage optimisation must preserve revocation checks on each new download and prevent generic storage routes from bypassing assignment authority.

The owner approved evidence-only amendments: save a new canonical submission and immutable review version, without repeating payments, member/contact creation, workflows or original submission emails. Judges adopt revisions only through an explicit administrator action.

**Why:** An amendment corrects review evidence; it is not a fresh purchase or permission to repeat the original form's business actions.

**How to apply:** Validate amended answers using the original form contract while separating validation from side-effect execution. Preserve the original submission and every earlier assessment; do not silently move assignments onto new evidence.

Evidence-only intake must exclude canonical database-trigger actions and recovery entry points, not merely skip the normal HTTP submission pipeline.

**Why:** Canonical submission inserts can independently allocate stock, queue alerts, complete membership actions and enqueue due diligence. A new submission row alone is not a side-effect-free operation.

**How to apply:** Any future form-trigger or recovery action must respect the server-owned amendment context. Preserve ordinary submissions' original predicates and behavior; test both paths.

Decision concurrency checks and approved-evidence fingerprints serve different purposes: concurrency includes the current decision, while retained approval evidence excludes that decision and non-scoring round metadata.

**Why:** Including a decision in its own evidence makes it stale immediately after saving. Excluding it from optimistic concurrency instead allows stale administrators to act on newer decisions.

**How to apply:** Preserve both boundaries when changing ranking, shortlisting, outcome approval or publication. Changed evidence must block fresh publication/delivery without ordinary deadline or display changes invalidating scores.

Automatic messaging must remain explicitly enabled and must not silently backfill older applicants or appointments.

**Why:** The approved scope excludes unrequested live-data backfills. Enabling a policy must not unexpectedly message historical recipients.

**How to apply:** Preserve an activation cutoff. Distinguish stopping automatic queue creation from blocking already queued delivery, and explain this distinction before administrators confirm policy changes.

Competition-management capabilities must inherit the existing administrative permission boundary; judging appointments alone never grant tenant management access.

**Why:** This project's permissions are exclusion-based. Adding an independent top-level administrative module could grant its new capabilities to ordinary member roles that already exclude administration.

**How to apply:** Keep competition capabilities nested under the administrative module in the canonical hierarchy, regenerate the server hierarchy, and test parent-level exclusion as well as individual capability exclusions.

Managed-reference display labels must be part of immutable review evidence, not live directory lookups performed for judges.

**Why:** Directory renames, deletion or visibility changes must not silently rewrite an assessment's historical meaning or widen the judge's directory access.

**How to apply:** Resolve permitted labels through canonical tenant-scoped services when creating a review version. Preserve existing display evidence for unchanged references during amendments.

Applicant amendment links grant no additional access to directory-backed choices.

**Why:** The owner explicitly approved “Existing access only”: new selections must be public or already accessible to the applicant, while private linked answers remain read-only.

**How to apply:** Reuse current ordinary form/session permissions for choice access independently of application-link authority. Enforce the boundary on writes as well as picker reads; never treat the link as a tenant session.
