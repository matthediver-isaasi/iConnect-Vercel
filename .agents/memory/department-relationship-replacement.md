---
name: Department relationship replacement
description: Safe replacement and rollback behavior for member-to-Department custom-object relationships.
---

Do not assume changing a member's primary Organisation automatically removes their Department links. The historical primary-only cleanup was deliberately superseded to preserve valid secondary-organisation affiliations. Renewal flows must explicitly distinguish retained, added and removed memberships, including secondary sites.

**Why:** A department can belong to a valid secondary affiliation even after the primary Organisation changes. The old primary-only assumption caused an incorrect renewal assessment; live verification on 2026-11-02 confirmed the replacement policy.

**How to apply:** Check the current graph-scope rules rather than relying on historical trigger behaviour. Archive relationship removals instead of hard-deleting them, preserve unchanged edge metadata, and coordinate organisation/secondary-affiliation/department replacement and recovery. Legacy targets may still have automatic cleanup, so snapshot old active edges before mutation and re-read state when compensating.