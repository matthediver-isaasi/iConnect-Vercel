---
name: Department relationship replacement
description: Safe replacement and rollback behavior for member-to-Department custom-object relationships.
---

Renewal affiliation editing must be a generic, opt-in FormBuilder capability, not a BNMS-specific special case. Derive scopes from configured relationship definitions and member ownership; preserve existing add-only forms.

**Why:** The owner explicitly required support across tenants when authorizing this work on 2 November 2026.

**How to apply:** Do not hardcode tenant IDs, department object IDs, field IDs or schedule names in the reconciliation engine. A tenant's renewal form is configuration layered on the shared capability.

For renewal affiliation edits, Not-listed organisations/departments go to administrator review. Renewal may continue, but existing affiliations remain unchanged pending approval; do not automatically create shared records.

**Why:** The owner selected “Save for administrator review” on 2 November 2026 after being told this preserves existing affiliations while renewal continues.

**How to apply:** Treat new-name answers as review evidence, not mutation authority. Keep the affiliation change together rather than applying a new organisation while its department is unresolved. This does not bypass normal payment or renewal eligibility checks.

Do not assume changing a member's primary Organisation automatically removes their Department links. The historical primary-only cleanup was deliberately superseded to preserve valid secondary-organisation affiliations. Renewal flows must explicitly distinguish retained, added and removed memberships, including secondary sites.

**Why:** A department can belong to a valid secondary affiliation even after the primary Organisation changes. The old primary-only assumption caused an incorrect renewal assessment; live verification on 2026-11-02 confirmed the replacement policy.

**How to apply:** Check the current graph-scope rules rather than relying on historical trigger behaviour. Archive relationship removals instead of hard-deleting them, preserve unchanged edge metadata, and coordinate organisation/secondary-affiliation/department replacement and recovery. Legacy targets may still have automatic cleanup, so snapshot old active edges before mutation and re-read state when compensating.