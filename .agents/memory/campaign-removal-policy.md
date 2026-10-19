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
