---
name: Campaign removal policy
description: Owner-requested boundary between retention operations and delivery intervention.
---

Campaign removal must not automatically cancel, reconcile or call the provider.
Keep Archive independent of delivery status and historical reporting definitions.

**Why:** The owner explicitly scoped archive/delete as a retention choice, not
delivery management, and required users to stop/reconcile unresolved work first.
A convenient removal action must not silently change delivery intent.

**How to apply:** Future recovery or retention tooling should require separate,
explicit delivery reconciliation authority rather than treating an archive or
delete request as permission to intervene in sending.

Assess delete cost against global child-history volume, not just the selected
campaign's recipient count; source migrations do not prove live FK indexes exist.

**Why:** Live read-only investigation found missing per-recipient history indexes
despite their declaration in the original migration, making a tiny campaign scan
the entire history table repeatedly.

**How to apply:** Inspect installed indexes and read-only lookup plans first;
reproduce destructive timing only in an isolated database with unrelated history.
